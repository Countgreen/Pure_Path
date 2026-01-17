def aqi_to_color(aqi):
    """
    Your 5 AQI colors + gray fallback
    green, yellow, orange, blue, red
    gray when not available
    """
    if aqi is None:
        return ("#9ca3af", "Gray")

    aqi = float(aqi)

    if aqi <= 50:
        return ("#22c55e", "Green")
    elif aqi <= 100:
        return ("#eab308", "Yellow")
    elif aqi <= 150:
        return ("#f97316", "Orange")
    elif aqi <= 200:
        return ("#3b82f6", "Blue")
    else:
        return ("#ef4444", "Red")
