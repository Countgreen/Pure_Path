import requests
from aqi_utils import aqi_to_color

WAQI_TOKEN = "ec747ba88a4fb58c4ab82f024368751c07008494"
WAQI_GEO_URL = "https://api.waqi.info/feed/geo:{lat};{lon}/"


def sample_points_from_route(coords, samples=6):
    if not coords or len(coords) < 2:
        return []

    step = max(1, len(coords) // samples)
    sampled = coords[::step]

    if sampled and sampled[-1] != coords[-1]:
        sampled.append(coords[-1])

    return sampled[:samples]


def fetch_aqi_for_point_waqi(lon, lat):
    try:
        url = WAQI_GEO_URL.format(lat=lat, lon=lon)
        params = {"token": WAQI_TOKEN}

        res = requests.get(url, params=params, timeout=10)
        res.raise_for_status()
        data = res.json()

        if data.get("status") != "ok":
            return None

        aqi = data.get("data", {}).get("aqi", None)

        if aqi is None or aqi == "-" or aqi == "":
            return None

        return float(aqi)

    except Exception:
        return None


def attach_aqi_to_routes(routes):
    """
    Adds:
    - aqi (avg_aqi)
    - max_aqi
    - color, color_name based on max_aqi (safer)
    """
    for r in routes:
        coords = r["geometry"]["coordinates"]
        sampled_points = sample_points_from_route(coords, samples=6)

        aqi_values = []

        for lon, lat in sampled_points:
            aqi = fetch_aqi_for_point_waqi(lon, lat)
            if aqi is not None:
                aqi_values.append(aqi)

        avg_aqi = sum(aqi_values) / len(aqi_values) if aqi_values else None
        max_aqi = max(aqi_values) if aqi_values else None

        # Safer color mapping: use max_aqi if available
        color, color_name = aqi_to_color(max_aqi if max_aqi is not None else avg_aqi)

        r["aqi"] = avg_aqi
        r["max_aqi"] = max_aqi
        r["color"] = color
        r["color_name"] = color_name
        r["samples_used"] = len(aqi_values)

    return routes