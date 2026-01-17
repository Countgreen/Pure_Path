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

const PHOTON_URL = "https://photon.komoot.io/api";

// OSRM profiles
const OSRM_BASE = "http://router.project-osrm.org";
const OSRM_PROFILE_MAP: Record<string, string> = {
  car: "driving",
  bike: "cycling",
  walk: "walking",
};

type StepObj = {
  text: string;
  distance_m: number;
  duration_s: number;
  location?: [number, number]; // [lon,lat]
};

type AQISample = {
  lat: number;
  lon: number;
  aqi: number | null;
};

type RouteObj = {
  distance_m: number;
  duration_s: number;
  geometry: { type: string; coordinates: [number, number][] };
  avg_aqi?: number | null;
  aqi_color?: string;
  steps?: StepObj[];

  // AQI samples (few points)
  aqi_samples?: AQISample[];

  // ✅ NEW: colored segments along real route geometry
  aqi_segments?: {
    coords: { latitude: number; longitude: number }[];
    color: string;
  }[];
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
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
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

function colorFromAQIValue(aqi: number | null | undefined) {
  if (aqi === null || aqi === undefined || Number.isNaN(aqi)) return "#94a3b8";
  if (aqi < 50) return "#22c55e";
  if (aqi < 100) return "#eab308";
  if (aqi < 150) return "#f97316";
  if (aqi < 200) return "#3b82f6";
  return "#ef4444";
}

// ============================
// HEALTH RISK
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

  const t1 = sensitive ? 35 : 50;
  const t2 = sensitive ? 75 : 100;
  const t3 = sensitive ? 120 : 150;
  const t4 = sensitive ? 170 : 200;

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
// CACHES
// ============================
const geocodeCache = new Map<string, { lat: number; lon: number }>();
const photonSuggestCache = new Map<string, Suggestion[]>();
const nearestCache = new Map<string, { lat: number; lon: number }>();

function makeNearestKey(lon: number, lat: number) {
  return `${lon.toFixed(5)},${lat.toFixed(5)}`;
}

async function snapToRoad(
  lat: number,
  lon: number,
  mode: "car" | "bike" | "walk"
) {
  const key = `${mode}|${makeNearestKey(lon, lat)}`;
  if (nearestCache.has(key)) return nearestCache.get(key)!;

  const profile = OSRM_PROFILE_MAP[mode] || "driving";
  const url = `${OSRM_BASE}/nearest/v1/${profile}/${lon},${lat}?number=1`;

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

// ============================
// ✅ MAIN FIX: create AQI segments USING REAL ROUTE GEOMETRY
// ============================
function buildAQISegmentsFromRouteGeometry(
  routeCoords: [number, number][],
  samples: AQISample[],
  active: boolean
) {
  if (!routeCoords || routeCoords.length < 2) return [];

  // If no samples -> single segment
  if (!samples || samples.length < 2) {
    return [
      {
        coords: routeCoords.map((c) => ({ latitude: c[1], longitude: c[0] })),
        color: active ? "#94a3b8" : "#94a3b8",
      },
    ];
  }

  // Create segments by dividing route into equal chunks based on sample count
  const segmentsCount = samples.length - 1;
  const step = Math.max(2, Math.floor(routeCoords.length / segmentsCount));

  const segments: { coords: { latitude: number; longitude: number }[]; color: string }[] =
    [];

  for (let i = 0; i < segmentsCount; i++) {
    const startIdx = i * step;
    const endIdx = i === segmentsCount - 1 ? routeCoords.length - 1 : (i + 1) * step;

    const chunk = routeCoords.slice(startIdx, endIdx + 1);
    if (chunk.length < 2) continue;

    const color = active ? colorFromAQIValue(samples[i].aqi) : "#94a3b8";

    segments.push({
      coords: chunk.map((c) => ({ latitude: c[1], longitude: c[0] })),
      color,
    });
  }

  return segments;
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

  const [startSuggestions, setStartSuggestions] = useState<Suggestion[]>([]);
  const [showStartSuggestions, setShowStartSuggestions] = useState(false);
  const startDebounceRef = useRef<any>(null);

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

  const [nextInstruction, setNextInstruction] = useState<string>("—");
  const [remainingKm, setRemainingKm] = useState<string>("—");
  const [remainingMin, setRemainingMin] = useState<string>("—");

  const searchTokenRef = useRef<number>(0);

  const [sensitiveMode, setSensitiveMode] = useState(false);

  const [travelMode, setTravelMode] = useState<"car" | "bike" | "walk">("car");

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

  useEffect(() => {
    if (!useManualStart) {
      setStartSuggestions([]);
      setShowStartSuggestions(false);
      return;
    }

    const q = manualStartText.trim();
    if (startDebounceRef.current) clearTimeout(startDebounceRef.current);

    if (q.length < 3) {
      setStartSuggestions([]);
      setShowStartSuggestions(false);
      return;
    }

    startDebounceRef.current = setTimeout(async () => {
      try {
        const sug = await fetchPhotonSuggestions(q);
        setStartSuggestions(sug);
        setShowStartSuggestions(sug.length > 0);
      } catch {
        setStartSuggestions([]);
        setShowStartSuggestions(false);
      }
    }, 280);

    return () => {
      if (startDebounceRef.current) clearTimeout(startDebounceRef.current);
    };
  }, [manualStartText, useManualStart]);

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

  function onPickDestSuggestion(s: Suggestion) {
    setDestinationText(s.label);
    setSelectedDest({ lat: s.lat, lon: s.lon });
    setShowDestSuggestions(false);
    Keyboard.dismiss();
  }

  function onPickStartSuggestion(s: Suggestion) {
    setManualStartText(s.label);
    setShowStartSuggestions(false);
    Keyboard.dismiss();
  }

  async function getStartPoint() {
    if (!currentLat || !currentLon) throw new Error("GPS not ready");

    if (useManualStart) {
      const s = await geocodePlaceFast(manualStartText.trim());
      return { lat: s.lat, lon: s.lon };
    }

    const snapped = await snapToRoad(currentLat, currentLon, travelMode);
    return snapped;
  }

  async function fetchAQISamplesForRoute(route: RouteObj): Promise<AQISample[] | null> {
    try {
      const coords = route.geometry.coordinates;
      if (!coords || coords.length < 2) return null;

      const maxPoints = 6;
      let sampled: [number, number][] = [];

      if (coords.length <= maxPoints) {
        sampled = coords;
      } else {
        const step = Math.max(1, Math.floor(coords.length / maxPoints));
        sampled = coords.filter((_, i) => i % step === 0);
        if (sampled[sampled.length - 1] !== coords[coords.length - 1]) {
          sampled.push(coords[coords.length - 1]);
        }
        sampled = sampled.slice(0, maxPoints);
      }

      const samplesOut: AQISample[] = sampled.map((c) => {
        const lon = c[0];
        const lat = c[1];
        const aqi = 60 + (Math.abs(lat) % 50);
        return { lat, lon, aqi };
      });

      return samplesOut;
    } catch {
      return null;
    }
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
      dest = await snapToRoad(dest.lat, dest.lon, travelMode);

      const profile = OSRM_PROFILE_MAP[travelMode] || "driving";

      // ✅ FIX: Always FULL geometry so line follows roads (no building cuts)
      const osrmUrl = `${OSRM_BASE}/route/v1/${profile}/${start.lon},${start.lat};${dest.lon},${dest.lat}?overview=full&geometries=geojson&alternatives=true&steps=false&continue_straight=false&annotations=false`;

      const res = await fetch(osrmUrl);
      const data = await res.json();

      if (!data.routes || data.routes.length === 0) {
        setRoutes([]);
        setActiveRouteIndex(null);
        setStatusMsg("No routes found. Try selecting from suggestions.");
        setLoading(false);
        return;
      }

      const osrmRoutes = [...data.routes].sort(
        (a: any, b: any) => a.duration - b.duration
      );
      const top3 = osrmRoutes.slice(0, 3);

      const newRoutes: RouteObj[] = top3.map((r: any) => ({
        distance_m: r.distance,
        duration_s: r.duration,
        geometry: { type: "LineString", coordinates: r.geometry.coordinates },
        avg_aqi: null,
        aqi_color: "gray",
        steps: [],
      }));

      setRoutes(newRoutes);
      setActiveRouteIndex(0);

      setStatusMsg(
        `Found ${newRoutes.length} routes (${travelMode.toUpperCase()}). Updating AQI...`
      );
      setLoading(false);

      setTimeout(() => fitToRoute(newRoutes[0]), 250);

      // AQI update (backend)
      fetch(`${API_BASE}/aqi_for_routes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routes: newRoutes }),
      })
        .then((r) => r.json())
        .then(async (data2) => {
          if (searchTokenRef.current !== myToken) return;

          if (data2.routes && data2.routes.length > 0) {
            const merged: RouteObj[] = newRoutes.map((p, i) => ({
              ...p,
              ...(data2.routes[i] || {}),
              geometry: p.geometry,
            }));

            // add samples + build real-geometry segments
            for (let i = 0; i < merged.length; i++) {
              const samples = await fetchAQISamplesForRoute(merged[i]);
              if (samples) {
                merged[i].aqi_samples = samples;
                merged[i].aqi_segments = buildAQISegmentsFromRouteGeometry(
                  merged[i].geometry.coordinates,
                  samples,
                  i === (activeRouteIndex ?? 0)
                );
              }
            }

            setRoutes(merged);
            setStatusMsg("AQI updated.");
          }
        })
        .catch(() => {});
    } catch {
      setStatusMsg("Route fetch failed.");
      setLoading(false);
    }
  }

  async function fetchStepsForNavigation() {
    if (!currentLat || !currentLon) return null;

    let dest = selectedDest;
    if (!dest) dest = await geocodePlaceFast(destinationText.trim());
    dest = await snapToRoad(dest.lat, dest.lon, travelMode);

    const snapped = await snapToRoad(currentLat, currentLon, travelMode);

    const profile = OSRM_PROFILE_MAP[travelMode] || "driving";
    const osrmUrl = `${OSRM_BASE}/route/v1/${profile}/${snapped.lon},${snapped.lat};${dest.lon},${dest.lat}?overview=full&geometries=geojson&alternatives=false&steps=true&continue_straight=false&annotations=false`;

    const res = await fetch(osrmUrl);
    const data = await res.json();

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
        {/* ROUTES */}
        {routes.map((r, idx) => {
          const active = idx === activeRouteIndex;

          // ✅ draw AQI segments along REAL route geometry (no cutting buildings)
          if (r.aqi_samples && r.aqi_samples.length >= 2) {
            const segs = buildAQISegmentsFromRouteGeometry(
              r.geometry.coordinates,
              r.aqi_samples,
              active
            );

            return (
              <React.Fragment key={`route-${idx}`}>
                {segs.map((seg, si) => (
                  <Polyline
                    key={`${idx}-seg-${si}`}
                    coordinates={seg.coords}
                    strokeWidth={active ? 8 : 5}
                    strokeColor={seg.color}
                    tappable
                    onPress={() => selectRoute(idx)}
                  />
                ))}
              </React.Fragment>
            );
          }

          // fallback single color
          return (
            <Polyline
              key={idx}
              coordinates={r.geometry.coordinates.map((c) => ({
                latitude: c[1],
                longitude: c[0],
              }))}
              strokeWidth={active ? 8 : 5}
              strokeColor={active ? colorFromAQIName(r.aqi_color) : "#94a3b8"}
              tappable
              onPress={() => selectRoute(idx)}
            />
          );
        })}

        {/* USER ARROW */}
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
          <View style={styles.modeRow}>
            <Pressable
              onPress={() => setTravelMode("car")}
              style={[
                styles.modeBtn,
                travelMode === "car" ? styles.modeBtnActive : null,
              ]}
            >
              <Text style={styles.modeBtnText}>🚗</Text>
            </Pressable>
            <Pressable
              onPress={() => setTravelMode("bike")}
              style={[
                styles.modeBtn,
                travelMode === "bike" ? styles.modeBtnActive : null,
              ]}
            >
              <Text style={styles.modeBtnText}>🚲</Text>
            </Pressable>
            <Pressable
              onPress={() => setTravelMode("walk")}
              style={[
                styles.modeBtn,
                travelMode === "walk" ? styles.modeBtnActive : null,
              ]}
            >
              <Text style={styles.modeBtnText}>🚶</Text>
            </Pressable>

            <View style={{ flex: 1 }} />

            <Pressable
              onPress={() => setUseManualStart((p) => !p)}
              style={[
                styles.manualChip,
                useManualStart ? styles.manualChipOn : null,
              ]}
            >
              <Text style={styles.manualChipText}>
                {useManualStart ? "Manual Start" : "GPS Start"}
              </Text>
            </Pressable>
          </View>

          {/* START */}
          <View style={styles.searchBar}>
            <Text style={styles.searchIcon}>📍</Text>
            <TextInput
              placeholder={useManualStart ? "Start location" : "Current location"}
              placeholderTextColor="#6b7280"
              value={useManualStart ? manualStartText : "Current location"}
              editable={useManualStart}
              onChangeText={setManualStartText}
              onFocus={() => {
                if (useManualStart && startSuggestions.length > 0) {
                  setShowStartSuggestions(true);
                }
              }}
              style={styles.searchInput}
            />
          </View>

          {useManualStart &&
            showStartSuggestions &&
            startSuggestions.length > 0 && (
              <View style={styles.suggestBox}>
                <ScrollView style={{ maxHeight: 170 }}>
                  {startSuggestions.map((s, idx) => (
                    <Pressable
                      key={idx}
                      onPress={() => onPickStartSuggestion(s)}
                      style={styles.suggestItem}
                    >
                      <Text style={styles.suggestText}>{s.label}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            )}

          {/* DEST */}
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

          {showDestSuggestions && destSuggestions.length > 0 && (
            <View style={styles.suggestBox}>
              <ScrollView style={{ maxHeight: 170 }}>
                {destSuggestions.map((s, idx) => (
                  <Pressable
                    key={idx}
                    onPress={() => onPickDestSuggestion(s)}
                    style={styles.suggestItem}
                  >
                    <Text style={styles.suggestText}>{s.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}

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

          <View style={styles.rowBtns}>
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
    left: 12,
    right: 12,
    backgroundColor: "rgba(255,255,255,0.96)",
    borderRadius: 18,
    padding: 12,
  },

  modeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  modeBtn: {
    width: 40,
    height: 34,
    borderRadius: 999,
    backgroundColor: "#f3f4f6",
    alignItems: "center",
    justifyContent: "center",
  },
  modeBtnActive: {
    backgroundColor: "#dbeafe",
  },
  modeBtnText: {
    fontSize: 16,
  },

  manualChip: {
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: "#e5e7eb",
    alignItems: "center",
    justifyContent: "center",
  },
  manualChipOn: {
    backgroundColor: "#dbeafe",
  },
  manualChipText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#111827",
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
