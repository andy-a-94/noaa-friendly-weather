/**
 * Almanac Weather - Cloudflare Worker
 * Routes:
 *  - GET /api/location?zip=12345
 *  - GET /api/weather?lat=..&lon=..[&zip=12345]
 *
 * Data sources:
 *  - NWS /api.weather.gov (forecast, hourly, grid, alerts)
 *  - USNO AA Dept (sun/moon + moon phase): https://aa.usno.navy.mil/api/rstt/oneday
 *  - EPA UV (optional; daytime display): https://data.epa.gov/dmapservice/
 *  - Open-Meteo (soil moisture for shoe rating): https://archive-api.open-meteo.com/v1/archive
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const NWS_HEADERS = {
  "User-Agent": "AlmanacWeather (almanacweather.com)",
  "Accept": "application/geo+json",
};

const DEFAULT_TIMEOUT_MS = 4500;

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS },
  });
}

async function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const res = await fetchWithTimeout(url, init, timeoutMs);
  const text = await res.text();
  if (!res.ok) {
    const snippet = text.slice(0, 220);
    const err = new Error(`Fetch failed (${res.status}) ${url}`);
    err.status = res.status;
    err.bodySnippet = snippet;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(`Invalid JSON from ${url}`);
    err.status = 502;
    err.bodySnippet = text.slice(0, 220);
    throw err;
  }
}

function isFiniteNum(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function safeStr(s) {
  return (s ?? "").toString().trim();
}

function formatCityState(pointJson) {
  const rel = pointJson?.properties?.relativeLocation?.properties;
  const city = safeStr(rel?.city);
  const state = safeStr(rel?.state);
  if (!city || !state) return { city: "", state: "", label: "" };
  return { city, state, label: `${city}, ${state}` };
}

function tzOffsetHours(timeZone, dateObj = new Date()) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(dateObj);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const y = Number(get("year"));
    const m = Number(get("month"));
    const d = Number(get("day"));
    const hh = Number(get("hour"));
    const mm = Number(get("minute"));
    const ss = Number(get("second"));
    const asUtc = Date.UTC(y, m - 1, d, hh, mm, ss);
    const offsetMs = asUtc - dateObj.getTime();
    return Math.round((offsetMs / 3600000) * 100) / 100;
  } catch {
    return 0;
  }
}

function ymdInTimeZone(timeZone, dateObj = new Date()) {
  try {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return dtf.format(dateObj);
  } catch {
    const y = dateObj.getUTCFullYear();
    const m = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dateObj.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
}

function hmToMinutes(hm) {
  const s = safeStr(hm);
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function localNowMinutes(timeZone) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(new Date());
    const hh = Number(parts.find(p => p.type === "hour")?.value ?? "0");
    const mm = Number(parts.find(p => p.type === "minute")?.value ?? "0");
    return hh * 60 + mm;
  } catch {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }
}

function parseNwsValidTime(validTime) {
  const s = safeStr(validTime);
  const [startStr, durStr] = s.split("/");
  const startMs = Date.parse(startStr);
  if (!Number.isFinite(startMs) || !durStr) return null;

  let durMs = 0;
  const hm = durStr.match(/^PT(?:(\d+)H)?(?:(\d+)M)?/i);
  if (hm) {
    const h = Number(hm[1] || 0);
    const m = Number(hm[2] || 0);
    durMs = (h * 3600 + m * 60) * 1000;
  } else {
    return null;
  }
  if (durMs <= 0) return null;
  return { startMs, endMs: startMs + durMs };
}

function valueAt(seriesValues, targetMs) {
  if (!Array.isArray(seriesValues) || !Number.isFinite(targetMs)) return null;

  let prev = null;
  for (const item of seriesValues) {
    const interval = parseNwsValidTime(item.validTime);
    if (!interval) continue;
    if (targetMs >= interval.startMs && targetMs < interval.endMs) return item.value;
    if (interval.startMs <= targetMs) prev = item.value;
    if (interval.startMs > targetMs) break;
  }
  return prev;
}

function cToF(c) {
  return (c * 9) / 5 + 32;
}

async function handleLocation(zip) {
  const z = safeStr(zip);
  if (!/^\d{5}$/.test(z)) {
    return jsonResponse({ error: "Invalid ZIP" }, 400);
  }

  const url = `https://api.zippopotam.us/us/${encodeURIComponent(z)}`;
  const res = await fetchWithTimeout(url, {}, 3500);
  if (!res.ok) return jsonResponse({ error: "ZIP not found" }, 404);

  const j = await res.json();
  const place = j?.places?.[0];
  const lat = Number(place?.latitude);
  const lon = Number(place?.longitude);
  const city = safeStr(place?.["place name"]);
  const state = safeStr(place?.["state abbreviation"]);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return jsonResponse({ error: "ZIP returned no coordinates" }, 502);
  }

  return jsonResponse({
    zip: z,
    lat,
    lon,
    label: city && state ? `${city}, ${state}` : z,
  });
}

/* ---------------- EPA UV ---------------- */

async function fetchEpaUv({ zip, city, state, timeZone }) {
  const base = "https://data.epa.gov/dmapservice";
  const source = { provider: "epa-uv" };

  let url = "";
  if (/^\d{5}$/.test(safeStr(zip))) {
    url = `${base}/getEnvirofactsUVHOURLY/ZIP/${encodeURIComponent(zip)}/json`;
  } else if (city && state) {
    url = `${base}/getEnvirofactsUVHOURLY/CITY/${encodeURIComponent(city)}/STATE/${encodeURIComponent(state)}/json`;
  } else {
    return { ok: false, current: null, max: null, source: { ...source, ok: false, reason: "missing location" } };
  }

  try {
    const arr = await fetchJson(url, {}, 3500);
    if (!Array.isArray(arr) || arr.length === 0) {
      return { ok: false, current: null, max: null, source: { ...source, ok: true, reason: "no data" } };
    }

    const todayYmd = ymdInTimeZone(timeZone, new Date());
    const nowMin = localNowMinutes(timeZone);

    let max = null;
    let current = null;
    let currentBestMin = -1;

    const monMap = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };

    for (const row of arr) {
      const dt = safeStr(row.DATE_TIME);
      const uv = Number(row.UV_VALUE);

      if (!Number.isFinite(uv)) continue;

      let y, m, d, hh, mm;

      let m1 = dt.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
      if (m1) {
        y = m1[1]; m = m1[2]; d = m1[3]; hh = m1[4]; mm = m1[5];
      } else {
        let m2 = dt.match(/^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})/);
        if (m2) {
          y = m2[3]; m = m2[1]; d = m2[2]; hh = m2[4]; mm = m2[5];
        } else {
          const m3 = dt.match(/^([A-Za-z]{3})\/(\d{1,2})\/(\d{4})\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
          if (!m3) continue;

          const mon = monMap[m3[1].toLowerCase()];
          if (!mon) continue;

          y = m3[3];
          m = mon;
          d = String(m3[2]).padStart(2, "0");

          let hour12 = Number(m3[4]);
          const minute = m3[5] ? Number(m3[5]) : 0;
          const ampm = String(m3[6]).toUpperCase();

          if (!Number.isFinite(hour12) || !Number.isFinite(minute)) continue;
          hour12 = clamp(hour12, 1, 12);

          let hour24 = hour12 % 12;
          if (ampm === "PM") hour24 += 12;

          hh = String(hour24).padStart(2, "0");
          mm = String(clamp(minute, 0, 59)).padStart(2, "0");
        }
      }

      const rowYmd = `${y}-${m}-${d}`;
      if (rowYmd !== todayYmd) continue;

      const rowMin = Number(hh) * 60 + Number(mm);
      if (max === null || uv > max) max = uv;

      if (rowMin <= nowMin && rowMin > currentBestMin) {
        current = uv;
        currentBestMin = rowMin;
      }
    }

    return {
      ok: true,
      current: current === null ? null : current,
      max: max === null ? null : max,
      source: { ...source, ok: true },
    };
  } catch (e) {
    return {
      ok: false,
      current: null,
      max: null,
      source: {
        ...source,
        ok: false,
        status: e.status || 502,
        reason: e.message || "fetch failed",
        bodySnippet: e.bodySnippet,
      },
    };
  }
}

/* ---------------- Open-Meteo Soil Moisture (Archive; cached) ---------------- */

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x * 100) / 100;
}

function addDaysUtc(dateObj, deltaDays) {
  const d = new Date(dateObj.getTime());
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d;
}

function ymdUtc(dateObj) {
  const y = dateObj.getUTCFullYear();
  const m = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function shoeLevelFromSoilMoisture(sm) {
  // 0..3 mapping to your UI tiers:
  // 0 Sandal (dry), 1 Sneaker (damp), 2 Hiking Boot (wet), 3 Rain Boot (rainy/muddy)
  const v = Number(sm);
  if (!Number.isFinite(v)) return null;
  if (v >= 0.4) return 3;
  if (v >= 0.25) return 2;
  if (v >= 0.12) return 1;
  return 0;
}

function shoeLabelEmojiFromLevel(level) {
  const L = clamp(Number(level), 0, 3);
  if (L === 0) return { label: "Sandal", emoji: "🩴" };
  if (L === 1) return { label: "Sneaker", emoji: "👟" };
  if (L === 2) return { label: "Hiking Boot", emoji: "🥾" };
  return { label: "Rain Boot", emoji: "👢" };
}

function rainBoostFromForecastText(text) {
  const s = safeStr(text).toLowerCase();
  if (!s) return { boost: 0, reason: "" };

  // ✅ per your request: include "showers" in +2
  if (s.includes("heavy rain") || s.includes("downpour") || s.includes("torrential") || s.includes("thunder") || s.includes("showers")) {
    return { boost: 2, reason: "Rain now (heavy/showers/thunder)" };
  }

  if (s.includes("rain") || s.includes("drizzle")) {
    return { boost: 1, reason: "Rain now" };
  }

  return { boost: 0, reason: "" };
}

function computeRainBoost(currentPeriod, nextHourPeriod) {
  const cTxt = safeStr(currentPeriod?.shortForecast || currentPeriod?.detailedForecast || "");
  const nTxt = safeStr(nextHourPeriod?.shortForecast || nextHourPeriod?.detailedForecast || "");

  const c = rainBoostFromForecastText(cTxt);
  const n = rainBoostFromForecastText(nTxt);

  // Take the stronger signal
  if (n.boost > c.boost) return { ...n, from: "next_hour" };
  if (c.boost > 0) return { ...c, from: "current" };
  return { boost: 0, reason: "", from: "" };
}

async function fetchOpenMeteoSoilArchive({ lat, lon }) {
  const source = { provider: "open-meteo-archive" };

  const la2 = round2(lat);
  const lo2 = round2(lon);
  if (la2 === null || lo2 === null) {
    return { ok: false, soilMoisture0To7cm: null, unit: "m3/m3", shoe: null, source: { ...source, ok: false, reason: "invalid lat/lon" } };
  }

  // Cache key bucketing: same rounded coords + UTC date + 3-hour bucket
  const now = new Date();
  const ymd = ymdUtc(now);
  const bucket = Math.floor(now.getUTCHours() / 3); // 0..7
  const cacheKeyUrl = `https://cache.almanacweather.com/soil?lat=${la2}&lon=${lo2}&date=${ymd}&b=${bucket}`;

  try {
    const cache = caches.default;
    const cacheReq = new Request(cacheKeyUrl, { method: "GET" });
    const cached = await cache.match(cacheReq);
    if (cached) {
      const j = await cached.json();
      return j;
    }

    // Pull last 48 hours (yesterday..today) from archive
    const start = ymdUtc(addDaysUtc(now, -2));
    const end = ymdUtc(now);

    const url =
      `https://archive-api.open-meteo.com/v1/archive` +
      `?latitude=${encodeURIComponent(String(la2))}` +
      `&longitude=${encodeURIComponent(String(lo2))}` +
      `&start_date=${encodeURIComponent(start)}` +
      `&end_date=${encodeURIComponent(end)}` +
      `&hourly=soil_moisture_0_to_7cm` +
      `&timezone=UTC`;

    const om = await fetchJson(url, {}, 3200);

    const times = om?.hourly?.time;
    const vals = om?.hourly?.soil_moisture_0_to_7cm;

    const nowMs = Date.now();
    const sixHMs = 6 * 3600 * 1000;

    let max6h = null;
    let latest = null;
    let latestMs = -1;

    if (Array.isArray(times) && Array.isArray(vals) && times.length && vals.length) {
      for (let i = 0; i < Math.min(times.length, vals.length); i++) {
        const tMs = Date.parse(times[i]);
        if (!Number.isFinite(tMs)) continue;

        const v = Number(vals[i]);
        if (!Number.isFinite(v)) continue;

        // Track latest non-null <= now
        if (tMs <= nowMs && tMs > latestMs) {
          latestMs = tMs;
          latest = v;
        }

        // Track max over last 6 hours
        if (tMs <= nowMs && tMs >= (nowMs - sixHMs)) {
          if (max6h === null || v > max6h) max6h = v;
        }
      }
    }

    const picked = (max6h !== null) ? max6h : (latest !== null ? latest : null);

    const payload = {
      ok: Number.isFinite(picked),
      soilMoisture0To7cm: Number.isFinite(picked) ? picked : null,
      unit: "m3/m3",
      method: (max6h !== null) ? "max_last_6h" : (latest !== null ? "latest_non_null_48h" : "none"),
      source: { ...source, ok: true },
      shoe: null, // filled later after we consider rain boost
    };

    const resp = new Response(JSON.stringify(payload), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=21600", // 6 hours
      },
    });
    await cache.put(cacheReq, resp.clone());

    return payload;
  } catch (e) {
    return {
      ok: false,
      soilMoisture0To7cm: null,
      unit: "m3/m3",
      method: "error",
      shoe: null,
      source: { ...source, ok: false, status: e.status || 502, reason: e.message || "fetch failed", bodySnippet: e.bodySnippet },
    };
  }
}

/* ---------------- USNO Astro ---------------- */

async function fetchUsnoAstro({ lat, lon, timeZone }) {
  const source = { provider: "usno-aa" };
  try {
    const date = ymdInTimeZone(timeZone, new Date());
    const tz = tzOffsetHours(timeZone, new Date());
    const url =
      `https://aa.usno.navy.mil/api/rstt/oneday?date=${encodeURIComponent(date)}` +
      `&coords=${encodeURIComponent(`${lat}, ${lon}`)}` +
      `&tz=${encodeURIComponent(String(tz))}` +
      `&ID=ALMNAC`;

    const j = await fetchJson(url, {}, 3500);
    if (j?.error) {
      return { ok: false, source: { ...source, ok: false, reason: "api error" } };
    }

    const data = j?.properties?.data;
    const sundata = Array.isArray(data?.sundata) ? data.sundata : [];
    const moondata = Array.isArray(data?.moondata) ? data.moondata : [];

    const pick = (arr, phenName) => {
      const found = arr.find(x => safeStr(x.phen).toLowerCase() === phenName.toLowerCase());
      return found ? safeStr(found.time) : "";
    };

    const sunrise = pick(sundata, "Rise");
    const sunset = pick(sundata, "Set");
    const moonrise = pick(moondata, "Rise");
    const moonset = pick(moondata, "Set");

    const moonPhase = safeStr(data?.curphase);
    const fracillum = Number(data?.fracillum);
    const moonIlluminationPct = Number.isFinite(fracillum) ? clamp(fracillum * 100, 0, 100) : null;

    const nowMin = localNowMinutes(timeZone);
    const srMin = hmToMinutes(sunrise);
    const ssMin = hmToMinutes(sunset);
    const isDaytimeNow = (srMin !== null && ssMin !== null)
      ? (nowMin >= srMin && nowMin < ssMin)
      : false;

    return {
      ok: true,
      sunrise: sunrise || null,
      sunset: sunset || null,
      moonrise: moonrise || null,
      moonset: moonset || null,
      moonPhase: moonPhase || null,
      moonIlluminationPct,
      isDaytimeNow,
      source: { ...source, ok: true },
    };
  } catch (e) {
    return {
      ok: false,
      sunrise: null,
      sunset: null,
      moonrise: null,
      moonset: null,
      moonPhase: null,
      moonIlluminationPct: null,
      isDaytimeNow: false,
      source: { ...source, ok: false, status: e.status || 502, reason: e.message, bodySnippet: e.bodySnippet },
    };
  }
}

/* ---------------- Main Weather ---------------- */

async function handleWeather(lat, lon, zip) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) {
    return jsonResponse({ error: "Invalid lat/lon" }, 400);
  }

  const pointsUrl = `https://api.weather.gov/points/${la},${lo}`;
  const pointData = await fetchJson(pointsUrl, { headers: NWS_HEADERS }, 4500);

  const props = pointData?.properties || {};
  const timeZone = safeStr(props.timeZone) || "UTC";

  const { city, state, label } = formatCityState(pointData);

  const forecastUrl = safeStr(props.forecast);
  const hourlyUrl = safeStr(props.forecastHourly);
  const gridUrl = safeStr(props.forecastGridData);

  const zoneId = safeStr(props.forecastZone).split("/").pop();

  if (!forecastUrl || !hourlyUrl) {
    return jsonResponse({ error: "NWS points response missing forecast URLs" }, 502);
  }

  const alertsUrl = zoneId ? `https://api.weather.gov/alerts/active?zone=${encodeURIComponent(zoneId)}` : null;

  const fetches = await Promise.allSettled([
    fetchJson(forecastUrl, { headers: NWS_HEADERS }, 4500),
    fetchJson(hourlyUrl, { headers: NWS_HEADERS }, 4500),
    gridUrl ? fetchJson(gridUrl, { headers: NWS_HEADERS }, 4500) : Promise.resolve(null),
    alertsUrl ? fetchJson(alertsUrl, { headers: NWS_HEADERS }, 4500) : Promise.resolve(null),
    fetchUsnoAstro({ lat: la, lon: lo, timeZone }),
    fetchEpaUv({ zip: safeStr(zip), city, state, timeZone }),
    fetchOpenMeteoSoilArchive({ lat: la, lon: lo }), // ✅ Archive soil moisture + max 6h (cached)
  ]);

  const [dailyRes, hourlyRes, gridRes, alertsRes, astroRes, uvRes, soilRes] = fetches;

  if (dailyRes.status !== "fulfilled" || hourlyRes.status !== "fulfilled") {
    return jsonResponse({ error: "Failed to fetch forecast data" }, 502);
  }

  const dailyJson = dailyRes.value;
  const hourlyJson = hourlyRes.value;

  const hourlyPeriods = Array.isArray(hourlyJson?.properties?.periods) ? hourlyJson.properties.periods : [];
  const dailyPeriods = Array.isArray(dailyJson?.properties?.periods) ? dailyJson.properties.periods : [];

  const current = hourlyPeriods.length ? hourlyPeriods[0] : null;
  const nextHour = hourlyPeriods.length > 1 ? hourlyPeriods[1] : null;

  // Alerts
  let alerts = [];
  if (alertsRes.status === "fulfilled") {
    const feats = alertsRes.value?.features;
    if (Array.isArray(feats)) {
      alerts = feats
        .map(f => f?.properties)
        .filter(Boolean)
        .map(p => ({
          event: p.event,
          severity: p.severity,
          headline: p.headline,
          ends: p.ends,
          effective: p.effective,
        }));
    }
  }

  const outlook = { periods: dailyPeriods.slice(0, 2) };

  // Period metrics (dew point + RH) from grid data, keyed by NWS period.number
  let periodMetrics = {};
  if (gridRes.status === "fulfilled" && gridRes.value?.properties && Array.isArray(dailyPeriods) && dailyPeriods.length) {
    const gp = gridRes.value.properties;

    const dewSeries = gp?.dewpoint?.values;
    const rhSeries = gp?.relativeHumidity?.values;

    for (const p of dailyPeriods) {
      const startMs = Date.parse(p.startTime);
      const endMs = Date.parse(p.endTime);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      const midMs = startMs + (endMs - startMs) / 2;

      const dewC = valueAt(dewSeries, midMs);
      const rh = valueAt(rhSeries, midMs);

      const out = {};
      if (isFiniteNum(dewC)) out.dewpointF = cToF(dewC);
      if (isFiniteNum(rh)) out.relativeHumidityPct = clamp(rh, 0, 100);

      if (Object.keys(out).length) {
        periodMetrics[String(p.number)] = out;
      }
    }
  }

  // Astro & UV
  const astro = (astroRes.status === "fulfilled" && astroRes.value?.ok) ? astroRes.value : (astroRes.status === "fulfilled" ? astroRes.value : null);
  const uv = (uvRes.status === "fulfilled" && uvRes.value) ? uvRes.value : null;

  // Soil
  let soil = (soilRes.status === "fulfilled" && soilRes.value) ? soilRes.value : null;

  // ✅ Build boosted shoe recommendation (without changing raw soil moisture)
  if (soil && soil.ok && typeof soil.soilMoisture0To7cm === "number") {
    const baseLevel = shoeLevelFromSoilMoisture(soil.soilMoisture0To7cm);
    const rainBoost = computeRainBoost(current, nextHour);

    const boostedLevel = (baseLevel === null)
      ? null
      : clamp(baseLevel + (rainBoost.boost || 0), 0, 3);

    const baseLE = (baseLevel === null) ? null : shoeLabelEmojiFromLevel(baseLevel);
    const boostLE = (boostedLevel === null) ? null : shoeLabelEmojiFromLevel(boostedLevel);

    soil = {
      ...soil,
      shoe: {
        ok: boostedLevel !== null,
        baseLevel,
        baseLabel: baseLE?.label ?? null,
        baseEmoji: baseLE?.emoji ?? null,
        boost: rainBoost.boost || 0,
        boostedLevel,
        boostedLabel: boostLE?.label ?? null,
        boostedEmoji: boostLE?.emoji ?? null,
        reason: rainBoost.reason || "",
        from: rainBoost.from || "",
        explain: "Based on modeled soil moisture (0–7 cm), boosted if rain is occurring now.",
      },
    };
  } else if (soil && !soil.ok) {
    soil = {
      ...soil,
      shoe: {
        ok: false,
        baseLevel: null,
        baseLabel: null,
        baseEmoji: null,
        boost: 0,
        boostedLevel: null,
        boostedLabel: null,
        boostedEmoji: null,
        reason: "No soil moisture data.",
        from: "",
        explain: "Soil moisture unavailable.",
      },
    };
  }

  return jsonResponse({
    location: { lat: la, lon: lo, label: label || null, city: city || null, state: state || null },
    timeZone,

    current,
    outlook,
    hourly: { periods: hourlyPeriods },
    daily: { periods: dailyPeriods },

    periodMetrics,
    alerts,

    astro: astro && astro.ok ? {
      sunrise: astro.sunrise,
      sunset: astro.sunset,
      moonrise: astro.moonrise,
      moonset: astro.moonset,
      moonPhase: astro.moonPhase,
      moonIlluminationPct: astro.moonIlluminationPct,
      isDaytimeNow: astro.isDaytimeNow,
    } : (astro ? { ...astro, ok: false } : null),

    uv: uv ? uv : null,

    soil: soil ? soil : null,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return textResponse("Method Not Allowed", 405);
    }

    try {
      // ✅ Simple health check to confirm the GitHub-deployed Worker is live
      if (url.pathname === "/api/health") {
        return jsonResponse({ ok: true, worker: "noaa-friendly-weather", source: "github" });
      }

      if (url.pathname === "/api/location") {
        const zip = url.searchParams.get("zip");
        return await handleLocation(zip);
      }

      if (url.pathname === "/api/weather") {
        const lat = url.searchParams.get("lat");
        const lon = url.searchParams.get("lon");
        const zip = url.searchParams.get("zip"); // optional
        return await handleWeather(lat, lon, zip);
      }

      return textResponse("Not Found", 404);
    } catch (e) {
      const payload = {
        error: "Internal error",
        message: e?.message || String(e),
        status: e?.status || 500,
        bodySnippet: e?.bodySnippet,
      };
      return jsonResponse(payload, payload.status);
    }
  },
};
