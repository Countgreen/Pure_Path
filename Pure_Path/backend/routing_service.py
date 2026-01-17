import requests

OSRM_PROFILE_URLS = {
    "car": "http://router.project-osrm.org/route/v1/driving",
    "bike": "http://router.project-osrm.org/route/v1/cycling",
    "walk": "http://router.project-osrm.org/route/v1/walking",
}


def _build_instruction(step: dict) -> str:
    maneuver = step.get("maneuver", {}) or {}
    step_type = (maneuver.get("type") or "").lower()
    modifier = (maneuver.get("modifier") or "").lower()
    road_name = (step.get("name") or "").strip()

    def onto_road(txt: str) -> str:
        if road_name:
            return f"{txt} onto {road_name}"
        return txt

    if step_type == "depart":
        return onto_road("Start")

    if step_type == "arrive":
        return "You have arrived at your destination"

    if step_type == "turn":
        if modifier:
            return onto_road(f"Turn {modifier}")
        return onto_road("Turn")

    if step_type == "new name":
        return onto_road("Continue")

    if step_type == "continue":
        if modifier:
            return onto_road(f"Continue {modifier}")
        return onto_road("Continue straight")

    if step_type == "merge":
        if modifier:
            return onto_road(f"Merge {modifier}")
        return onto_road("Merge")

    if step_type == "on ramp":
        if modifier:
            return onto_road(f"Take the ramp {modifier}")
        return onto_road("Take the ramp")

    if step_type == "off ramp":
        if modifier:
            return onto_road(f"Take the exit {modifier}")
        return onto_road("Take the exit")

    if step_type == "fork":
        if modifier:
            return onto_road(f"Keep {modifier} at the fork")
        return onto_road("Keep at the fork")

    if step_type == "roundabout":
        exit_no = maneuver.get("exit")
        if exit_no:
            return f"At the roundabout, take exit {exit_no}"
        return "Enter the roundabout"

    if step_type == "rotary":
        exit_no = maneuver.get("exit")
        if exit_no:
            return f"At the rotary, take exit {exit_no}"
        return "Enter the rotary"

    if step_type == "end of road":
        if modifier:
            return onto_road(f"At the end of the road, turn {modifier}")
        return onto_road("At the end of the road, turn")

    if road_name:
        return f"Continue on {road_name}"

    return "Continue"


def get_osrm_routes(start_coord, end_coord, mode="car", alternatives=True):
    """
    start_coord = [lon, lat]
    end_coord   = [lon, lat]
    mode = car | bike | walk
    """
    mode = (mode or "car").lower().strip()
    if mode not in OSRM_PROFILE_URLS:
        mode = "car"

    base_url = OSRM_PROFILE_URLS[mode]

    start_lon, start_lat = start_coord
    end_lon, end_lat = end_coord

    url = f"{base_url}/{start_lon},{start_lat};{end_lon},{end_lat}"

    params = {
        "overview": "full",
        "geometries": "geojson",
        "alternatives": "true" if alternatives else "false",
        "steps": "true",
        "annotations": "true",
        "continue_straight": "false",
    }

    res = requests.get(url, params=params, timeout=20)
    res.raise_for_status()

    data = res.json()

    if "routes" not in data or not data["routes"]:
        raise ValueError("No routes returned from OSRM")

    final_routes = []

    for r in data["routes"]:
        route_obj = {
            "distance_m": r.get("distance", 0),
            "duration_s": r.get("duration", 0),
            "geometry": {
                "type": "LineString",
                "coordinates": r["geometry"]["coordinates"],
            },
            "steps": []
        }

        legs = r.get("legs", [])
        if legs:
            for leg in legs:
                steps = leg.get("steps", [])
                for step in steps:
                    maneuver = step.get("maneuver", {}) or {}
                    instruction_text = _build_instruction(step)

                    route_obj["steps"].append({
                        "instruction": instruction_text,
                        "distance_m": step.get("distance", 0),
                        "duration_s": step.get("duration", 0),
                        "maneuver": {
                            "type": maneuver.get("type"),
                            "modifier": maneuver.get("modifier"),
                            "exit": maneuver.get("exit"),
                            "location": maneuver.get("location"),
                            "bearing_before": maneuver.get("bearing_before"),
                            "bearing_after": maneuver.get("bearing_after"),
                        },
                        "geometry": step.get("geometry", None),
                        "name": step.get("name", "")
                    })

        final_routes.append(route_obj)

    return final_routes
