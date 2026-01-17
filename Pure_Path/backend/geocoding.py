import re
import requests

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"

HEADERS = {
    "User-Agent": "PurePath/1.0 (Educational Project)"
}

def _parse_coordinates(place: str):
    """
    Supports:
      - "lat,lon"
      - "lon,lat"
      - with spaces: "20.296, 85.824"
    Returns: [lon, lat] or None
    """
    if not place:
        return None

    s = place.strip()

    # Match: number , number
    m = re.match(r"^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$", s)
    if not m:
        return None

    a = float(m.group(1))
    b = float(m.group(3))

    # Case 1: assume lat,lon
    if -90 <= a <= 90 and -180 <= b <= 180:
        lat, lon = a, b
        return [lon, lat]

    # Case 2: assume lon,lat
    if -180 <= a <= 180 and -90 <= b <= 90:
        lon, lat = a, b
        return [lon, lat]

    return None


def geocode_place(place: str):
    """
    Returns [lon, lat] in GeoJSON style.
    Accepts normal place names and coordinate strings.
    """
    coords = _parse_coordinates(place)
    if coords:
        return coords

    params = {
        "q": place,
        "format": "json",
        "limit": 1
    }

    res = requests.get(NOMINATIM_URL, params=params, headers=HEADERS, timeout=15)
    res.raise_for_status()

    data = res.json()
    if not data:
        raise ValueError(f"Could not geocode place: {place}")

    lat = float(data[0]["lat"])
    lon = float(data[0]["lon"])

    return [lon, lat]  # GeoJSON style [lon, lat]
