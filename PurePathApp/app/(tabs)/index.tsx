import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Keyboard,
  Platform,
  ScrollView,
  Switch,
} from "react-native";
import MapView, {
  Marker,
  Polyline,
  PROVIDER_GOOGLE,
  Region,
} from "react-native-maps";
import * as Location from "expo-location";
import * as Speech from "expo-speech";

const BACKEND_IP = "10.20.51.131";
const BACKEND_PORT = "8000";
const API_BASE = `http://${BACKEND_IP}:${BACKEND_PORT}`;

const OSRM_ROUTE_URL = "http://router.project-osrm.org/route/v1/driving";
const OSRM_NEAREST_URL = "http://router.project-osrm.org/nearest/v1/driving";
const PHOTON_URL = "https://photon.komoot.io/api";

type StepObj = {
  text: string;
  distance_m: number;
  duration_s: number;
  location?: [number, number]; // [lon,lat]
};

type RouteObj = {
  distance_m: number;
  duration_s: number;
  geometry: { type: string; coordinates: [number, number][] };
  avg_aqi?: number | null;
  aqi_color?: string; // green/yellow/orange/blue/red/gray
  steps?: StepObj[];
};

type Suggestion = {
  label: string;
  lat: number;
  lon: number;
};

function metersToKm(m: number) {
  return (m / 1000).toFixed(1);
}
function secondsToMin(s: number) {
  return Math.max(1, Math.round(s / 60));
}

function clampAngleDiff(a: number) {
  let x = ((a + 180) % 360) - 180;
  if (x < -180) x += 360;
  return x;
}

function smoothHeading(prev: number, next: number, alpha = 0.18) {
  if (prev === null || prev === undefined) return next;
  const diff = clampAngleDiff(next - prev);
  return (prev + diff * alpha + 360) % 360;
}

function distanceMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
) {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat); // ✅ FIXED

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

function closestDistanceToRouteMeters(
  user: { lat: number; lon: number },
  routeCoords: [number, number][]
) {
  let minD = Infinity;
  for (let i = 0; i < routeCoords.length; i++) {
    const lon = routeCoords[i][0];
    const lat = routeCoords[i][1];
    const d = distanceMeters(user, { lat, lon });
    if (d < minD) minD = d;
  }
  return minD;
}

function closestIndexOnRoute(
  user: { lat: number; lon: number },
  routeCoords: [number, number][]
) {
  let minD = Infinity;
  let bestIdx = 0;

  for (let i = 0; i < routeCoords.length; i++) {
    const lon = routeCoords[i][0];
    const lat = routeCoords[i][1];
    const d = distanceMeters(user, { lat, lon });
    if (d < minD) {
      minD = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function remainingDistanceMetersFromIndex(
  routeCoords: [number, number][],
  startIdx: number
) {
  let dist = 0;
  for (let i = startIdx; i < routeCoords.length - 1; i++) {
    const a = { lon: routeCoords[i][0], lat: routeCoords[i][1] };
    const b = { lon: routeCoords[i + 1][0], lat: routeCoords[i + 1][1] };
    dist += distanceMeters(
      { lat: a.lat, lon: a.lon },
      { lat: b.lat, lon: b.lon }
    );
  }
  return dist;
}

function colorFromAQIName(name?: string) {
  switch (name) {
    case "green":
      return "#22c55e";
    case "yellow":
      return "#eab308";
    case "orange":
      return "#f97316";
    case "blue":
      return "#3b82f6";
    case "red":
      return "#ef4444";
    case "gray":
    default:
      return "#94a3b8";
  }
}

// ============================
// HEALTH RISK BADGE + SENSITIVE MODE + VOICE MESSAGE
// ============================
function getHealthRiskFromAQI(
  aqi: number | null | undefined,
  sensitive: boolean
) {
  if (aqi === null || aqi === undefined || Number.isNaN(aqi)) {
    return {
      levelKey: "unknown",
      label: "Risk: Unknown",
      sub: "AQI not available",
      bg: "#e5e7eb",
      text: "#111827",
      icon: "❓",
      speak: "",
    };
  }

  // Sensitive Mode => stricter cutoffs
  const t1 = sensitive ? 35 : 50;
  const t2 = sensitive ? 75 : 100;
  const t3 = sensitive ? 120 : 150;
  const t4 = sensitive ? 170 : 200;

  // IMPORTANT: Speak EXACT lines user asked
  if (aqi <= t1) {
    return {
      levelKey: "low",
      label: "Risk: Low",
      sub: sensitive ? "Safe (sensitive mode)" : "Safe to travel",
      bg: "#dcfce7",
      text: "#065f46",
      icon: "🟢",
      speak: "Air quality is good. Safe to travel.",
    };
  }
  if (aqi <= t2) {
    return {
      levelKey: "moderate",
      label: "Risk: Moderate",
      sub: sensitive ? "Mask recommended" : "Sensitive people take care",
      bg: "#fef9c3",
      text: "#854d0e",
      icon: "🟡",
      speak: "Air quality is moderate. Sensitive people should take care.",
    };
  }
  if (aqi <= t3) {
    return {
      levelKey: "high",
      label: "Risk: High",
      sub: sensitive ? "Avoid outdoor travel" : "Wear mask if possible",
      bg: "#ffedd5",
      text: "#9a3412",
      icon: "🟠",
      speak: "Unhealthy air. Wear a mask and reduce outdoor exposure.",
    };
  }
  if (aqi <= t4) {
    return {
      levelKey: "very_high",
      label: "Risk: Very High",
      sub: "Avoid long exposure",
      bg: "#dbeafe",
      text: "#1e3a8a",
      icon: "🔵",
      speak: "Very unhealthy air. Avoid outdoor activity if possible.",
    };
  }
  return {
    levelKey: "severe",
    label: "Risk: Severe",
    sub: "Avoid travel unless urgent",
    bg: "#fee2e2",
    text: "#7f1d1d",
    icon: "🔴",
    speak: "Hazardous air. Avoid travel unless urgent.",
  };
}

// ============================
// APP-SIDE CACHES
// ============================
const geocodeCache = new Map<string, { lat: number; lon: number }>();
const osrmRouteCache = new Map<string, any>();
const photonSuggestCache = new Map<string, Suggestion[]>();
const nearestCache = new Map<string, { lat: number; lon: number }>();

function makeOsrmCacheKey(
  startLon: number,
  startLat: number,
  endLon: number,
  endLat: number,
  steps: boolean,
  overview: "simplified" | "full"
) {
  const r = (x: number) => x.toFixed(5);
  return `${r(startLon)},${r(startLat)}|${r(endLon)},${r(endLat)}|steps=${steps}|overview=${overview}`;
}

function makeNearestKey(lon: number, lat: number) {
  return `${lon.toFixed(5)},${lat.toFixed(5)}`;
}

async function snapToRoad(lat: number, lon: number) {
  const key = makeNearestKey(lon, lat);
  if (nearestCache.has(key)) return nearestCache.get(key)!;

  const url = `${OSRM_NEAREST_URL}/${lon},${lat}?number=1`;
  const res = await fetch(url);
  if (!res.ok) return { lat, lon };

  const data = await res.json();
  const wp = data?.waypoints?.[0];
  const loc = wp?.location;

  if (!loc || loc.length < 2) return { lat, lon };

  const snapped = { lon: loc[0], lat: loc[1] };
  nearestCache.set(key, snapped);
  return snapped;
}

async function geocodePlaceFast(place: string) {
  const key = place.trim().toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key)!;

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
    place.trim()
  )}&format=json&limit=1`;

  const res = await fetch(url, {
    headers: { "User-Agent": "PurePath/1.0 (Educational Project)" },
  });

  if (!res.ok) throw new Error("Geocode failed");
  const data = await res.json();
  if (!data || data.length === 0) throw new Error("No geocode result");

  const lat = parseFloat(data[0].lat);
  const lon = parseFloat(data[0].lon);

  const val = { lat, lon };
  geocodeCache.set(key, val);
  return val;
}

function extractStepsFromOSRMRoute(r: any): StepObj[] {
  try {
    const legs = r.legs || [];
    const out: StepObj[] = [];
    legs.forEach((leg: any) => {
      (leg.steps || []).forEach((s: any) => {
        const m = s.maneuver || {};
        const name = s.name || "";
        const type = m.type || "";
        const mod = m.modifier || "";
        const loc = m.location || undefined;

        let text = "Continue";
        if (type === "depart") text = "Start moving";
        else if (type === "arrive") text = "You have arrived";
        else {
          if (type === "turn") text = "Turn";
          else if (type === "merge") text = "Merge";
          else if (type === "roundabout") text = "Enter roundabout";

          if (mod) text += ` ${mod}`;
          if (name) text += ` onto ${name}`;
        }

        out.push({
          text: text.trim(),
          distance_m: s.distance || 0,
          duration_s: s.duration || 0,
          location: loc,
        });
      });
    });
    return out;
  } catch {
    return [];
  }
}

function buildSuggestionLabel(props: any) {
  const name = props?.name || "";
  const city = props?.city || props?.town || props?.village || "";
  const state = props?.state || "";
  const country = props?.country || "";
  const parts = [name, city, state, country].filter(Boolean);
  return parts.join(", ");
}

async function fetchPhotonSuggestions(query: string): Promise<Suggestion[]> {
  const key = query.trim().toLowerCase();
  if (photonSuggestCache.has(key)) return photonSuggestCache.get(key)!;

  const url = `${PHOTON_URL}?q=${encodeURIComponent(
    query.trim()
  )}&limit=6&lang=en`;

  const res = await fetch(url, {
    headers: { "User-Agent": "PurePath/1.0 (Educational Project)" },
  });

  if (!res.ok) return [];

  const data = await res.json();
  const features = data?.features || [];
  const out: Suggestion[] = features.map((f: any) => {
    const coords = f?.geometry?.coordinates || [0, 0];
    const lon = coords[0];
    const lat = coords[1];
    const label = buildSuggestionLabel(f?.properties) || "Unknown place";
    return { label, lat, lon };
  });

  photonSuggestCache.set(key, out);
  return out;
}

export default function HomeScreen() {
  const mapRef = useRef<MapView | null>(null);

  const [permissionGranted, setPermissionGranted] = useState(false);

  const [currentLat, setCurrentLat] = useState<number | null>(null);
  const [currentLon, setCurrentLon] = useState<number | null>(null);

  const [destinationText, setDestinationText] = useState("");
  const [manualStartText, setManualStartText] = useState("");
  const [useManualStart, setUseManualStart] = useState(false);

  const [selectedDest, setSelectedDest] = useState<{
    lat: number;
    lon: number;
  } | null>(null);

  const [destSuggestions, setDestSuggestions] = useState<Suggestion[]>([]);
  const [showDestSuggestions, setShowDestSuggestions] = useState(false);
  const destDebounceRef = useRef<any>(null);

  const [routes, setRoutes] = useState<RouteObj[]>([]);
  const [activeRouteIndex, setActiveRouteIndex] = useState<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>("");

  const [navigationMode, setNavigationMode] = useState(false);

  const lastCameraPosRef = useRef<{ lat: number; lon: number } | null>(null);
  const smoothHeadingRef = useRef<number>(0);

  const lastSpokenStepRef = useRef<number>(-1);
  const lastSpeakTimeRef = useRef<number>(0);
  const lastRerouteTimeRef = useRef<number>(0);

  const [nextInstruction, setNextInstruction] = useState<string>("—");
  const [remainingKm, setRemainingKm] = useState<string>("—");
  const [remainingMin, setRemainingMin] = useState<string>("—");

  const OFF_ROUTE_THRESHOLD_METERS = 40;
  const REROUTE_COOLDOWN_MS = 8000;

  const searchTokenRef = useRef<number>(0);

  const [sensitiveMode, setSensitiveMode] = useState(false);

  function speakLocal(text: string) {
    try {
      const now = Date.now();
      if (now - lastSpeakTimeRef.current < 1200) return;
      lastSpeakTimeRef.current = now;

      Speech.stop();
      Speech.speak(text, { language: "en-IN", rate: 0.98, pitch: 1.0 });
    } catch {}
  }

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      setPermissionGranted(status === "granted");
      if (status !== "granted") {
        setStatusMsg("Location permission denied.");
        return;
      }

      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      setCurrentLat(pos.coords.latitude);
      setCurrentLon(pos.coords.longitude);

      setTimeout(() => {
        mapRef.current?.animateToRegion(
          {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            latitudeDelta: 0.02,
            longitudeDelta: 0.02,
          },
          700
        );
      }, 250);
    })();
  }, []);

  useEffect(() => {
    if (!permissionGranted) return;

    let sub: Location.LocationSubscription | null = null;

    (async () => {
      sub = await Location.watchPositionAsync(
        {
          accuracy: navigationMode
            ? Location.Accuracy.Balanced
            : Location.Accuracy.Low,
          timeInterval: navigationMode ? 900 : 2500,
          distanceInterval: navigationMode ? 3 : 10,
        },
        async (pos) => {
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;

          setCurrentLat(lat);
          setCurrentLon(lon);

          const rawHeading =
            pos.coords.heading !== null && pos.coords.heading !== undefined
              ? pos.coords.heading
              : smoothHeadingRef.current;

          smoothHeadingRef.current = smoothHeading(
            smoothHeadingRef.current,
            rawHeading,
            0.15
          );

          if (navigationMode) {
            const last = lastCameraPosRef.current;
            const movedEnough = !last || distanceMeters(last, { lat, lon }) >= 8;

            if (movedEnough) {
              lastCameraPosRef.current = { lat, lon };

              mapRef.current?.animateCamera(
                {
                  center: { latitude: lat, longitude: lon },
                  heading: smoothHeadingRef.current,
                  pitch: 35,
                  zoom: 17,
                },
                { duration: 650 }
              );
            }

            await handleNavigationTick(lat, lon);
          }
        }
      );
    })();

    return () => {
      if (sub) sub.remove();
    };
  }, [permissionGranted, navigationMode, routes, activeRouteIndex]);

  useEffect(() => {
    const q = destinationText.trim();

    if (destDebounceRef.current) clearTimeout(destDebounceRef.current);

    if (q.length < 3) {
      setDestSuggestions([]);
      setShowDestSuggestions(false);
      return;
    }

    destDebounceRef.current = setTimeout(async () => {
      try {
        const sug = await fetchPhotonSuggestions(q);
        setDestSuggestions(sug);
        setShowDestSuggestions(sug.length > 0);
      } catch {
        setDestSuggestions([]);
        setShowDestSuggestions(false);
      }
    }, 300);

    return () => {
      if (destDebounceRef.current) clearTimeout(destDebounceRef.current);
    };
  }, [destinationText]);

  const canSearch = useMemo(() => {
    return (
      !!destinationText.trim() &&
      (useManualStart ? !!manualStartText.trim() : true)
    );
  }, [destinationText, manualStartText, useManualStart]);

  function fitToRoute(route: RouteObj) {
    const coords = route.geometry.coordinates.map((c) => ({
      latitude: c[1],
      longitude: c[0],
    }));

    if (coords.length < 2) return;

    mapRef.current?.fitToCoordinates(coords, {
      edgePadding: { top: 120, right: 60, bottom: 260, left: 60 },
      animated: true,
    });
  }

  function selectRoute(i: number) {
    setActiveRouteIndex(i);
    const r = routes[i];
    fitToRoute(r);
    setStatusMsg(`Route ${i + 1} selected.`);
  }

  function onPickSuggestion(s: Suggestion) {
    setDestinationText(s.label);
    setSelectedDest({ lat: s.lat, lon: s.lon });
    setShowDestSuggestions(false);
    Keyboard.dismiss();
  }

  async function getStartPoint() {
    if (!currentLat || !currentLon) throw new Error("GPS not ready");

    if (useManualStart) {
      const s = await geocodePlaceFast(manualStartText.trim());
      return { lat: s.lat, lon: s.lon };
    }

    const snapped = await snapToRoad(currentLat, currentLon);
    return snapped;
  }

  async function fetchRoutes() {
    if (!canSearch) {
      setStatusMsg("Enter destination (and start if manual).");
      return;
    }

    const myToken = Date.now();
    searchTokenRef.current = myToken;

    try {
      Keyboard.dismiss();
      setLoading(true);
      setStatusMsg("Finding routes...");

      const start = await getStartPoint();

      let dest = selectedDest;
      if (!dest) dest = await geocodePlaceFast(destinationText.trim());
      dest = await snapToRoad(dest.lat, dest.lon);

      const osrmUrlFast = `${OSRM_ROUTE_URL}/${start.lon},${start.lat};${dest.lon},${dest.lat}?overview=simplified&geometries=geojson&alternatives=true&steps=false&continue_straight=false&annotations=false`;

      const cacheKeyFast = makeOsrmCacheKey(
        start.lon,
        start.lat,
        dest.lon,
        dest.lat,
        false,
        "simplified"
      );

      let dataFast: any;
      if (osrmRouteCache.has(cacheKeyFast)) {
        dataFast = osrmRouteCache.get(cacheKeyFast);
        setStatusMsg("Loaded fast routes ⚡");
      } else {
        const res = await fetch(osrmUrlFast);
        dataFast = await res.json();
        osrmRouteCache.set(cacheKeyFast, dataFast);
      }

      if (!dataFast.routes || dataFast.routes.length === 0) {
        setRoutes([]);
        setActiveRouteIndex(null);
        setStatusMsg("No routes found. Try selecting from suggestions.");
        setLoading(false);
        return;
      }

      const osrmRoutesFast = [...dataFast.routes].sort(
        (a: any, b: any) => a.duration - b.duration
      );
      const top3Fast = osrmRoutesFast.slice(0, 3);

      const fastRoutes: RouteObj[] = top3Fast.map((r: any) => ({
        distance_m: r.distance,
        duration_s: r.duration,
        geometry: { type: "LineString", coordinates: r.geometry.coordinates },
        avg_aqi: null,
        aqi_color: "gray",
        steps: [],
      }));

      setRoutes(fastRoutes);
      setActiveRouteIndex(0);

      setStatusMsg(`Found ${fastRoutes.length} routes. Refining roads + AQI...`);
      setLoading(false);

      setTimeout(() => fitToRoute(fastRoutes[0]), 250);

      fetch(`${API_BASE}/aqi_for_routes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routes: fastRoutes }),
      })
        .then((r) => r.json())
        .then((data2) => {
          if (searchTokenRef.current !== myToken) return;
          if (data2.routes && data2.routes.length > 0) {
            setRoutes((prev) => {
              const merged = prev.map((p, i) => ({
                ...p,
                ...(data2.routes[i] || {}),
                geometry: p.geometry,
              }));
              return merged;
            });
            setStatusMsg("AQI updated.");
          }
        })
        .catch(() => {});

      setTimeout(async () => {
        try {
          if (searchTokenRef.current !== myToken) return;

          const osrmUrlFull = `${OSRM_ROUTE_URL}/${start.lon},${start.lat};${dest.lon},${dest.lat}?overview=full&geometries=geojson&alternatives=true&steps=false&continue_straight=false&annotations=false`;

          const cacheKeyFull = makeOsrmCacheKey(
            start.lon,
            start.lat,
            dest.lon,
            dest.lat,
            false,
            "full"
          );

          let dataFull: any;
          if (osrmRouteCache.has(cacheKeyFull)) {
            dataFull = osrmRouteCache.get(cacheKeyFull);
          } else {
            const res = await fetch(osrmUrlFull);
            dataFull = await res.json();
            osrmRouteCache.set(cacheKeyFull, dataFull);
          }

          if (!dataFull.routes || dataFull.routes.length === 0) return;

          const osrmRoutesFull = [...dataFull.routes].sort(
            (a: any, b: any) => a.duration - b.duration
          );
          const top3Full = osrmRoutesFull.slice(0, 3);

          setRoutes((prev) => {
            const updated = prev.map((p, i) => {
              const fullR = top3Full[i];
              if (!fullR?.geometry?.coordinates) return p;
              return {
                ...p,
                geometry: {
                  type: "LineString",
                  coordinates: fullR.geometry.coordinates,
                },
              };
            });
            return updated;
          });

          if (searchTokenRef.current === myToken) {
            setStatusMsg("Road geometry refined ✅");
          }
        } catch {}
      }, 350);
    } catch {
      setStatusMsg("Route fetch failed.");
      setLoading(false);
    }
  }

  async function fetchStepsForNavigation() {
    if (!currentLat || !currentLon) return null;

    let dest = selectedDest;
    if (!dest) dest = await geocodePlaceFast(destinationText.trim());
    dest = await snapToRoad(dest.lat, dest.lon);

    const snapped = await snapToRoad(currentLat, currentLon);

    const osrmUrl = `${OSRM_ROUTE_URL}/${snapped.lon},${snapped.lat};${dest.lon},${dest.lat}?overview=full&geometries=geojson&alternatives=false&steps=true&continue_straight=false&annotations=false`;

    const cacheKey = makeOsrmCacheKey(
      snapped.lon,
      snapped.lat,
      dest.lon,
      dest.lat,
      true,
      "full"
    );

    let data: any;
    if (osrmRouteCache.has(cacheKey)) {
      data = osrmRouteCache.get(cacheKey);
    } else {
      const res = await fetch(osrmUrl);
      data = await res.json();
      osrmRouteCache.set(cacheKey, data);
    }

    if (!data.routes || data.routes.length === 0) return null;

    const best = data.routes[0];
    return {
      distance_m: best.distance,
      duration_s: best.duration,
      geometry: { type: "LineString", coordinates: best.geometry.coordinates },
      steps: extractStepsFromOSRMRoute(best),
    };
  }

  async function handleNavigationTick(lat: number, lon: number) {
    if (activeRouteIndex === null) return;
    if (!routes[activeRouteIndex]) return;

    const activeRoute = routes[activeRouteIndex];
    const steps = activeRoute.steps || [];

    const idx = closestIndexOnRoute(
      { lat, lon },
      activeRoute.geometry.coordinates
    );
    const remDistM = remainingDistanceMetersFromIndex(
      activeRoute.geometry.coordinates,
      idx
    );

    setRemainingKm(`${(remDistM / 1000).toFixed(1)} km`);

    const avgSpeed =
      activeRoute.duration_s > 0
        ? activeRoute.distance_m / activeRoute.duration_s
        : 0;
    const remTimeS = avgSpeed > 0 ? remDistM / avgSpeed : 0;
    setRemainingMin(`${Math.max(1, Math.round(remTimeS / 60))} min`);

    const nextStep = steps[lastSpokenStepRef.current + 1];
    setNextInstruction(nextStep?.text || "Continue");

    for (let i = 0; i < steps.length; i++) {
      if (i <= lastSpokenStepRef.current) continue;

      const loc = steps[i].location;
      if (!loc) continue;

      const stepLon = loc[0];
      const stepLat = loc[1];

      const dist = distanceMeters({ lat, lon }, { lat: stepLat, lon: stepLon });

      if (dist < 35) {
        lastSpokenStepRef.current = i;
        setStatusMsg("Instruction: " + steps[i].text);
        speakLocal(steps[i].text);
        break;
      }
    }

    const offDist = closestDistanceToRouteMeters(
      { lat, lon },
      activeRoute.geometry.coordinates
    );

    if (offDist > OFF_ROUTE_THRESHOLD_METERS) {
      const now = Date.now();
      if (now - lastRerouteTimeRef.current < REROUTE_COOLDOWN_MS) return;

      lastRerouteTimeRef.current = now;
      speakLocal("You are off route. Rerouting now.");
      setStatusMsg("Off route! Rerouting...");

      await rerouteFromCurrentLocation(lat, lon);
    }
  }

  async function rerouteFromCurrentLocation(lat: number, lon: number) {
    try {
      let dest = selectedDest;
      if (!dest) dest = await geocodePlaceFast(destinationText.trim());
      dest = await snapToRoad(dest.lat, dest.lon);

      const snapped = await snapToRoad(lat, lon);

      const osrmUrl = `${OSRM_ROUTE_URL}/${snapped.lon},${snapped.lat};${dest.lon},${dest.lat}?overview=full&geometries=geojson&alternatives=false&steps=true&continue_straight=false&annotations=false`;

      const cacheKey = makeOsrmCacheKey(
        snapped.lon,
        snapped.lat,
        dest.lon,
        dest.lat,
        true,
        "full"
      );

      let data: any;
      if (osrmRouteCache.has(cacheKey)) {
        data = osrmRouteCache.get(cacheKey);
      } else {
        const res = await fetch(osrmUrl);
        data = await res.json();
        osrmRouteCache.set(cacheKey, data);
      }

      if (!data.routes || data.routes.length === 0) {
        setStatusMsg("Reroute failed.");
        speakLocal("Reroute failed.");
        return;
      }

      const best = data.routes[0];

      const newRoute: RouteObj = {
        distance_m: best.distance,
        duration_s: best.duration,
        geometry: { type: "LineString", coordinates: best.geometry.coordinates },
        avg_aqi: null,
        aqi_color: "gray",
        steps: extractStepsFromOSRMRoute(best),
      };

      setRoutes([newRoute]);
      setActiveRouteIndex(0);
      lastSpokenStepRef.current = -1;

      setTimeout(() => fitToRoute(newRoute), 250);

      setStatusMsg("Rerouted. Updating AQI...");
      speakLocal("New route found. Continue.");

      fetch(`${API_BASE}/aqi_for_routes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routes: [newRoute] }),
      })
        .then((r) => r.json())
        .then((data2) => {
          if (data2.routes && data2.routes.length > 0) {
            setRoutes(data2.routes);
            setActiveRouteIndex(0);
          }
        })
        .catch(() => {});
    } catch {
      setStatusMsg("Reroute error.");
      speakLocal("Reroute error.");
    }
  }

  const bestRouteAQI = useMemo(() => {
    if (!routes || routes.length === 0) return null;
    const idx = activeRouteIndex ?? 0;
    const aqi = routes[idx]?.avg_aqi;
    return aqi ?? null;
  }, [routes, activeRouteIndex]);

  const riskInfo = useMemo(() => {
    return getHealthRiskFromAQI(bestRouteAQI, sensitiveMode);
  }, [bestRouteAQI, sensitiveMode]);

  async function startNavigation() {
    if (activeRouteIndex === null) {
      setStatusMsg("Select a route first.");
      return;
    }
    if (!currentLat || !currentLon) {
      setStatusMsg("Waiting for GPS...");
      return;
    }

    setNavigationMode(true);
    setStatusMsg("Navigation started. Loading steps...");
    speakLocal("Navigation started.");

    // ✅ Speak AQI health advisory ONLY when navigation starts
    if (riskInfo && riskInfo.speak && riskInfo.levelKey !== "unknown") {
      setTimeout(() => {
        speakLocal(riskInfo.speak);
      }, 1200);
    }

    const stepsRoute = await fetchStepsForNavigation();
    const chosen = routes[activeRouteIndex];

    const finalRoute: RouteObj = {
      ...chosen,
      ...(stepsRoute
        ? {
            distance_m: stepsRoute.distance_m,
            duration_s: stepsRoute.duration_s,
            geometry: stepsRoute.geometry,
            steps: stepsRoute.steps,
          }
        : {}),
    };

    setRoutes([finalRoute]);
    setActiveRouteIndex(0);

    lastSpokenStepRef.current = -1;
    setNextInstruction("Continue");
    setRemainingKm("—");
    setRemainingMin("—");

    lastCameraPosRef.current = { lat: currentLat, lon: currentLon };
    setTimeout(() => {
      mapRef.current?.animateCamera(
        {
          center: { latitude: currentLat, longitude: currentLon },
          zoom: 17,
          pitch: 35,
          heading: smoothHeadingRef.current,
        },
        { duration: 700 }
      );
    }, 150);

    setStatusMsg("Navigation running.");
  }

  function stopNavigation() {
    setNavigationMode(false);
    Speech.stop();
    setStatusMsg("Navigation stopped.");
  }

  function recenter() {
    if (!currentLat || !currentLon) return;

    mapRef.current?.animateCamera(
      {
        center: { latitude: currentLat, longitude: currentLon },
        zoom: navigationMode ? 17 : 15,
        pitch: navigationMode ? 35 : 0,
        heading: navigationMode ? smoothHeadingRef.current : 0,
      },
      { duration: 600 }
    );
  }

  const initialRegion: Region = useMemo(() => {
    return {
      latitude: currentLat ?? 20.5937,
      longitude: currentLon ?? 78.9629,
      latitudeDelta: 0.03,
      longitudeDelta: 0.03,
    };
  }, [currentLat, currentLon]);

  const showSearchUI = !navigationMode;

  return (
    <View style={styles.container}>
      <MapView
        ref={(r) => {
          mapRef.current = r;
        }}
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        initialRegion={initialRegion}
        showsUserLocation={false}
        showsMyLocationButton={false}
        toolbarEnabled={false}
        rotateEnabled={true}
        scrollEnabled={true}
        zoomEnabled={true}
        pitchEnabled={true}
      >
        {routes.map((r, idx) => (
          <Polyline
            key={idx}
            coordinates={r.geometry.coordinates.map((c) => ({
              latitude: c[1],
              longitude: c[0],
            }))}
            strokeWidth={idx === activeRouteIndex ? 8 : 5}
            strokeColor={
              idx === activeRouteIndex
                ? colorFromAQIName(r.aqi_color)
                : "#94a3b8"
            }
            tappable
            onPress={() => selectRoute(idx)}
          />
        ))}

        {currentLat && currentLon && (
          <Marker
            coordinate={{ latitude: currentLat, longitude: currentLon }}
            anchor={{ x: 0.5, y: 0.5 }}
            flat
            rotation={smoothHeadingRef.current}
          >
            <View style={styles.arrowWrap}>
              <View style={styles.arrowOuter} />
              <View style={styles.arrowInner} />
            </View>
          </Marker>
        )}
      </MapView>

      {showSearchUI && (
        <View style={styles.searchPanel}>
          <View style={styles.searchBar}>
            <Text style={styles.searchIcon}>📍</Text>
            <TextInput
              placeholder={useManualStart ? "Start location" : "Current location"}
              placeholderTextColor="#6b7280"
              value={useManualStart ? manualStartText : "Current location"}
              editable={useManualStart}
              onChangeText={setManualStartText}
              style={styles.searchInput}
            />
          </View>

          <View style={[styles.searchBar, { marginTop: 10 }]}>
            <Text style={styles.searchIcon}>🔎</Text>
            <TextInput
              placeholder="Destination"
              placeholderTextColor="#6b7280"
              value={destinationText}
              onChangeText={(t) => {
                setDestinationText(t);
                setSelectedDest(null);
              }}
              onFocus={() => {
                if (destSuggestions.length > 0) setShowDestSuggestions(true);
              }}
              style={styles.searchInput}
            />
          </View>

          <View style={styles.healthRow}>
            <View
              style={[
                styles.riskBadge,
                { backgroundColor: riskInfo.bg, borderColor: riskInfo.bg },
              ]}
            >
              <Text style={[styles.riskBadgeText, { color: riskInfo.text }]}>
                {riskInfo.icon} {riskInfo.label}
              </Text>
              <Text style={[styles.riskBadgeSub, { color: riskInfo.text }]}>
                {riskInfo.sub}
              </Text>
            </View>

            <View style={styles.sensitiveBox}>
              <Text style={styles.sensitiveText}>Sensitive</Text>
              <Switch value={sensitiveMode} onValueChange={setSensitiveMode} />
            </View>
          </View>

          {showDestSuggestions && destSuggestions.length > 0 && (
            <View style={styles.suggestBox}>
              <ScrollView style={{ maxHeight: 220 }}>
                {destSuggestions.map((s, idx) => (
                  <Pressable
                    key={idx}
                    onPress={() => onPickSuggestion(s)}
                    style={styles.suggestItem}
                  >
                    <Text style={styles.suggestText}>{s.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}

          <View style={styles.rowBtns}>
            <Pressable
              onPress={() => setUseManualStart((p) => !p)}
              style={[
                styles.smallBtn,
                useManualStart ? styles.smallBtnOn : null,
              ]}
            >
              <Text style={styles.smallBtnText}>
                {useManualStart ? "Manual Start: ON" : "Manual Start: OFF"}
              </Text>
            </Pressable>

            <Pressable
              onPress={fetchRoutes}
              style={[styles.findBtn, loading ? { opacity: 0.6 } : null]}
              disabled={loading}
            >
              <Text style={styles.findBtnText}>
                {loading ? "Finding..." : "Find Routes"}
              </Text>
            </Pressable>
          </View>

          {routes.length > 0 && (
            <View style={styles.routeList}>
              {routes.map((r, i) => {
                const active = i === activeRouteIndex;
                return (
                  <Pressable
                    key={i}
                    onPress={() => selectRoute(i)}
                    style={[
                      styles.routeCard,
                      active ? styles.routeCardActive : null,
                    ]}
                  >
                    <View style={styles.routeCardTop}>
                      <Text style={styles.routeTitle}>Route {i + 1}</Text>

                      <View style={styles.aqiPill}>
                        <Text style={styles.aqiPillText}>
                          {r.avg_aqi
                            ? `AQI: ${Math.round(r.avg_aqi)}`
                            : "AQI: Loading"}
                        </Text>
                      </View>
                    </View>

                    <View style={styles.routeMeta}>
                      <Text style={styles.routeMetaText}>
                        🛣 {metersToKm(r.distance_m)} km
                      </Text>
                      <Text style={styles.routeMetaText}>
                        ⏱ {secondsToMin(r.duration_s)} min
                      </Text>
                      <Text style={styles.routeMetaText}>
                        🎨 {r.aqi_color || "gray"}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}

          {routes.length > 0 && (
            <Pressable onPress={startNavigation} style={styles.navBtn}>
              <Text style={styles.navBtnText}>Start Navigation</Text>
            </Pressable>
          )}

          {!!statusMsg && <Text style={styles.statusText}>{statusMsg}</Text>}
        </View>
      )}

      {!showSearchUI && (
        <View style={styles.navHud}>
          <View style={styles.bigInstructionBox}>
            <Text style={styles.bigInstructionTitle}>Next</Text>
            <Text style={styles.bigInstructionText}>{nextInstruction}</Text>

            <View style={styles.remRow}>
              <Text style={styles.remText}>📍 {remainingKm}</Text>
              <Text style={styles.remText}>⏱ {remainingMin}</Text>
            </View>
          </View>

          <View style={styles.navHudRow}>
            <Pressable onPress={recenter} style={styles.hudBtn}>
              <Text style={styles.hudBtnText}>Recenter</Text>
            </Pressable>

            <Pressable
              onPress={stopNavigation}
              style={[styles.hudBtn, styles.stopBtn]}
            >
              <Text style={styles.hudBtnText}>Stop</Text>
            </Pressable>
          </View>
        </View>
      )}

      {!showSearchUI && (
        <Pressable onPress={recenter} style={styles.floatingRecenter}>
          <Text style={{ fontSize: 18 }}>🎯</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  map: { flex: 1 },

  arrowWrap: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  arrowOuter: {
    width: 22,
    height: 22,
    backgroundColor: "#1d4ed8",
    borderRadius: 999,
    transform: [{ rotate: "45deg" }],
  },
  arrowInner: {
    position: "absolute",
    width: 10,
    height: 10,
    backgroundColor: "#ffffff",
    borderRadius: 999,
    opacity: 0.95,
  },

  searchPanel: {
    position: "absolute",
    top: Platform.OS === "android" ? 40 : 60,
    left: 14,
    right: 14,
    backgroundColor: "rgba(255,255,255,0.96)",
    borderRadius: 18,
    padding: 14,
  },

  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f3f4f6",
    borderRadius: 14,
    paddingHorizontal: 12,
    height: 46,
  },
  searchIcon: {
    fontSize: 16,
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: "#111827",
  },

  healthRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  riskBadge: {
    flex: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  riskBadgeText: {
    fontSize: 12,
    fontWeight: "900",
  },
  riskBadgeSub: {
    marginTop: 2,
    fontSize: 10,
    fontWeight: "800",
    opacity: 0.9,
  },
  sensitiveBox: {
    width: 115,
    height: 46,
    borderRadius: 14,
    backgroundColor: "#f3f4f6",
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sensitiveText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#111827",
  },

  suggestBox: {
    marginTop: 8,
    backgroundColor: "#ffffff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    overflow: "hidden",
  },
  suggestItem: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,0,0,0.06)",
  },
  suggestText: {
    color: "#111827",
    fontSize: 13,
    fontWeight: "600",
  },

  rowBtns: {
    flexDirection: "row",
    gap: 10,
    marginTop: 12,
    alignItems: "center",
  },

  smallBtn: {
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 12,
    backgroundColor: "#e5e7eb",
    justifyContent: "center",
  },
  smallBtnOn: {
    backgroundColor: "#dbeafe",
  },
  smallBtnText: {
    fontSize: 12,
    color: "#111827",
    fontWeight: "600",
  },

  findBtn: {
    flex: 1,
    height: 40,
    borderRadius: 12,
    backgroundColor: "#10b981",
    alignItems: "center",
    justifyContent: "center",
  },
  findBtnText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 14,
  },

  routeList: {
    marginTop: 12,
    gap: 10,
  },
  routeCard: {
    backgroundColor: "#111827",
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  routeCardActive: {
    borderColor: "#10b981",
    borderWidth: 2,
  },
  routeCardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  routeTitle: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "800",
  },
  aqiPill: {
    backgroundColor: "rgba(255,255,255,0.12)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  aqiPillText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 12,
  },
  routeMeta: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
    flexWrap: "wrap",
  },
  routeMetaText: {
    color: "#cbd5e1",
    fontSize: 12,
    fontWeight: "600",
  },

  navBtn: {
    marginTop: 12,
    backgroundColor: "#2563eb",
    height: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  navBtnText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 14,
  },

  statusText: {
    marginTop: 10,
    color: "#111827",
    fontSize: 12,
    fontWeight: "600",
  },

  navHud: {
    position: "absolute",
    bottom: 30,
    left: 14,
    right: 14,
    borderRadius: 18,
    padding: 14,
  },

  bigInstructionBox: {
    backgroundColor: "rgba(17,24,39,0.95)",
    borderRadius: 18,
    padding: 14,
    marginBottom: 10,
  },
  bigInstructionTitle: {
    color: "#93c5fd",
    fontSize: 12,
    fontWeight: "800",
    marginBottom: 6,
  },
  bigInstructionText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "900",
  },

  remRow: {
    marginTop: 10,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  remText: {
    color: "#cbd5e1",
    fontSize: 12,
    fontWeight: "700",
  },

  navHudRow: {
    flexDirection: "row",
    gap: 10,
  },
  hudBtn: {
    flex: 1,
    height: 44,
    borderRadius: 14,
    backgroundColor: "rgba(17,24,39,0.95)",
    alignItems: "center",
    justifyContent: "center",
  },
  stopBtn: {
    backgroundColor: "#ef4444",
  },
  hudBtnText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 14,
  },

  floatingRecenter: {
    position: "absolute",
    right: 18,
    bottom: 160,
    width: 52,
    height: 52,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.95)",
    alignItems: "center",
    justifyContent: "center",
    elevation: 5,
  },
});
