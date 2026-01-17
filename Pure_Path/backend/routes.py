from fastapi import APIRouter, Query
import requests
import math
import time
import asyncio
from typing import Optional, List, Dict, Any, Tuple

router = APIRouter()

# =========================
# CONFIG
# =========================
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
PHOTON_URL = "https://photon.komoot.io/api"

# Public OSRM (slow sometimes) - later you can replace with local OSRM
OSRM_ROUTE_URL = "http://router.project-osrm.org/route/v1/driving"

USER_AGENT = "PurePath/1.0 (Educational Project)"

MAX_SAMPLE_POINTS = 6
MAX_ALTERNATIVES_TO_RETURN = 3

# cache TTL seconds
GEOCODE_TTL = 24 * 3600
OSRM_TTL = 15 * 60
AQI_TTL = 30 * 60


# =========================
# SIMPLE IN-MEMORY CACHES
# key -> (expiry_ts, value)
# =========================
_geocode_cache: Dict[str, Tuple[float, Any]] = {}
_osrm_cache: Dict[str, Tuple[float, Any]] = {}
_aqi_cache: Dict[str, Tuple[float, Any]] = {}


def cache_get(cache: dict, key: str):
    item = cache.get(key)
    if not item:
        return None
    exp, val = item
    if time.time() > exp:
        try:
            del cache[key]
        except:
            pass
        return None
    return val


def cache_set(cache: dict, key: str, ttl: int, val: Any):
    cache[key] = (time.time() + ttl, val)


# =========================
# AQI COLOR MAP
# =========================
def aqi_to_color(aqi: Optional[float]) -> str:
    if aqi is None:
        return "gray"
    aqi = float(aqi)

    if aqi <= 50:
        return "green"
    elif aqi <= 100:
        return "yellow"
    elif aqi <= 150:
        return "orange"
    elif aqi <= 200:
        return "blue"
    else:
        return "red"


# =========================
# ROUTE RANKING (BEST 3)
# =========================
def rank_routes_best(routes_out: List[Dict[str, Any]], limit: int = 3) -> List[Dict[str, Any]]:
    """
    Rank routes using a combined score:
    score = 0.65 * time_ratio + 0.35 * aqi_ratio
    If AQI missing -> time only.
    """
    if not routes_out:
        return []

    durations = [r.get("duration_s") for r in routes_out if r.get("duration_s") is not None]
    min_duration = min(durations) if durations else 1

    aqis = [r.get("avg_aqi") for r in routes_out if r.get("avg_aqi") is not None]
    min_aqi = min(aqis) if aqis else None

    scored = []
    for r in routes_out:
        duration = float(r.get("duration_s") or 0)
        time_ratio = duration / min_duration if min_duration else 999

        avg_aqi = r.get("avg_aqi")
        if avg_aqi is None or min_aqi is None:
            score = time_ratio
        else:
            aqi_ratio = float(avg_aqi) / min_aqi if min_aqi else 999
            score = 0.65 * time_ratio + 0.35 * aqi_ratio

        scored.append((score, r))

    scored.sort(key=lambda x: x[0])
    return [x[1] for x in scored[:limit]]


# =========================
# GEOCODING (CACHED + NOMINATIM + PHOTON FALLBACK)
# =========================
def geocode_place(place: str):
    """
    Supports:
    - "Delhi" (Nominatim / Photon fallback)
    - "lat,lng" direct input
    """
    place = place.strip()

    # direct lat,lng
    if "," in place:
        parts = place.split(",")
        if len(parts) == 2:
            try:
                lat = float(parts[0].strip())
                lon = float(parts[1].strip())
                return lat, lon
            except:
                pass

    key = place.lower()
    cached = cache_get(_geocode_cache, key)
    if cached:
        return cached

    # ---------- 1) Try NOMINATIM ----------
    try:
        params = {"q": place, "format": "json", "limit": 1}
        headers = {
            "User-Agent": USER_AGENT,
            "Referer": "http://localhost",
            "Accept-Language": "en",
        }

        r = requests.get(NOMINATIM_URL, params=params, headers=headers, timeout=10)

        if r.status_code == 200:
            data = r.json()
            if data:
                lat = float(data[0]["lat"])
                lon = float(data[0]["lon"])
                cache_set(_geocode_cache, key, GEOCODE_TTL, (lat, lon))
                return lat, lon
    except:
        pass

    # ---------- 2) Fallback: PHOTON ----------
    try:
        params = {"q": place, "limit": 1}
        headers = {"User-Agent": USER_AGENT}

        r = requests.get(PHOTON_URL, params=params, headers=headers, timeout=10)
        if r.status_code != 200:
            return None

        data = r.json()
        features = data.get("features", [])
        if not features:
            return None

        coords = features[0]["geometry"]["coordinates"]  # [lon,lat]
        lon = float(coords[0])
        lat = float(coords[1])

        cache_set(_geocode_cache, key, GEOCODE_TTL, (lat, lon))
        return lat, lon
    except:
        return None


# =========================
# ROUTE HELPERS
# =========================
def sample_points_along_route(coords: List[List[float]], max_points: int = 6):
    """
    coords from OSRM geojson: [[lon,lat], [lon,lat], ...]
    """
    if not coords:
        return []

    if len(coords) <= max_points:
        return coords

    step = max(1, len(coords) // max_points)
    sampled = coords[::step]

    if sampled[-1] != coords[-1]:
        sampled.append(coords[-1])

    return sampled[:max_points]


# =========================
# AQI (CACHED + ASYNC + PARALLEL)
# =========================
def get_aqi_for_point_sync(lat: float, lon: float) -> Optional[float]:
    """
    Replace this with:
    - WAQI API call
    - or your ML/LSTM prediction
    """
    # Dummy AQI for testing (fast)
    return 60 + (abs(lat) % 50)


async def get_aqi_for_point(lat: float, lon: float) -> Optional[float]:
    key = f"{lat:.4f},{lon:.4f}"
    cached = cache_get(_aqi_cache, key)
    if cached is not None:
        return cached

    aqi = await asyncio.to_thread(get_aqi_for_point_sync, lat, lon)
    cache_set(_aqi_cache, key, AQI_TTL, aqi)
    return aqi


async def aggregate_route_aqi_async(coords_lonlat: List[List[float]]) -> Optional[float]:
    sampled = sample_points_along_route(coords_lonlat, MAX_SAMPLE_POINTS)
    if not sampled:
        return None

    tasks = []
    for lon, lat in sampled:
        tasks.append(get_aqi_for_point(lat, lon))

    values = await asyncio.gather(*tasks)
    values = [float(v) for v in values if v is not None]

    if not values:
        return None

    return sum(values) / len(values)


# =========================
# OSRM ROUTES (CACHED + simplified + better alternatives)
# =========================
def osrm_get_routes_cached(
    start_lat, start_lon,
    end_lat, end_lon,
    alternatives=True,
    steps=True
):
    coords = f"{start_lon},{start_lat};{end_lon},{end_lat}"

    params = {
        "overview": "simplified",  # ✅ faster
        "geometries": "geojson",
        "alternatives": "true" if alternatives else "false",
        "steps": "true" if steps else "false",

        # ✅ Helps OSRM generate more alternate paths
        "continue_straight": "false",
    }

    cache_key = f"{coords}|{params['overview']}|alt={params['alternatives']}|steps={params['steps']}|cs={params['continue_straight']}"
    cached = cache_get(_osrm_cache, cache_key)
    if cached:
        return cached

    url = f"{OSRM_ROUTE_URL}/{coords}"
    r = requests.get(url, params=params, timeout=15)
    r.raise_for_status()
    data = r.json()

    if data.get("code") != "Ok":
        return []

    routes = data.get("routes", [])
    cache_set(_osrm_cache, cache_key, OSRM_TTL, routes)
    return routes


def build_turn_by_turn_steps(osrm_route: Dict[str, Any]) -> List[Dict[str, Any]]:
    steps_out = []
    legs = osrm_route.get("legs", [])
    if not legs:
        return steps_out

    for leg in legs:
        for step in leg.get("steps", []):
            maneuver = step.get("maneuver", {})
            name = step.get("name", "") or ""
            distance = step.get("distance", 0.0) or 0.0
            duration = step.get("duration", 0.0) or 0.0

            m_type = maneuver.get("type", "")
            modifier = maneuver.get("modifier", "")
            loc = maneuver.get("location", None)  # [lon,lat]

            if m_type == "depart":
                text = "Start moving"
            elif m_type == "arrive":
                text = "You have arrived at your destination"
            else:
                base = "Continue"
                if m_type == "turn":
                    base = "Turn"
                elif m_type == "merge":
                    base = "Merge"
                elif m_type == "roundabout":
                    base = "Enter the roundabout"

                if modifier:
                    text = f"{base} {modifier}"
                else:
                    text = base

                if name.strip():
                    text += f" onto {name}"

            steps_out.append({
                "text": text,
                "distance_m": round(distance, 1),
                "duration_s": round(duration, 1),
                "location": loc
            })

    return steps_out


# =========================
# 1) FAST ROUTES (instant, best 3 by time)
# =========================
@router.get("/navigate_fast")
def navigate_fast(
    start: str = Query(...),
    end: str = Query(...)
):
    start_geo = geocode_place(start)
    if not start_geo:
        return {"error": "Start location not found", "routes": []}

    end_geo = geocode_place(end)
    if not end_geo:
        return {"error": "End location not found", "routes": []}

    start_lat, start_lon = start_geo
    end_lat, end_lon = end_geo

    osrm_routes = osrm_get_routes_cached(
        start_lat, start_lon, end_lat, end_lon,
        alternatives=True, steps=True
    )

    # DEBUG: you can see count in terminal
    # print("OSRM routes count:", len(osrm_routes))

    if not osrm_routes:
        return {"routes": []}

    routes_out = []
    for r in osrm_routes:
        geometry = r.get("geometry", {})
        coords_lonlat = geometry.get("coordinates", [])

        routes_out.append({
            "distance_m": round(r.get("distance", 0), 1),
            "duration_s": round(r.get("duration", 0), 1),
            "avg_aqi": None,
            "aqi_color": "gray",
            "geometry": {"type": "LineString", "coordinates": coords_lonlat},
            "steps": build_turn_by_turn_steps(r),
        })

    # Best 3 by time (AQI not computed yet)
    routes_out.sort(key=lambda x: x["duration_s"])
    routes_out = routes_out[:MAX_ALTERNATIVES_TO_RETURN]

    return {
        "start": {"lat": start_lat, "lon": start_lon},
        "end": {"lat": end_lat, "lon": end_lon},
        "recommended_index": 0,
        "routes": routes_out
    }


# =========================
# 2) AQI UPDATE (compute AQI + re-rank best 3)
# =========================
@router.post("/aqi_for_routes")
async def aqi_for_routes(payload: Dict[str, Any]):
    """
    payload:
    {
      "routes": [
        { "geometry": { "coordinates": [[lon,lat], ...] }, "duration_s": 123, "distance_m": 999 },
        ...
      ]
    }
    """
    routes = payload.get("routes", [])
    if not routes:
        return {"recommended_index": 0, "routes": []}

    # compute AQI for each route in parallel
    tasks = []
    for r in routes:
        coords = r.get("geometry", {}).get("coordinates", [])
        tasks.append(aggregate_route_aqi_async(coords))

    aqi_values = await asyncio.gather(*tasks)

    enriched = []
    for i, r in enumerate(routes):
        avg_aqi = aqi_values[i]
        enriched.append({
            **r,
            "avg_aqi": None if avg_aqi is None else round(avg_aqi, 2),
            "aqi_color": aqi_to_color(avg_aqi)
        })

    # re-rank by combined score (time + AQI)
    best3 = rank_routes_best(enriched, limit=MAX_ALTERNATIVES_TO_RETURN)

    return {
        "recommended_index": 0,
        "routes": best3
    }


# =========================
# 3) FULL /navigate (slower, full AQI already ranked)
# =========================
@router.get("/navigate")
async def navigate(
    start: str = Query(...),
    end: str = Query(...)
):
    start_geo = geocode_place(start)
    if not start_geo:
        return {"error": "Start location not found", "routes": []}

    end_geo = geocode_place(end)
    if not end_geo:
        return {"error": "End location not found", "routes": []}

    start_lat, start_lon = start_geo
    end_lat, end_lon = end_geo

    osrm_routes = osrm_get_routes_cached(
        start_lat, start_lon, end_lat, end_lon,
        alternatives=True, steps=True
    )
    if not osrm_routes:
        return {"routes": []}

    # compute AQI for all routes in parallel
    tasks = []
    temp_routes = []

    for r in osrm_routes:
        geometry = r.get("geometry", {})
        coords_lonlat = geometry.get("coordinates", [])

        temp_routes.append({
            "distance_m": round(r.get("distance", 0), 1),
            "duration_s": round(r.get("duration", 0), 1),
            "geometry": {"type": "LineString", "coordinates": coords_lonlat},
            "steps": build_turn_by_turn_steps(r),
        })

        tasks.append(aggregate_route_aqi_async(coords_lonlat))

    aqi_values = await asyncio.gather(*tasks)

    routes_out = []
    for i, rr in enumerate(temp_routes):
        avg_aqi = aqi_values[i]
        routes_out.append({
            **rr,
            "avg_aqi": None if avg_aqi is None else round(avg_aqi, 2),
            "aqi_color": aqi_to_color(avg_aqi),
        })

    # Rank best 3 (time + AQI)
    routes_out = rank_routes_best(routes_out, limit=MAX_ALTERNATIVES_TO_RETURN)

    return {
        "start": {"lat": start_lat, "lon": start_lon},
        "end": {"lat": end_lat, "lon": end_lon},
        "recommended_index": 0,
        "routes": routes_out
    }
