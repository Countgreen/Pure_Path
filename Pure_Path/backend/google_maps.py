import requests

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
HEADERS = {"User-Agent": "PurePath-App"}

def get_lat_lon(place: str):
    params = {
        "q": place,
        "format": "json",
        "limit": 1
    }

    response = requests.get(
        NOMINATIM_URL,
        params=params,
        headers=HEADERS,
        timeout=10
    )

    data = response.json()

    if not data:
        raise ValueError(f"Location not found: {place}")

    return float(data[0]["lat"]), float(data[0]["lon"])
