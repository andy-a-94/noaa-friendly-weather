/**
 * Almanac Weather - Cloudflare Worker
 * Routes:
 *  - GET /api/location?q=10001 OR /api/location?q=Seattle, WA
 *  - GET /api/location/suggest?q=san%20f
 *  - GET /api/weather?lat=..&lon=..[&zip=12345]
 *
 * Data sources:
 *  - NWS /api.weather.gov (forecast, hourly, grid, alerts)
 *  - USNO AA Dept (sun/moon + moon phase): https://aa.usno.navy.mil/api/rstt/oneday
 *  - Open-Meteo Forecast (UV index + 14-day extension): https://api.open-meteo.com/v1/forecast
 *  - Open-Meteo (soil moisture for shoe rating): https://archive-api.open-meteo.com/v1/archive
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const NWS_HEADERS = {
  "User-Agent": "AlmanacWeather (almanacweather.com)",
  "Accept": "application/geo+json",
};

const DEFAULT_TIMEOUT_MS = 4500;
const TRACK_MAX_BODY_BYTES = 8 * 1024;
const TRACK_RATE_WINDOW_MS = 60 * 1000;
const TRACK_IP_LIMIT_PER_WINDOW = 120;
const TRACK_USER_LIMIT_PER_WINDOW = 60;
const NASA_MOON_DATASET_ID = "a005587";
const NASA_MOON_JSON_BASE_URL = `https://svs.gsfc.nasa.gov/vis/a000000/a005500/${NASA_MOON_DATASET_ID}`;
const NASA_MOON_FRAME_BASE_URL = `${NASA_MOON_JSON_BASE_URL}/frames/730x730_1x1_30p/moon`;

const trackRateState = {
  ip: new Map(),
  user: new Map(),
};

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

function csvResponse(text, filename = "weather-user-events.csv") {
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=\"${filename}\"`,
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
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

function pickFirstIsoString(...candidates) {
  for (const value of candidates) {
    const s = safeStr(value);
    if (!s) continue;
    if (Number.isFinite(Date.parse(s))) return s;
  }
  return null;
}

function latestAlertSourceTime(alertsJson) {
  const feats = Array.isArray(alertsJson?.features) ? alertsJson.features : [];
  let best = null;
  let bestMs = -1;

  for (const feat of feats) {
    const p = feat?.properties || {};
    const iso = pickFirstIsoString(p?.sent, p?.effective, p?.onset, p?.expires, p?.ends);
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (ms > bestMs) {
      bestMs = ms;
      best = iso;
    }
  }

  return best;
}

function toFiniteNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clipText(value, maxLen = 200) {
  return safeStr(value).slice(0, maxLen);
}

function cleanEventType(value) {
  const raw = clipText(value, 60).toLowerCase();
  return raw.replace(/[^a-z0-9_.-]/g, "_") || "event";
}

function isValidDeviceType(value) {
  const v = safeStr(value).toLowerCase();
  return !v || v === "mobile" || v === "tablet" || v === "desktop";
}

function hasAllowedTrackContentLength(request) {
  const raw = request.headers.get("content-length");
  if (!raw) return true;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= TRACK_MAX_BODY_BYTES;
}

function validateTrackLocation(value, min, max) {
  if (value === null || value === undefined || value === "") return true;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max;
}

function nowWindow(nowMs = Date.now()) {
  return Math.floor(nowMs / TRACK_RATE_WINDOW_MS);
}

function cleanupTrackRateMap(mapObj, currentWindow) {
  if (mapObj.size < 2000) return;
  for (const [key, slot] of mapObj) {
    if (slot.window !== currentWindow) mapObj.delete(key);
  }
}

function incrementTrackRate(mapObj, key, limit, currentWindow) {
  if (!key) return { ok: true, count: 0, limit };

  const prev = mapObj.get(key);
  if (!prev || prev.window !== currentWindow) {
    mapObj.set(key, { window: currentWindow, count: 1 });
    return { ok: true, count: 1, limit };
  }

  prev.count += 1;
  mapObj.set(key, prev);
  if (prev.count > limit) {
    return { ok: false, count: prev.count, limit };
  }

  return { ok: true, count: prev.count, limit };
}

function enforceTrackRateLimit(request, userId) {
  const currentWindow = nowWindow();
  cleanupTrackRateMap(trackRateState.ip, currentWindow);
  cleanupTrackRateMap(trackRateState.user, currentWindow);

  const ipKey = getIpHashInput(request);
  const ipResult = incrementTrackRate(trackRateState.ip, ipKey, TRACK_IP_LIMIT_PER_WINDOW, currentWindow);
  if (!ipResult.ok) return { ok: false, type: "ip", limit: TRACK_IP_LIMIT_PER_WINDOW };

  const userResult = incrementTrackRate(trackRateState.user, userId, TRACK_USER_LIMIT_PER_WINDOW, currentWindow);
  if (!userResult.ok) return { ok: false, type: "user", limit: TRACK_USER_LIMIT_PER_WINDOW };

  return { ok: true };
}

function getUserAgent(request) {
  return clipText(request.headers.get("user-agent"), 400);
}

function getIpHashInput(request) {
  return safeStr(request.headers.get("cf-connecting-ip")) || "unknown";
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function anonymizeIp(request, env) {
  const ip = getIpHashInput(request);
  const salt = safeStr(env.TRACKING_SALT) || "weather-default-salt";
  return sha256Hex(`${salt}:${ip}`);
}

async function handleTrackEvent(request, env) {
  if (!hasAllowedTrackContentLength(request)) {
    return jsonResponse({ error: `Payload too large (max ${TRACK_MAX_BODY_BYTES} bytes)` }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "Invalid event payload" }, 400);
  }

  const userId = clipText(body?.userId, 120);
  if (!userId) return jsonResponse({ error: "Missing userId" }, 400);
  if (!isValidDeviceType(body?.deviceType)) {
    return jsonResponse({ error: "Invalid deviceType" }, 400);
  }

  if (
    !validateTrackLocation(body?.locationLat, -90, 90) ||
    !validateTrackLocation(body?.userLat, -90, 90) ||
    !validateTrackLocation(body?.locationLon, -180, 180) ||
    !validateTrackLocation(body?.userLon, -180, 180)
  ) {
    return jsonResponse({ error: "Invalid location coordinate values" }, 400);
  }

  const rateLimit = enforceTrackRateLimit(request, userId);
  if (!rateLimit.ok) {
    return jsonResponse(
      {
        error: "Rate limit exceeded",
        rateLimitType: rateLimit.type,
        limitPerMinute: rateLimit.limit,
      },
      429,
      { "Retry-After": "60" }
    );
  }

  const nowIso = new Date().toISOString();
  const ipHash = await anonymizeIp(request, env);

  const event = {
    eventTime: nowIso,
    userId,
    sessionId: clipText(body?.sessionId, 120),
    eventType: cleanEventType(body?.eventType),
    action: clipText(body?.action, 120),
    target: clipText(body?.target, 240),
    page: clipText(body?.page || request.url, 240),
    searchQuery: clipText(body?.searchQuery, 160),
    locationLabel: clipText(body?.locationLabel, 160),
    locationLat: toFiniteNum(body?.locationLat),
    locationLon: toFiniteNum(body?.locationLon),
    userLat: toFiniteNum(body?.userLat),
    userLon: toFiniteNum(body?.userLon),
    deviceType: clipText(body?.deviceType, 80),
    userAgent: getUserAgent(request),
    ipHash,
    metadataJson: JSON.stringify(body?.metadata || {}),
  };

  if (env.EVENTS_DB) {
    await env.EVENTS_DB.prepare(
      `INSERT INTO user_events (
         event_time, user_id, session_id, event_type, action, target, page,
         search_query, location_label, location_lat, location_lon,
         user_lat, user_lon, device_type, user_agent, ip_hash, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      event.eventTime,
      event.userId,
      event.sessionId || null,
      event.eventType,
      event.action || null,
      event.target || null,
      event.page || null,
      event.searchQuery || null,
      event.locationLabel || null,
      event.locationLat,
      event.locationLon,
      event.userLat,
      event.userLon,
      event.deviceType || null,
      event.userAgent || null,
      event.ipHash,
      event.metadataJson
    ).run();
  }

  if (env.EVENTS_ANALYTICS) {
    env.EVENTS_ANALYTICS.writeDataPoint({
      indexes: [event.userId, event.eventType],
      blobs: [event.action || "", event.target || "", event.searchQuery || "", event.locationLabel || ""],
      doubles: [event.locationLat || 0, event.locationLon || 0, event.userLat || 0, event.userLon || 0],
    });
  }

  return jsonResponse({ ok: true });
}

function csvEscape(value) {
  const raw = value === null || value === undefined ? "" : String(value);
  if (!/[",\n]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((k) => csvEscape(row[k])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

async function handleExportEvents(request, env) {
  const auth = safeStr(request.headers.get("authorization"));
  const expected = safeStr(env.EXPORT_API_TOKEN);
  if (!expected || auth !== `Bearer ${expected}`) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  if (!env.EVENTS_DB) return jsonResponse({ error: "EVENTS_DB binding missing" }, 500);

  const url = new URL(request.url);
  const limit = clamp(Number(url.searchParams.get("limit")) || 5000, 1, 20000);
  const from = safeStr(url.searchParams.get("from"));
  const to = safeStr(url.searchParams.get("to"));

  let sql = `
    SELECT id, event_time, user_id, session_id, event_type, action, target, page,
           search_query, location_label, location_lat, location_lon,
           user_lat, user_lon, device_type, user_agent, ip_hash, metadata_json
    FROM user_events
    WHERE 1=1
  `;
  const binds = [];
  if (from) {
    sql += " AND event_time >= ?";
    binds.push(from);
  }
  if (to) {
    sql += " AND event_time <= ?";
    binds.push(to);
  }
  sql += " ORDER BY event_time DESC LIMIT ?";
  binds.push(limit);

  const { results } = await env.EVENTS_DB.prepare(sql).bind(...binds).all();
  const csv = toCsv(Array.isArray(results) ? results : []);
  return csvResponse(csv || "id,event_time\n", "weather-user-events.csv");
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
    const parts = dtf.formatToParts(dateObj);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const y = get("year");
    const m = get("month");
    const d = get("day");
    if (y && m && d) return `${y}-${m}-${d}`;
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

  const durMs = parseIso8601DurationToMs(durStr);
  if (durMs <= 0) return null;
  return { startMs, endMs: startMs + durMs };
}

function parseIso8601DurationToMs(durationStr) {
  const raw = safeStr(durationStr).toUpperCase();
  if (!raw) return null;

  // Supports: PT2H, PT30M, P1D, P1DT6H, P2DT30M, P1DT6H30M15S
  const m = raw.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;

  const d = Number(m[1] || 0);
  const h = Number(m[2] || 0);
  const min = Number(m[3] || 0);
  const sec = Number(m[4] || 0);

  const hasAny = d > 0 || h > 0 || min > 0 || sec > 0;
  if (!hasAny) return null;

  return (((d * 24 + h) * 60 + min) * 60 + sec) * 1000;
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

function parseCityStateQuery(q) {
  const text = safeStr(q);
  if (!text || /^\d{5}$/.test(text)) return null;

  const states = {
    alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
    delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN",
    iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
    michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
    "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
    "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
    virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
  };

  const [cityPart, statePart] = text.split(",").map((s) => safeStr(s));
  if (!cityPart || !statePart) return null;

  const normalizedState = statePart.toLowerCase();
  const stateAbbr = /^[A-Za-z]{2}$/.test(statePart)
    ? statePart.toUpperCase()
    : states[normalizedState] || "";

  if (!stateAbbr) return null;
  return { city: cityPart, state: stateAbbr };
}


async function handleLocationSuggest(query) {
  const q = safeStr(query);
  if (q.length < 2) return jsonResponse({ query: q, suggestions: [] });

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("limit", "8");

  const res = await fetchWithTimeout(url.toString(), {
    headers: {
      "Accept": "application/json",
      "User-Agent": "AlmanacWeather/1.0 (location suggestions)",
    },
  }, 3500);

  if (!res.ok) {
    return jsonResponse({ query: q, suggestions: [] }, 200);
  }

  let rows = [];
  try {
    rows = await res.json();
  } catch {
    rows = [];
  }

  const dedupe = new Set();
  const suggestions = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const addr = row?.address || {};
    const city = safeStr(addr.city || addr.town || addr.village || addr.hamlet || addr.municipality || "");
    const stateRaw = safeStr(addr.state || "");
    const stateCode = safeStr(addr.state_code || "").toUpperCase();
    const state = /^[A-Z]{2}$/.test(stateCode) ? stateCode : parseCityStateQuery(`x, ${stateRaw}`)?.state || "";
    const postcode = safeStr(addr.postcode || "").match(/\d{5}/)?.[0] || "";
    if (!city || !state) continue;

    const key = `${city}|${state}|${postcode}`.toLowerCase();
    if (dedupe.has(key)) continue;
    dedupe.add(key);

    suggestions.push({
      city,
      state,
      zip: postcode || null,
      query: `${city}, ${state}`,
      label: postcode ? `${city}, ${state} ${postcode}` : `${city}, ${state}`,
      lat: Number(row?.lat),
      lon: Number(row?.lon),
    });

    if (suggestions.length >= 6) break;
  }

  return jsonResponse({ query: q, suggestions });
}

async function handleLocation(query) {
  const q = safeStr(query);
  if (!q) return jsonResponse({ error: "Missing location query" }, 400);

  let url = "";
  let lookupType = "zip";
  let zip = "";
  const cityState = parseCityStateQuery(q);

  if (/^\d{5}$/.test(q)) {
    zip = q;
    url = `https://api.zippopotam.us/us/${encodeURIComponent(q)}`;
  } else if (cityState) {
    lookupType = "city";
    url = `https://api.zippopotam.us/us/${encodeURIComponent(cityState.state)}/${encodeURIComponent(cityState.city)}`;
  } else {
    return jsonResponse({ error: "Enter a 5-digit ZIP or City, ST" }, 400);
  }

  const res = await fetchWithTimeout(url, {}, 3500);
  if (!res.ok) return jsonResponse({ error: "Location not found" }, 404);

  const j = await res.json();
  const place = j?.places?.[0];
  const lat = Number(place?.latitude);
  const lon = Number(place?.longitude);
  const city = safeStr(place?.["place name"]);
  const state = safeStr(place?.["state abbreviation"]);
  const foundZip = safeStr(place?.["post code"] || j?.["post code"]);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return jsonResponse({ error: "Location returned no coordinates" }, 502);
  }

  return jsonResponse({
    query: q,
    type: lookupType,
    zip: /^\d{5}$/.test(foundZip) ? foundZip : zip,
    lat,
    lon,
    city,
    state,
    label: city && state ? `${city}, ${state}` : q,
  });
}

/* ---------------- Open-Meteo UV ---------------- */

async function fetchOpenMeteoUv({ lat, lon, timeZone }) {
  const source = { provider: "open-meteo-forecast" };
  const la2 = round2(lat);
  const lo2 = round2(lon);
  if (la2 === null || lo2 === null) {
    return { ok: false, current: null, max: null, sourceDataAt: null, source: { ...source, ok: false, reason: "invalid lat/lon" } };
  }

  try {
    // Cache by rounded location + local date + hourly bucket.
    // UV index updates most usefully on an hourly cadence.
    const now = new Date();
    const ymd = ymdInTimeZone(timeZone, now);
    const hourBucket = Math.floor(localNowMinutes(timeZone) / 60); // 0..23
    const cacheKeyUrl =
      `https://cache.almanacweather.com/uv` +
      `?lat=${encodeURIComponent(String(la2))}` +
      `&lon=${encodeURIComponent(String(lo2))}` +
      `&date=${encodeURIComponent(ymd)}` +
      `&h=${encodeURIComponent(String(hourBucket))}`;

    const cache = caches.default;
    const cacheReq = new Request(cacheKeyUrl, { method: "GET" });
    const cached = await cache.match(cacheReq);
    if (cached) {
      const j = await cached.json();
      return j;
    }

    const omTimeZone = safeStr(timeZone) || "auto";
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${encodeURIComponent(String(la2))}` +
      `&longitude=${encodeURIComponent(String(lo2))}` +
      `&timezone=${encodeURIComponent(omTimeZone)}` +
      `&hourly=uv_index` +
      `&daily=uv_index_max`;

    const om = await fetchJson(url, {}, 3500);

    const todayYmd = ymdInTimeZone(timeZone, now);
    const nowMin = localNowMinutes(timeZone);
    const times = Array.isArray(om?.hourly?.time) ? om.hourly.time : [];
    const uvVals = Array.isArray(om?.hourly?.uv_index) ? om.hourly.uv_index : [];

    let current = null;
    let currentBestMin = -1;
    const hourly = [];

    const n = Math.min(times.length, uvVals.length);
    for (let i = 0; i < n; i += 1) {
      const ts = safeStr(times[i]);
      const uv = Number(uvVals[i]);
      if (!Number.isFinite(uv)) continue;

      const day = ts.slice(0, 10);
      const hm = ts.slice(11, 16);
      const hh = Number(hm.slice(0, 2));
      const mm = Number(hm.slice(3, 5));
      if (!day || !Number.isFinite(hh) || !Number.isFinite(mm)) continue;
      if (day !== todayYmd) continue;

      hourly.push({ day, hour: hh, value: uv });

      const rowMin = hh * 60 + mm;
      if (rowMin <= nowMin && rowMin > currentBestMin) {
        current = uv;
        currentBestMin = rowMin;
      }
    }

    const dailyTimes = Array.isArray(om?.daily?.time) ? om.daily.time : [];
    const dailyMaxVals = Array.isArray(om?.daily?.uv_index_max) ? om.daily.uv_index_max : [];
    let max = null;
    for (let i = 0; i < Math.min(dailyTimes.length, dailyMaxVals.length); i += 1) {
      if (safeStr(dailyTimes[i]) !== todayYmd) continue;
      const v = Number(dailyMaxVals[i]);
      if (Number.isFinite(v)) {
        max = v;
        break;
      }
    }
    if (!Number.isFinite(max) && hourly.length) {
      max = hourly.reduce((acc, h) => {
        const v = Number(h?.value);
        if (!Number.isFinite(v)) return acc;
        return acc === null || v > acc ? v : acc;
      }, null);
    }

    const sourceDataAt = Number.isFinite(currentBestMin) && currentBestMin >= 0
      ? `${todayYmd}T${String(Math.floor(currentBestMin / 60)).padStart(2, "0")}:${String(currentBestMin % 60).padStart(2, "0")}:00`
      : (hourly.length ? `${hourly[0].day}T${String(hourly[0].hour).padStart(2, "0")}:00:00` : null);

    const payload = {
      ok: true,
      current: current === null ? null : current,
      max: max === null ? null : max,
      hourly,
      sourceDataAt,
      source: { ...source, ok: true },
    };

    const resp = new Response(JSON.stringify(payload), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=3600", // 1 hour
      },
    });
    await cache.put(cacheReq, resp.clone());

    return payload;
  } catch (e) {
    return {
      ok: false,
      current: null,
      max: null,
      sourceDataAt: null,
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

async function fetchUvCombined({ lat, lon, timeZone }) {
  return fetchOpenMeteoUv({ lat, lon, timeZone });
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
  if (v >= 0.46) return 3;
  if (v > 0.25) return 2;
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

function weatherCodeToShortForecast(code) {
  const c = Number(code);
  if (c === 0) return "Clear";
  if ([1, 2].includes(c)) return "Partly Cloudy";
  if (c === 3) return "Cloudy";
  if ([45, 48].includes(c)) return "Fog";
  if ([51, 53, 55, 56, 57].includes(c)) return "Drizzle";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(c)) return "Rain";
  if ([71, 73, 75, 77, 85, 86].includes(c)) return "Snow";
  if ([95, 96, 99].includes(c)) return "Thunderstorms";
  return "Forecast";
}

function formatWeekdayName(isoDay, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: safeStr(timeZone) || "UTC",
      weekday: "long",
    }).format(new Date(`${isoDay}T12:00:00Z`));
  } catch {
    return "Forecast";
  }
}

function isoDayShift(isoDay, deltaDays) {
  const base = Date.parse(`${safeStr(isoDay)}T00:00:00Z`);
  if (!Number.isFinite(base)) return null;
  return ymdUtc(addDaysUtc(new Date(base), deltaDays));
}

function windToMph(value, uom) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const unit = safeStr(uom).toLowerCase();
  if (unit.includes("km_h")) return v * 0.621371;
  if (unit.includes("m_s")) return v * 2.23694;
  return v;
}

function pickShortForecast(popMax, skyAvg) {
  const pop = Number(popMax);
  const sky = Number(skyAvg);
  if (Number.isFinite(pop) && pop >= 60) return "Rain Likely";
  if (Number.isFinite(pop) && pop >= 30) return "Chance Rain";
  if (Number.isFinite(sky) && sky >= 80) return "Cloudy";
  if (Number.isFinite(sky) && sky >= 55) return "Mostly Cloudy";
  if (Number.isFinite(sky) && sky >= 30) return "Partly Cloudy";
  return "Mostly Sunny";
}

function summarizeGridDay(seriesValues, dayYmd, timeZone) {
  const values = [];
  for (const item of (Array.isArray(seriesValues) ? seriesValues : [])) {
    const interval = parseNwsValidTime(item?.validTime);
    if (!interval) continue;
    const midMs = interval.startMs + (interval.endMs - interval.startMs) / 2;
    if (ymdInTimeZone(timeZone, new Date(midMs)) !== dayYmd) continue;
    const v = Number(item?.value);
    if (Number.isFinite(v)) values.push(v);
  }
  return values;
}

function fetchNbmExtendedDailyFromGrid({ gridProperties, timeZone, day0Ymd }) {
  const gp = gridProperties || {};
  const days = [];
  for (let offset = 7; offset <= 13; offset += 1) {
    const day = isoDayShift(day0Ymd, offset);
    if (!day) continue;

    const tempsC = summarizeGridDay(gp?.temperature?.values, day, timeZone);
    const popVals = summarizeGridDay(gp?.probabilityOfPrecipitation?.values, day, timeZone);
    const skyVals = summarizeGridDay(gp?.skyCover?.values, day, timeZone);
    const windVals = summarizeGridDay(gp?.windSpeed?.values, day, timeZone);

    const tempMaxF = tempsC.length ? Math.round(cToF(Math.max(...tempsC))) : null;
    const tempMinF = tempsC.length ? Math.round(cToF(Math.min(...tempsC))) : null;
    const popMax = popVals.length ? clamp(Math.round(Math.max(...popVals)), 0, 100) : null;
    const skyAvg = skyVals.length ? (skyVals.reduce((a, b) => a + b, 0) / skyVals.length) : null;

    const windMphSamples = windVals
      .map((v) => windToMph(v, gp?.windSpeed?.uom))
      .filter((v) => Number.isFinite(v));
    const windMph = windMphSamples.length ? Math.round(Math.max(...windMphSamples)) : null;

    if (tempMaxF === null && tempMinF === null && popMax === null && skyAvg === null) {
      continue;
    }

    days.push({
      number: 2000 + offset,
      name: formatWeekdayName(day, timeZone),
      startTime: `${day}T12:00:00Z`,
      endTime: `${day}T23:59:59Z`,
      isDaytime: true,
      temperature: tempMaxF,
      overnightLow: tempMinF,
      temperatureUnit: "F",
      windSpeed: Number.isFinite(windMph) ? `${windMph} mph` : "",
      windDirection: "",
      shortForecast: pickShortForecast(popMax, skyAvg),
      detailedForecast: "Extended guidance from NBM grid data.",
      probabilityOfPrecipitation: {
        unitCode: "wmoUnit:percent",
        value: popMax,
      },
      _source: "nbm-grid",
    });
  }
  return days;
}

async function fetchOpenMeteoExtendedDailyForecast({ lat, lon, timeZone }) {
  const source = { provider: "open-meteo-forecast", product: "14-day-daily" };

  const la2 = round2(lat);
  const lo2 = round2(lon);
  if (la2 === null || lo2 === null) {
    return { ok: false, periods: [], source: { ...source, ok: false, reason: "invalid lat/lon" } };
  }

  const tz = safeStr(timeZone) || "UTC";

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${encodeURIComponent(String(la2))}` +
      `&longitude=${encodeURIComponent(String(lo2))}` +
      `&temperature_unit=fahrenheit` +
      `&wind_speed_unit=mph` +
      `&precipitation_unit=inch` +
      `&forecast_days=14` +
      `&timezone=${encodeURIComponent(tz)}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,weather_code`;

    const om = await fetchJson(url, {}, 3200);

    const days = Array.isArray(om?.daily?.time) ? om.daily.time : [];
    const maxTemps = Array.isArray(om?.daily?.temperature_2m_max) ? om.daily.temperature_2m_max : [];
    const minTemps = Array.isArray(om?.daily?.temperature_2m_min) ? om.daily.temperature_2m_min : [];
    const popMaxVals = Array.isArray(om?.daily?.precipitation_probability_max) ? om.daily.precipitation_probability_max : [];
    const windMaxVals = Array.isArray(om?.daily?.wind_speed_10m_max) ? om.daily.wind_speed_10m_max : [];
    const weatherCodes = Array.isArray(om?.daily?.weather_code) ? om.daily.weather_code : [];

    const periods = [];
    for (let i = 0; i < days.length; i += 1) {
      const day = safeStr(days[i]);
      if (!day) continue;

      const maxF = toFiniteNum(maxTemps[i]);
      const minF = toFiniteNum(minTemps[i]);
      const pop = toFiniteNum(popMaxVals[i]);
      const wind = toFiniteNum(windMaxVals[i]);
      const weatherCode = toFiniteNum(weatherCodes[i]);

      periods.push({
        number: 3000 + i,
        name: formatWeekdayName(day, tz),
        startTime: `${day}T12:00:00Z`,
        endTime: `${day}T23:59:59Z`,
        isDaytime: true,
        temperature: maxF === null ? null : Math.round(maxF),
        overnightLow: minF === null ? null : Math.round(minF),
        temperatureUnit: "F",
        windSpeed: Number.isFinite(wind) ? `${Math.round(wind)} mph` : "",
        windDirection: "",
        shortForecast: weatherCodeToShortForecast(weatherCode),
        detailedForecast: "Extended outlook from Open-Meteo daily forecast.",
        probabilityOfPrecipitation: {
          unitCode: "wmoUnit:percent",
          value: Number.isFinite(pop) ? clamp(Math.round(pop), 0, 100) : null,
        },
        _source: "open-meteo-extended",
      });
    }

    return {
      ok: true,
      periods,
      sourceDataAt: pickFirstIsoString(om?.daily?.time?.[0], new Date().toISOString()),
      source: { ...source, ok: true },
    };
  } catch (e) {
    return {
      ok: false,
      periods: [],
      sourceDataAt: null,
      source: { ...source, ok: false, status: e.status || 502, reason: e.message || "fetch failed", bodySnippet: e.bodySnippet },
    };
  }
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
    let max6hAt = null;
    let latest = null;
    let latestAt = null;
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
          latestAt = times[i];
        }

        // Track max over last 6 hours
        if (tMs <= nowMs && tMs >= (nowMs - sixHMs)) {
          if (max6h === null || v > max6h) {
            max6h = v;
            max6hAt = times[i];
          }
        }
      }
    }

    const picked = (max6h !== null) ? max6h : (latest !== null ? latest : null);

    const payload = {
      ok: Number.isFinite(picked),
      soilMoisture0To7cm: Number.isFinite(picked) ? picked : null,
      unit: "m3/m3",
      method: (max6h !== null) ? "max_last_6h" : (latest !== null ? "latest_non_null_48h" : "none"),
      sourceDataAt: (max6h !== null) ? max6hAt : latestAt,
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
      sourceDataAt: null,
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
      return { ok: false, sourceDataAt: null, source: { ...source, ok: false, reason: "api error" } };
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
      sourceDataAt: `${date}T00:00:00`,
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
      sourceDataAt: null,
      source: { ...source, ok: false, status: e.status || 502, reason: e.message, bodySnippet: e.bodySnippet },
    };
  }
}

function getUtcHourOfYear(dateObj = new Date()) {
  const year = dateObj.getUTCFullYear();
  const startUtcMs = Date.UTC(year, 0, 1, 0, 0, 0);
  const elapsedMs = dateObj.getTime() - startUtcMs;
  const elapsedHours = Math.floor(elapsedMs / (60 * 60 * 1000));
  const hourOfYear = elapsedHours + 1;
  const wrappedHour = ((hourOfYear - 1) % 8760) + 1;

  return {
    year,
    frame: String(wrappedHour).padStart(4, "0"),
    hourBucket: elapsedHours,
  };
}

function toMoonIlluminationPct(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  const pct = v <= 1 ? v * 100 : v;
  return clamp(pct, 0, 100);
}

function isDescriptiveMoonPhase(value) {
  const phase = safeStr(value);
  if (!phase) return false;
  if (!/[a-z]/i.test(phase)) return false;
  return /(wax|wan|new|full|quarter|crescent|gibbous)/i.test(phase);
}

function findNasaMoonRecord(rows, frame) {
  if (!Array.isArray(rows) || !rows.length) return null;

  const byFrameValue = rows.find((row) => {
    const frameCandidate = String(row?.frame ?? row?.index ?? "").padStart(4, "0");
    return frameCandidate === frame;
  });
  if (byFrameValue) return byFrameValue;

  const byFilename = rows.find((row) => {
    const imageName = safeStr(row?.image || row?.file || row?.filename || row?.name);
    return imageName.includes(`.${frame}.`);
  });
  if (byFilename) return byFilename;

  const idx = Number(frame) - 1;
  if (Number.isInteger(idx) && idx >= 0 && idx < rows.length) return rows[idx];

  return null;
}

async function fetchNasaMoonData() {
  const source = { provider: "nasa-svs-5587" };
  const now = new Date();
  const { year, frame, hourBucket } = getUtcHourOfYear(now);
  const cacheKeyUrl =
    `https://cache.almanacweather.com/nasa-moon` +
    `?year=${encodeURIComponent(String(year))}` +
    `&hour=${encodeURIComponent(String(hourBucket))}`;

  try {
    const cache = caches.default;
    const cacheReq = new Request(cacheKeyUrl, { method: "GET" });
    const cached = await cache.match(cacheReq);
    if (cached) {
      return await cached.json();
    }

    const moonInfoUrl = `${NASA_MOON_JSON_BASE_URL}/mooninfo_${year}.json`;
    const rows = await fetchJson(moonInfoUrl, {}, 3800);
    const record = findNasaMoonRecord(rows, frame);

    const moonPhase = safeStr(record?.phase || record?.phaseName || record?.curphase);
    const moonIlluminationPct = toMoonIlluminationPct(
      record?.fracillum ?? record?.illumination ?? record?.illumination_pct ?? record?.fraction_illuminated
    );

    const sourceImage = safeStr(record?.image || record?.file || record?.filename || record?.name);
    const moonImageUrl = sourceImage
      ? `${NASA_MOON_JSON_BASE_URL}/${sourceImage.replace(/^\/+/, "")}`
      : `${NASA_MOON_FRAME_BASE_URL}.${frame}.jpg`;

    const payload = {
      ok: true,
      frame,
      year,
      moonImageUrl,
      moonPhase: moonPhase || null,
      moonIlluminationPct,
      sourceDataAt: `${year}-01-01T00:00:00Z`,
      source: { ...source, ok: true },
    };

    const resp = new Response(JSON.stringify(payload), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
    await cache.put(cacheReq, resp.clone());

    return payload;
  } catch (e) {
    return {
      ok: false,
      frame,
      year,
      moonImageUrl: `${NASA_MOON_FRAME_BASE_URL}.${frame}.jpg`,
      moonPhase: null,
      moonIlluminationPct: null,
      sourceDataAt: null,
      source: { ...source, ok: false, status: e.status || 502, reason: e.message || "fetch failed", bodySnippet: e.bodySnippet },
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
    fetchNasaMoonData(),
    fetchUvCombined({ lat: la, lon: lo, timeZone }),
    fetchOpenMeteoSoilArchive({ lat: la, lon: lo }), // ✅ Archive soil moisture + max 6h (cached)
    fetchOpenMeteoExtendedDailyForecast({ lat: la, lon: lo, timeZone }),
  ]);

  const [dailyRes, hourlyRes, gridRes, alertsRes, astroRes, nasaMoonRes, uvRes, soilRes, extendedRes] = fetches;
  const fetchedAtIso = new Date().toISOString();

  if (dailyRes.status !== "fulfilled" || hourlyRes.status !== "fulfilled") {
    return jsonResponse({ error: "Failed to fetch forecast data" }, 502);
  }

  const dailyJson = dailyRes.value;
  const hourlyJson = hourlyRes.value;

  const forecastSourceAt = pickFirstIsoString(
    dailyJson?.properties?.updateTime,
    dailyJson?.properties?.generatedAt,
    fetchedAtIso,
  );
  const hourlySourceAt = pickFirstIsoString(
    hourlyJson?.properties?.updateTime,
    hourlyJson?.properties?.generatedAt,
    fetchedAtIso,
  );
  const gridSourceAt = (gridRes.status === "fulfilled")
    ? pickFirstIsoString(
      gridRes.value?.properties?.updateTime,
      fetchedAtIso,
    )
    : null;
  const alertsSourceAt = (alertsRes.status === "fulfilled")
    ? pickFirstIsoString(latestAlertSourceTime(alertsRes.value), fetchedAtIso)
    : null;
  const astroSourceAt = (astroRes.status === "fulfilled")
    ? pickFirstIsoString(
      astroRes.value?.sourceDataAt,
      astroRes.value?.date,
    )
    : null;
  const nasaMoonSourceAt = (nasaMoonRes.status === "fulfilled")
    ? pickFirstIsoString(nasaMoonRes.value?.sourceDataAt)
    : null;
  const uvSourceAt = (uvRes.status === "fulfilled")
    ? pickFirstIsoString(
      uvRes.value?.sourceDataAt,
      uvRes.value?.hourly?.[0]?.day,
    )
    : null;
  const soilSourceAt = (soilRes.status === "fulfilled") ? pickFirstIsoString(soilRes.value?.sourceDataAt) : null;
  const extendedSourceAt = (extendedRes.status === "fulfilled")
    ? pickFirstIsoString(extendedRes.value?.sourceDataAt)
    : null;

  const hourlyPeriods = Array.isArray(hourlyJson?.properties?.periods) ? hourlyJson.properties.periods : [];
  const dailyPeriods = Array.isArray(dailyJson?.properties?.periods) ? [...dailyJson.properties.periods] : [];
  const day0Ymd = dailyPeriods.length ? safeStr(dailyPeriods[0]?.startTime).slice(0, 10) : "";
  const extendedDailyPeriods = (gridRes.status === "fulfilled" && gridRes.value?.properties && day0Ymd)
    ? fetchNbmExtendedDailyFromGrid({
      gridProperties: gridRes.value.properties,
      timeZone,
      day0Ymd,
    })
    : [];
  if (extendedDailyPeriods.length) {
    dailyPeriods.push(...extendedDailyPeriods);
  }

  if (extendedRes.status === "fulfilled" && extendedRes.value?.ok) {
    const existingDays = new Set(
      dailyPeriods
        .filter((p) => p && p.isDaytime)
        .map((p) => safeStr(p?.startTime).slice(0, 10))
        .filter(Boolean),
    );

    const openMeteoPeriods = Array.isArray(extendedRes.value?.periods) ? extendedRes.value.periods : [];
    const missingExtended = openMeteoPeriods.filter((p) => {
      const ymd = safeStr(p?.startTime).slice(0, 10);
      return ymd && !existingDays.has(ymd);
    });

    if (missingExtended.length) {
      dailyPeriods.push(...missingExtended);
    }
  }

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
          description: p.description,
          instruction: p.instruction,
          ends: p.ends,
          effective: p.effective,
        }));
    }
  }

  const outlook = { periods: dailyPeriods.slice(0, 2) };

  // Grid-derived metrics sampled at period midpoint (daily + hourly)
  let periodMetrics = {};
  let hourlyMetrics = {};
  if (gridRes.status === "fulfilled" && gridRes.value?.properties) {
    const gp = gridRes.value.properties;

    const dewSeries = gp?.dewpoint?.values;
    const rhSeries = gp?.relativeHumidity?.values;
    const skySeries = gp?.skyCover?.values;
    const apparentSeries = gp?.apparentTemperature?.values;

    const metricForMidpoint = (period) => {
      const startMs = Date.parse(period?.startTime);
      const endMs = Date.parse(period?.endTime);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

      const midMs = startMs + (endMs - startMs) / 2;
      const out = {};

      const dewC = valueAt(dewSeries, midMs);
      const rh = valueAt(rhSeries, midMs);
      const sky = valueAt(skySeries, midMs);
      const apparentC = valueAt(apparentSeries, midMs);

      if (isFiniteNum(dewC)) out.dewpointF = cToF(dewC);
      if (isFiniteNum(rh)) out.relativeHumidityPct = clamp(rh, 0, 100);
      if (isFiniteNum(sky)) out.skyCoverPct = clamp(sky, 0, 100);
      if (isFiniteNum(apparentC)) out.apparentTempF = cToF(apparentC);

      return Object.keys(out).length ? out : null;
    };

    for (const p of dailyPeriods) {
      const out = metricForMidpoint(p);
      if (out) periodMetrics[String(p.number)] = out;
    }

    for (const p of hourlyPeriods) {
      const out = metricForMidpoint(p);
      if (out) hourlyMetrics[String(p.number)] = out;
    }
  }

  // Astro & UV
  const astro = (astroRes.status === "fulfilled" && astroRes.value?.ok) ? astroRes.value : (astroRes.status === "fulfilled" ? astroRes.value : null);
  const nasaMoon = (nasaMoonRes.status === "fulfilled" && nasaMoonRes.value) ? nasaMoonRes.value : null;
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
    hourlyMetrics,
    alerts,

    astro: astro && astro.ok ? {
      sunrise: astro.sunrise,
      sunset: astro.sunset,
      moonrise: astro.moonrise,
      moonset: astro.moonset,
      moonPhase: (nasaMoon?.ok && isDescriptiveMoonPhase(nasaMoon.moonPhase)) ? nasaMoon.moonPhase : astro.moonPhase,
      moonIlluminationPct: isFiniteNum(astro.moonIlluminationPct)
        ? astro.moonIlluminationPct
        : (nasaMoon?.ok && isFiniteNum(nasaMoon.moonIlluminationPct) ? nasaMoon.moonIlluminationPct : null),
      moonImageUrl: nasaMoon?.moonImageUrl || null,
      moonFrame: nasaMoon?.frame || null,
      isDaytimeNow: astro.isDaytimeNow,
    } : (astro ? { ...astro, ok: false } : null),

    uv: uv ? uv : null,

    soil: soil ? soil : null,

    refreshMeta: {
      sourceTimes: [
        { source: "NOAA Forecast", pulledAt: forecastSourceAt, ok: dailyRes.status === "fulfilled" },
        { source: "NOAA Hourly", pulledAt: hourlySourceAt, ok: hourlyRes.status === "fulfilled" },
        { source: "NOAA Grid", pulledAt: gridSourceAt, ok: gridRes.status === "fulfilled" },
        { source: "NOAA Alerts", pulledAt: alertsSourceAt, ok: alertsRes.status === "fulfilled" },
        { source: "USNO Astro", pulledAt: astroSourceAt, ok: astroRes.status === "fulfilled" && !!astroRes.value?.ok },
        {
          source: "NASA Moon",
          pulledAt: nasaMoonSourceAt,
          ok: nasaMoonRes.status === "fulfilled" && !!nasaMoonRes.value?.ok,
          reason: nasaMoonRes.status === "fulfilled" ? safeStr(nasaMoonRes.value?.source?.reason) : "fetch failed",
          status: nasaMoonRes.status === "fulfilled" ? nasaMoonRes.value?.source?.status : null,
        },
        {
          source: "Open-Meteo UV",
          pulledAt: uvSourceAt,
          ok: uvRes.status === "fulfilled" && !!uvRes.value?.ok,
          reason: uvRes.status === "fulfilled" ? safeStr(uvRes.value?.source?.reason) : "fetch failed",
          status: uvRes.status === "fulfilled" ? uvRes.value?.source?.status : null,
        },
        { source: "Open-Meteo Soil", pulledAt: soilSourceAt, ok: soilRes.status === "fulfilled" && !!soilRes.value?.ok },
        {
          source: "Open-Meteo Extended",
          pulledAt: extendedSourceAt,
          ok: extendedRes.status === "fulfilled" && !!extendedRes.value?.ok,
          reason: extendedRes.status === "fulfilled" ? safeStr(extendedRes.value?.source?.reason) : "fetch failed",
          status: extendedRes.status === "fulfilled" ? extendedRes.value?.source?.status : null,
        },
      ],
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === "/api/track" && request.method === "POST") {
        return await handleTrackEvent(request, env);
      }
      if (url.pathname === "/api/track/export" && request.method === "GET") {
        return await handleExportEvents(request, env);
      }

      if (request.method !== "GET") {
        return textResponse("Method Not Allowed", 405);
      }

      // ✅ Simple health check to confirm the GitHub-deployed Worker is live
      if (url.pathname === "/api/health") {
        return jsonResponse({ ok: true, worker: "noaa-friendly-weather", source: "github" });
      }

      if (url.pathname === "/api/location/suggest") {
        const query = url.searchParams.get("q");
        return await handleLocationSuggest(query);
      }

      if (url.pathname === "/api/location") {
        const query = url.searchParams.get("q") || url.searchParams.get("zip");
        return await handleLocation(query);
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
