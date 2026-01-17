def filter_routes_by_time(routes, time_factor=1.5):
    """
    Keeps routes whose duration <= time_factor * shortest_duration
    """
    if not routes:
        return []

    shortest = min(r["duration_s"] for r in routes)
    limit = shortest * time_factor

    filtered = [r for r in routes if r["duration_s"] <= limit]
    return filtered


def pick_fastest_index(routes):
    if not routes:
        return 0
    best = 0
    best_time = routes[0]["duration_s"]
    for i, r in enumerate(routes):
        if r["duration_s"] < best_time:
            best_time = r["duration_s"]
            best = i
    return best


def pick_safest_index(routes):
    """
    Safest = minimum max_aqi (more safety than avg)
    If max_aqi missing, fallback to avg_aqi
    If both missing, treat as very bad
    """
    if not routes:
        return 0

    best = 0
    best_val = float("inf")

    for i, r in enumerate(routes):
        max_aqi = r.get("max_aqi")
        avg_aqi = r.get("aqi")

        if max_aqi is None and avg_aqi is None:
            val = 999999
        else:
            val = max_aqi if max_aqi is not None else avg_aqi

        if val < best_val:
            best_val = val
            best = i

    return best


def pick_best_index(routes):
    """
    Best = balance between AQI and time
    Uses max_aqi primarily (safety), with time penalty
    """
    if not routes:
        return 0

    # normalization
    times = [r["duration_s"] for r in routes]
    min_t, max_t = min(times), max(times)

    aqi_vals = []
    for r in routes:
        if r.get("max_aqi") is not None:
            aqi_vals.append(r["max_aqi"])
        elif r.get("aqi") is not None:
            aqi_vals.append(r["aqi"])

    if len(aqi_vals) == 0:
        # if AQI missing everywhere -> fastest
        return pick_fastest_index(routes)

    min_a, max_a = min(aqi_vals), max(aqi_vals)

    def norm(x, mn, mx):
        if mx == mn:
            return 0.0
        return (x - mn) / (mx - mn)

    best_idx = 0
    best_score = float("inf")

    for i, r in enumerate(routes):
        t_score = norm(r["duration_s"], min_t, max_t)

        # prefer max_aqi, fallback avg_aqi
        aqi = r.get("max_aqi")
        if aqi is None:
            aqi = r.get("aqi")

        # if still missing -> punish heavily
        if aqi is None:
            a_score = 1.5
        else:
            a_score = norm(aqi, min_a, max_a)

        # weights (AQI more important)
        score = 0.7 * a_score + 0.3 * t_score

        r["score"] = score  # store for debugging

        if score < best_score:
            best_score = score
            best_idx = i

    return best_idx
