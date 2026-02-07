const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function badRequest(message) {
  return jsonResponse({ error: message }, 400);
}

function parseZipParam(url) {
  const zip = url.searchParams.get("zip")?.trim();
  if (!zip || !/^\d{5}$/.test(zip)) return null;
  return zip;
}

function parseLatLon(url) {
  const lat = Number.parseFloat(url.searchParams.get("lat"));
  const lon = Number.parseFloat(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function normalizeCityLabel(relativeLocation) {
  const city = relativeLocation?.properties?.city;
  const state = relativeLocation?.properties?.state;
  if (city && state) return `${city}, ${state}`;
  if (relativeLocation?.properties?.name) return relativeLocation.properties.name;
  return null;
}

async function handleLocation(request) {
  const url = new URL(request.url);
  const zip = parseZipParam(url);
  if (!zip) return badRequest("Please provide a valid 5-digit ZIP code.");

  const geoUrl = `https://api.zippopotam.us/us/${zip}`;
  const geoRes = await fetch(geoUrl, { headers: { "user-agent": "noaa-friendly-weather" } });
  if (!geoRes.ok) return jsonResponse({ error: "ZIP lookup failed." }, 404);

  const geoData = await geoRes.json();
  const place = geoData?.places?.[0];
  const lat = Number.parseFloat(place?.latitude);
  const lon = Number.parseFloat(place?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return jsonResponse({ error: "ZIP lookup failed." }, 404);
  }

  const label = [place["place name"], place["state abbreviation"]].filter(Boolean).join(", ");
  return jsonResponse({ zip, lat, lon, label });
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "noaa-friendly-weather" } });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

async function handleWeather(request) {
  const url = new URL(request.url);
  const coords = parseLatLon(url);
  if (!coords) return badRequest("Please provide valid latitude and longitude.");

  const pointUrl = `https://api.weather.gov/points/${coords.lat},${coords.lon}`;
  const pointData = await fetchJson(pointUrl);
  const forecastUrl = pointData?.properties?.forecast;
  const forecastHourlyUrl = pointData?.properties?.forecastHourly;
  const relativeLocation = pointData?.properties?.relativeLocation;

  if (!forecastUrl || !forecastHourlyUrl) {
    return jsonResponse({ error: "Weather data is unavailable." }, 502);
  }

  const [forecastData, hourlyData, alertsData] = await Promise.all([
    fetchJson(forecastUrl),
    fetchJson(forecastHourlyUrl),
    fetchJson(`https://api.weather.gov/alerts/active?point=${coords.lat},${coords.lon}`),
  ]);

  return jsonResponse({
    fetchedAt: new Date().toISOString(),
    location: {
      name: normalizeCityLabel(relativeLocation) || "Your area",
    },
    hourlyPeriods: hourlyData?.properties?.periods ?? [],
    dailyPeriods: forecastData?.properties?.periods ?? [],
    alerts: alertsData?.features?.map((alert) => alert?.properties).filter(Boolean) ?? [],
    soilMoisture: null,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/location") {
      return handleLocation(request);
    }

    if (url.pathname === "/api/weather") {
      return handleWeather(request);
    }

    return env.ASSETS.fetch(request);
  },
};
