/* Almanac Weather - Frontend (Pages)
   - Calls same-origin Worker routes (/api/*) by default
   - Renders: Current, Outlook, Shoe, Sun & Moon (+UV), Hourly, Daily
 */

const els = {
  statusBar: document.getElementById("statusBar"),
  locationLabel: document.getElementById("locationLabel"),

  zipForm: document.getElementById("zipForm"),
  zipInput: document.getElementById("zipInput"),
  zipBtn: document.getElementById("zipBtn"),
  locationSuggestions: document.getElementById("locationSuggestions"),

  currentCard: document.getElementById("currentCard"),
  currentContent: document.getElementById("currentContent"),
  alertsCard: document.getElementById("alertsCard"),
  alertsContent: document.getElementById("alertsContent"),

  todayCard: document.getElementById("todayCard"),
  todayContent: document.getElementById("todayContent"),

  windCard: document.getElementById("windCard"),
  windContent: document.getElementById("windContent"),

  // ✅ Shoe
  shoeCard: document.getElementById("shoeCard"),
  shoeContent: document.getElementById("shoeContent"),

  earthCard: document.getElementById("earthCard"),
  earthContent: document.getElementById("earthContent"),

  astroUvCard: document.getElementById("astroUvCard"),
  astroUvContent: document.getElementById("astroUvContent"),

  hourlyCard: document.getElementById("hourlyCard"),
  hourlyContent: document.getElementById("hourlyContent"),
  graphsCard: document.getElementById("graphsCard"),
  graphsContent: document.getElementById("graphsContent"),

  dailyCard: document.getElementById("dailyCard"),
  dailyContent: document.getElementById("dailyContent"),
};

const STORAGE_KEYS = {
  search: "aw_search",
  lastLat: "aw_lat",
  lastLon: "aw_lon",
  label: "aw_label",
  userId: "aw_uid",
};

let expandedTile = null;
let scrollCollapseTimer = null;
let suggestionItems = [];
let suggestionActiveIndex = -1;
let suggestionFetchTimer = null;
let suggestionAbortController = null;
let hourlyVisibleCount = 24;
let selectedGraphMetric = "precipitation";
const GRAPH_DEFAULT_VISIBLE_HOURS = 8;
let graphOutsideClickHandler = null;
let earthRefreshTimer = null;

const EARTH_SATELLITE_REFRESH_MS = 10 * 60 * 1000;
const EARTH_SATELLITE_BASE_URL = "https://cdn.star.nesdis.noaa.gov/GOES16/ABI/FD/GEOCOLOR/1808x1808.jpg";
const EARTH_TILE_FALLBACK_MAX_HEIGHT_PX = 380;

const HOURLY_INITIAL_COUNT = 24;
const HOURLY_LOAD_STEP = 24;
const DAILY_DAYS_VISIBLE = 14;
const DAILY_INITIAL_VISIBLE = 7;
let dailyExpanded = false;
let compassHeadingCleanup = null;

const WIND_DIRECTION_TO_DEG = {
  N: 0,
  NNE: 22.5,
  NE: 45,
  ENE: 67.5,
  E: 90,
  ESE: 112.5,
  SE: 135,
  SSE: 157.5,
  S: 180,
  SSW: 202.5,
  SW: 225,
  WSW: 247.5,
  W: 270,
  WNW: 292.5,
  NW: 315,
  NNW: 337.5,
};

function getWorkerBaseUrl() {
  const meta = document.querySelector('meta[name="worker-base-url"]');
  const v = meta?.getAttribute("content")?.trim();
  return v ? v.replace(/\/+$/, "") : "";
}

function getApiBaseCandidates() {
  const workerBase = getWorkerBaseUrl();
  if (workerBase) return [workerBase];

  const host = window.location.hostname || "";
  const isPreviewHost =
    host.includes("pages.dev") ||
    host.includes("localhost") ||
    host.includes("127.0.0.1") ||
    host.includes("codex") ||
    host.includes("github");

  const bases = [""];
  if (isPreviewHost) bases.push("https://www.almanacweather.com");
  return [...new Set(bases)];
}

const API_BASE_CANDIDATES = getApiBaseCandidates();

function apiUrl(path, params = {}, base = API_BASE_CANDIDATES[0] || "") {
  const u = new URL(`${base}${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).length) u.searchParams.set(k, v);
  }
  return u.toString();
}

function shouldTryNextApiBase(statusCode) {
  return statusCode === 404 || statusCode === 405;
}


function getAnonymousUserId() {
  let id = safeText(localStorage.getItem(STORAGE_KEYS.userId));
  if (id) return id;
  id = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `uid_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(STORAGE_KEYS.userId, id);
  return id;
}

function getSessionId() {
  const key = "aw_session_id";
  let sid = safeText(sessionStorage.getItem(key));
  if (sid) return sid;
  sid = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  sessionStorage.setItem(key, sid);
  return sid;
}

function detectDeviceType() {
  const ua = (navigator.userAgent || "").toLowerCase();
  if (/mobile|iphone|android/.test(ua)) return "mobile";
  if (/ipad|tablet/.test(ua)) return "tablet";
  return "desktop";
}

function trackEvent(eventType, payload = {}) {
  const body = {
    eventType,
    userId: getAnonymousUserId(),
    sessionId: getSessionId(),
    page: window.location.pathname,
    deviceType: detectDeviceType(),
    ...payload,
  };

  fetch(apiUrl("/api/track"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}

async function apiFetch(path, params = {}, init = {}) {
  let lastError = null;
  for (let i = 0; i < API_BASE_CANDIDATES.length; i += 1) {
    const base = API_BASE_CANDIDATES[i];
    try {
      const res = await fetch(apiUrl(path, params, base), init);
      if (res.ok) return res;
      const hasMoreBases = i < API_BASE_CANDIDATES.length - 1;
      if (hasMoreBases && shouldTryNextApiBase(res.status)) continue;
      return res;
    } catch (err) {
      lastError = err;
      const hasMoreBases = i < API_BASE_CANDIDATES.length - 1;
      if (hasMoreBases) continue;
    }
  }

  throw lastError || new Error(`Request failed for ${path}`);
}

function setStatus(msg) {
  els.statusBar.textContent = msg || "";
}

function setLocationLabel(label) {
  els.locationLabel.textContent = safeText(label);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeText(s) {
  return (s ?? "").toString().trim();
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function formatTempF(n) {
  const t = toInt(n);
  return t === null ? "—" : `${t}°`; // ✅ no "F"
}

function parseWind(dir, speedStr) {
  const d = safeText(dir);
  const s = safeText(speedStr);
  if (!d && !s) return "";
  return `${s}${d ? ` ${d}` : ""}`.trim();
}

function stripChanceOfPrecipSentence(text) {
  let t = safeText(text);
  t = t.replace(/\s*Chance of precipitation is\s*\d+%\.?\s*/gi, " ");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

function stripWindFromForecastText(text) {
  const sentences = safeText(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map((sentence) => {
      if (!/\bwind\b/i.test(sentence)) return sentence;
      if (!/\bgusts?\b/i.test(sentence)) return "";

      let updated = sentence
        .replace(/(?:,\s*)?with\s+(?:an?\s+)?(?:[a-z-]+\s+)*wind\s+\d+(?:\s*to\s*\d+)?\s*mph\b/gi, "")
        .replace(/\b(?:[a-z-]+\s+)*wind\s+\d+(?:\s*to\s*\d+)?\s*mph\b/gi, "")
        .replace(/\s+,/g, ",")
        .replace(/,\s*,/g, ",")
        .replace(/\s{2,}/g, " ")
        .replace(/^,\s*/, "")
        .trim();

      if (!updated) return "";
      if (!/[.!?]$/.test(updated)) updated = `${updated}.`;
      return updated;
    })
    .filter(Boolean);

  return sentences.join(" ").replace(/\s{2,}/g, " ").trim();
}

function extractPopPercent(period) {
  const v = period?.probabilityOfPrecipitation?.value;
  if (typeof v === "number") return clamp(Math.round(v), 0, 100);

  const combined = `${safeText(period?.detailedForecast)} ${safeText(period?.shortForecast)}`;
  const m = combined.match(/Chance of precipitation is\s*(\d+)%/i);
  if (m) return clamp(Number(m[1]), 0, 100);

  return null;
}

function formatDateShort(iso, timeZone) {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || undefined,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(d);
  } catch {
    return "";
  }
}

function formatPercent(value) {
  return `${Math.round(value)}%`;
}

function extractWindMph(windSpeed) {
  const raw = safeText(windSpeed);
  if (!raw) return null;
  const m = raw.match(/(\d+(?:\.\d+)?)(?!.*\d)/);
  if (!m) return null;
  const mph = Number(m[1]);
  return Number.isFinite(mph) ? Math.round(mph) : null;
}

function parseWindDirectionDegrees(value) {
  const raw = safeText(value).toUpperCase();
  if (!raw) return null;

  if (Object.prototype.hasOwnProperty.call(WIND_DIRECTION_TO_DEG, raw)) {
    return WIND_DIRECTION_TO_DEG[raw];
  }

  const deg = Number(raw.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(deg)) return null;
  return ((deg % 360) + 360) % 360;
}

function parseWindGustMph(gustValue) {
  const raw = safeText(gustValue);
  if (!raw) return null;
  const m = raw.match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const mph = Number(m[0]);
  return Number.isFinite(mph) ? Math.round(mph) : null;
}

function parseFiniteNumberAttr(value) {
  const raw = safeText(value);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function buildWindTile(data) {
  const current = data?.current || null;
  const fallback = Array.isArray(data?.outlook?.periods) ? data.outlook.periods[0] : null;

  const windSpeedMph = extractWindMph(current?.windSpeed) ?? extractWindMph(fallback?.windSpeed);
  const windDirection = safeText(current?.windDirection || fallback?.windDirection);
  const windDirectionDeg = parseWindDirectionDegrees(windDirection);
  const gustMph = parseWindGustMph(current?.windGust || fallback?.windGust);

  if (!Number.isFinite(windSpeedMph) && !windDirection) return "";

  const directionLabel = windDirection || "—";
  const speedLabel = Number.isFinite(windSpeedMph) ? `${windSpeedMph} mph` : "—";
  const gustLine = Number.isFinite(gustMph)
    ? `<div class="wind-tile-gust">Gusts ${gustMph} mph</div>`
    : "";
  const directionDegAttr = Number.isFinite(windDirectionDeg) ? String(windDirectionDeg) : "";
  const arrowStyle = Number.isFinite(windDirectionDeg)
    ? `style="transform:translateX(-50%) rotate(${windDirectionDeg}deg);"`
    : "";

  return `
    <button class="wind-tile" type="button" data-open-wind-compass="true" data-wind-direction="${directionLabel}" data-wind-direction-deg="${directionDegAttr}">
      <div class="wind-tile-main">
        <div class="wind-tile-preview" aria-hidden="true">
          <span class="wind-tile-ring"></span>
          <span class="wind-tile-mark wind-tile-mark-n">N</span>
          <span class="wind-tile-mark wind-tile-mark-e">E</span>
          <span class="wind-tile-mark wind-tile-mark-s">S</span>
          <span class="wind-tile-mark wind-tile-mark-w">W</span>
          <span class="wind-tile-arrow" ${arrowStyle}></span>
          <span class="wind-tile-core"></span>
        </div>
        <div class="wind-tile-values">
          <div class="wind-tile-speed">${speedLabel}</div>
          ${gustLine}
        </div>
      </div>
      <div class="wind-tile-head">Tap for live compass</div>
    </button>
  `;
}

function stopCompassTracking() {
  if (typeof compassHeadingCleanup === "function") {
    compassHeadingCleanup();
    compassHeadingCleanup = null;
  }
}

function startCompassTracking(compassEl, statusEl, windDirectionDeg = null) {
  stopCompassTracking();

  const compassDial = compassEl?.querySelector("[data-compass-dial='true']");
  const windArrow = compassEl?.querySelector("[data-compass-wind-arrow='true']");
  const headingArrow = compassEl?.querySelector("[data-compass-heading-arrow='true']");
  if (!compassDial || !windArrow || !headingArrow) return;

  windArrow.style.transform = Number.isFinite(windDirectionDeg)
    ? `translateX(-50%) rotate(${windDirectionDeg}deg)`
    : "translateX(-50%) rotate(0deg)";
  windArrow.hidden = !Number.isFinite(windDirectionDeg);

  const updateHeading = (heading) => {
    if (!Number.isFinite(heading)) return;
    const normalized = ((heading % 360) + 360) % 360;
    compassDial.style.transform = `rotate(${-normalized}deg)`;
    headingArrow.style.transform = "translateX(-50%) rotate(0deg)";
    if (Number.isFinite(windDirectionDeg)) {
      const windRelativeDeg = ((windDirectionDeg - normalized) % 360 + 360) % 360;
      windArrow.style.transform = `translateX(-50%) rotate(${windRelativeDeg}deg)`;
    }
    if (statusEl) statusEl.textContent = `Top of compass is your heading: ${Math.round(normalized)}°`;
  };

  const bindAbsoluteOrientation = () => {
    const handler = (event) => {
      const heading = Number.isFinite(event?.webkitCompassHeading)
        ? event.webkitCompassHeading
        : (Number.isFinite(event?.alpha) ? 360 - event.alpha : null);
      updateHeading(heading);
    };
    window.addEventListener("deviceorientationabsolute", handler, true);
    return () => window.removeEventListener("deviceorientationabsolute", handler, true);
  };

  const bindOrientation = () => {
    const handler = (event) => {
      const heading = Number.isFinite(event?.webkitCompassHeading)
        ? event.webkitCompassHeading
        : (Number.isFinite(event?.alpha) ? 360 - event.alpha : null);
      updateHeading(heading);
    };
    window.addEventListener("deviceorientation", handler, true);
    return () => window.removeEventListener("deviceorientation", handler, true);
  };

  const start = async () => {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      try {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission !== "granted") {
          if (statusEl) statusEl.textContent = "Compass permission denied.";
          return;
        }
      } catch {
        if (statusEl) statusEl.textContent = "Compass permission unavailable.";
        return;
      }
    }

    const cleanupAbsolute = bindAbsoluteOrientation();
    const cleanupFallback = bindOrientation();
    compassHeadingCleanup = () => {
      cleanupAbsolute();
      cleanupFallback();
    };
  };

  start();
}

function setupWindCompassModal() {
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-open-wind-compass='true']");
    const modal = document.querySelector("[data-wind-compass-modal='true']");
    if (!modal) return;

    if (trigger) {
      const direction = safeText(trigger.getAttribute("data-wind-direction"));
      const directionDeg = parseFiniteNumberAttr(trigger.getAttribute("data-wind-direction-deg"));
      const directionLabelEl = modal.querySelector("[data-wind-direction-label='true']");
      const statusEl = modal.querySelector("[data-compass-status='true']");
      const compassEl = modal.querySelector("[data-compass='true']");

      if (directionLabelEl) directionLabelEl.textContent = direction || "—";
      if (statusEl) statusEl.textContent = "Move your phone to calibrate compass…";

      modal.hidden = false;
      document.body.classList.add("is-modal-open");
      startCompassTracking(compassEl, statusEl, directionDeg);
      return;
    }

    if (event.target.closest("[data-close-wind-compass='true']") || event.target === modal) {
      modal.hidden = true;
      document.body.classList.remove("is-modal-open");
      stopCompassTracking();
    }
  });
}


function getDayKey(iso, timeZone) {
  try {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const y = parts.find((part) => part.type === "year")?.value;
    const m = parts.find((part) => part.type === "month")?.value;
    const da = parts.find((part) => part.type === "day")?.value;
    return y && m && da ? `${y}-${m}-${da}` : "";
  } catch {
    return "";
  }
}


function detailRowsHtml(rows) {
  const visible = rows.filter((row) => {
    const value = row?.value;
    if (typeof value === "number") return Number.isFinite(value);
    return safeText(value).length > 0;
  });
  if (!visible.length) return "";

  return `<div class="tile-details-rows">${visible
    .map(r => `<div class="tile-detail-row"><span class="tile-detail-label">${r.label}</span><span class="tile-detail-value tile-detail-value-fixed">${r.formatter(r.value)}</span></div>`)
    .join("")}</div>`;
}

function getPeriodMetrics(metrics, periodNumber) {
  if (!metrics || periodNumber === undefined || periodNumber === null) return null;
  return metrics[String(periodNumber)] || metrics[periodNumber] || null;
}

function isNativeInteractiveTarget(target) {
  return !!target?.closest?.("button, a, input, select, textarea, summary, [contenteditable='true']");
}

function setExpandedTile(nextTile) {
  if (expandedTile && expandedTile !== nextTile) {
    expandedTile.classList.remove("is-expanded");
    expandedTile.setAttribute("aria-expanded", "false");
  }

  if (!nextTile) {
    expandedTile = null;
    return;
  }

  const isExpanding = !nextTile.classList.contains("is-expanded");
  nextTile.classList.toggle("is-expanded", isExpanding);
  nextTile.setAttribute("aria-expanded", isExpanding ? "true" : "false");
  expandedTile = isExpanding ? nextTile : null;
}

function setupExpandableTiles() {
  document.addEventListener("click", (e) => {
    const tile = e.target.closest("[data-expandable='true']");
    if (!tile) return;
    if (isNativeInteractiveTarget(e.target)) return;
    if (e.target.closest(".tile-details")) return;
    if (e.target.closest(".shoe-info-btn") || e.target.closest(".shoe-popover")) return;
    setExpandedTile(tile);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tile = e.target.closest("[data-expandable='true']");
    if (!tile) return;
    if (isNativeInteractiveTarget(e.target)) return;
    e.preventDefault();
    setExpandedTile(tile);
  });

  const collapseOnScroll = () => {
    if (scrollCollapseTimer) clearTimeout(scrollCollapseTimer);
    scrollCollapseTimer = setTimeout(() => setExpandedTile(null), 150);
  };

  window.addEventListener("scroll", collapseOnScroll, { passive: true });
  window.addEventListener("wheel", collapseOnScroll, { passive: true });
  window.addEventListener("touchmove", collapseOnScroll, { passive: true });
}


function setupFlippableCards() {
  document.addEventListener("click", (e) => {
    const card = e.target.closest("[data-flippable='true']");
    if (!card) return;
    const next = !card.classList.contains("is-flipped");
    card.classList.toggle("is-flipped", next);
    card.setAttribute("aria-pressed", next ? "true" : "false");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest("[data-flippable='true']");
    if (!card) return;
    e.preventDefault();
    const next = !card.classList.contains("is-flipped");
    card.classList.toggle("is-flipped", next);
    card.setAttribute("aria-pressed", next ? "true" : "false");
  });
}

function setupAlertDisclosure() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".alert-pill[data-alert-toggle='true']");
    if (!btn) return;

    const panelId = btn.getAttribute("aria-controls");
    const panel = panelId ? document.getElementById(panelId) : null;
    if (!panel) return;

    const shouldExpand = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", shouldExpand ? "true" : "false");
    panel.hidden = !shouldExpand;
  });
}

/* ---------- Time helpers for Sun position ---------- */

function parseHHMMToMinutes(hhmm) {
  const t = safeText(hhmm);
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return clamp(hh, 0, 23) * 60 + clamp(mm, 0, 59);
}

function formatHHMMTo12h(hhmm) {
  const t = safeText(hhmm);
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t || "—";
  let hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return t || "—";

  const ampm = hh >= 12 ? "PM" : "AM";
  hh = hh % 12;
  if (hh === 0) hh = 12;

  return `${hh}:${String(mm).padStart(2, "0")} ${ampm}`;
}

function getNowMinutesInTimeZone(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || undefined,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());

    const hh = Number(parts.find(p => p.type === "hour")?.value);
    const mm = Number(parts.find(p => p.type === "minute")?.value);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    return hh * 60 + mm;
  } catch {
    return null;
  }
}

/* ---------- Moon display helpers ---------- */

function moonIllumFromPhaseLabel(phaseLabel) {
  const p = safeText(phaseLabel).toLowerCase();
  if (!p) return { illum: null, waxing: null, label: "" };

  let illum = null;
  if (p.includes("new")) illum = 0;
  else if (p.includes("full")) illum = 1;
  else if (p.includes("gibbous")) illum = 0.75;
  else if (p.includes("quarter")) illum = 0.5;
  else if (p.includes("crescent")) illum = 0.25;

  const waxing = p.includes("waxing") ? true : (p.includes("waning") ? false : null);
  const label = safeText(phaseLabel) || "—";
  return { illum, waxing, label };
}

async function fetchLocation(query) {
  const res = await apiFetch("/api/location", { q: query }, { cache: "no-store" });
  if (!res.ok) throw new Error(`Location lookup failed (${res.status})`);
  return await res.json();
}

async function fetchLocationSuggestions(query) {
  const res = await apiFetch("/api/location/suggest", { q: query }, {
    cache: "no-store",
    signal: suggestionAbortController?.signal,
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.suggestions) ? data.suggestions : [];
}

function clearSuggestions() {
  suggestionItems = [];
  suggestionActiveIndex = -1;
  if (!els.locationSuggestions) return;
  els.locationSuggestions.innerHTML = "";
  els.locationSuggestions.hidden = true;
}

function renderSuggestions(items) {
  suggestionItems = Array.isArray(items) ? items : [];
  suggestionActiveIndex = -1;

  if (!els.locationSuggestions || !suggestionItems.length) {
    clearSuggestions();
    return;
  }

  els.locationSuggestions.innerHTML = suggestionItems.map((item, idx) => (
    `<li class="location-suggestion-item" data-index="${idx}" role="option" aria-selected="false">${safeText(item.label || item.query)}</li>`
  )).join("");
  els.locationSuggestions.hidden = false;
  trackEvent("search_suggestions_rendered", {
    action: "render_suggestions",
    searchQuery: safeText(els.zipInput?.value),
    metadata: { suggestionCount: suggestionItems.length },
  });
}

function setActiveSuggestion(nextIndex) {
  if (!els.locationSuggestions || !suggestionItems.length) return;
  suggestionActiveIndex = clamp(nextIndex, 0, suggestionItems.length - 1);

  els.locationSuggestions.querySelectorAll(".location-suggestion-item").forEach((el, idx) => {
    const active = idx === suggestionActiveIndex;
    el.classList.toggle("is-active", active);
    el.setAttribute("aria-selected", active ? "true" : "false");
    if (active) el.scrollIntoView({ block: "nearest" });
  });
}

async function queueLocationSuggestions(query) {
  const q = safeText(query);
  if (suggestionFetchTimer) clearTimeout(suggestionFetchTimer);

  if (q.length < 3) {
    clearSuggestions();
    return;
  }

  suggestionFetchTimer = setTimeout(async () => {
    if (suggestionAbortController) suggestionAbortController.abort();
    suggestionAbortController = new AbortController();

    try {
      const items = await fetchLocationSuggestions(q);
      renderSuggestions(items);
    } catch (err) {
      if (err?.name !== "AbortError") console.warn("suggestions failed", err);
      clearSuggestions();
    }
  }, 220);
}

function pickSuggestion(index) {
  const picked = suggestionItems[index];
  if (!picked) return;
  els.zipInput.value = picked.query || picked.label || "";
  trackEvent("search_suggestion_selected", {
    action: "select_suggestion",
    target: safeText(picked.label || picked.query),
    searchQuery: safeText(els.zipInput.value),
    locationLabel: safeText(picked.label || picked.query),
    locationLat: Number(picked.lat),
    locationLon: Number(picked.lon),
  });
  clearSuggestions();
  runSearch(els.zipInput.value);
}

async function fetchWeather(lat, lon, zip) {
  const res = await apiFetch("/api/weather", { lat, lon, zip }, { cache: "no-store" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Weather fetch failed (${res.status}) ${t}`);
  }
  return await res.json();
}

function resetVisibleSections() {
  if (earthRefreshTimer) {
    clearInterval(earthRefreshTimer);
    earthRefreshTimer = null;
  }

  setExpandedTile(null);
  document.querySelectorAll(".is-expanded").forEach((el) => {
    el.classList.remove("is-expanded");
    if (el.matches("[data-expandable='true']")) el.setAttribute("aria-expanded", "false");
  });

  els.currentCard.hidden = true;
  els.todayCard.hidden = true;
  els.windCard.hidden = true;
  els.shoeCard.hidden = true;
  els.earthCard.hidden = true;
  els.astroUvCard.hidden = true;
  els.hourlyCard.hidden = true;
  els.graphsCard.hidden = true;
  els.dailyCard.hidden = true;
  els.alertsCard.hidden = true;

  els.currentContent.innerHTML = "";
  els.todayContent.innerHTML = "";
  els.windContent.innerHTML = "";
  els.shoeContent.innerHTML = "";
  els.earthContent.innerHTML = "";
  els.astroUvContent.innerHTML = "";
  els.hourlyContent.innerHTML = "";
  els.graphsContent.innerHTML = "";
  els.dailyContent.innerHTML = "";
  els.alertsContent.innerHTML = "";
}

function getEarthSatelliteImageUrl() {
  const u = new URL(EARTH_SATELLITE_BASE_URL);
  u.searchParams.set("cb", String(Date.now()));
  return u.toString();
}

function getEarthTileMaxHeightPx() {
  const shoeHeight = els.shoeCard?.offsetHeight || 0;
  if (shoeHeight > 0) return Math.round(shoeHeight * 2);
  return EARTH_TILE_FALLBACK_MAX_HEIGHT_PX;
}

function renderEarthTile() {
  if (!els.earthContent || !els.earthCard) return;

  const now = new Date();
  const refreshedAt = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const satelliteUrl = getEarthSatelliteImageUrl();
  const maxHeightPx = getEarthTileMaxHeightPx();

  els.earthContent.innerHTML = `
    <div class="earth-tile" style="--earth-max-height:${maxHeightPx}px;">
      <img
        class="earth-tile-image"
        src="${satelliteUrl}"
        alt="Latest near real-time NOAA GOES East full-disk satellite image of Earth"
        loading="lazy"
        referrerpolicy="no-referrer"
      />
      <div class="earth-tile-meta">Updated ${refreshedAt} (local)</div>
    </div>
  `;

  els.earthCard.hidden = false;
}

function iconFromForecastIconUrl(url, shortForecast) {
  const s = safeText(shortForecast).toLowerCase();
  if (s.includes("thunder")) return "⛈️";
  if (s.includes("snow")) return "🌨️";
  if (s.includes("sleet") || s.includes("ice")) return "🌧️";
  if (s.includes("rain") || s.includes("showers") || s.includes("drizzle")) return "🌧️";
  if (s.includes("fog")) return "🌫️";
  if (s.includes("cloudy")) return s.includes("partly") ? "⛅" : "☁️";
  if (s.includes("clear")) return "🌙";
  if (s.includes("sunny")) return "☀️";
  return "🌤️";
}

function renderCurrent(data) {
  const current = data?.current;
  if (!current) return;

  const temp = formatTempF(current.temperatureF ?? current.temperature);
  const desc = safeText(current.shortForecast || current.textDescription || "—");
  const icon = iconFromForecastIconUrl(current.icon, desc);

  const windStr = parseWind(current.windDirection, current.windSpeed);
  const pop = extractPopPercent(current);

  const metaParts = [];
  if (windStr) metaParts.push(`💨 ${windStr}`);
  if (typeof pop === "number" && pop >= 10) metaParts.push(`💧 ${pop}%`);

  const meta = metaParts.join(" • ");

  const hourlyMetrics = data?.hourlyMetrics || {};
  const currentMetrics = getPeriodMetrics(hourlyMetrics, current?.number) || getPeriodMetrics(data?.periodMetrics || {}, current?.number);
  const apparent = Number.isFinite(currentMetrics?.apparentTempF) ? currentMetrics.apparentTempF : current?.temperature;

  const nowRows = [
    { label: "Precipitation Chance", value: pop, formatter: formatPercent },
    { label: "Dew Point", value: currentMetrics?.dewpointF, formatter: (v) => `${Math.round(v)}°F` },
    { label: "Relative Humidity", value: currentMetrics?.relativeHumidityPct, formatter: formatPercent },
    { label: "Cloud Cover", value: currentMetrics?.skyCoverPct, formatter: formatPercent },
    { label: "Feels Like", value: apparent, formatter: (v) => `${Math.round(v)}°F` },
  ];

  const uvCurrent = data?.uv?.ok && Number.isFinite(data?.uv?.current) ? Math.round(data.uv.current) : null;
  const uvMax = data?.uv?.ok && Number.isFinite(data?.uv?.max) ? Math.round(data.uv.max) : null;

  const nowDetails = [
    windStr ? `<div class="tile-detail-row"><span class="tile-detail-label">Wind</span><span class="tile-detail-value">${windStr}</span></div>` : "",
    detailRowsHtml(nowRows),
    uvCurrent !== null ? `<div class="tile-detail-row"><span class="tile-detail-label">UV Current</span><span class="tile-detail-value">${uvCurrent}</span></div>` : "",
    uvMax !== null ? `<div class="tile-detail-row"><span class="tile-detail-label">UV Max</span><span class="tile-detail-value">${uvMax}</span></div>` : "",
  ].filter(Boolean).join("");

  els.currentContent.innerHTML = `
    <div class="current-row">
      <div>
        <div class="current-temp">${temp}</div>
        <div class="current-desc">${desc}</div>
        ${meta ? `<div class="current-meta">${meta}</div>` : ""}
      </div>
      <div class="wx-icon" aria-hidden="true">${icon}</div>
    </div>
    ${nowDetails ? `<div class="tile-details">${nowDetails}</div>` : ""}
  `;

  els.currentCard.hidden = false;
}

function renderAlerts(data) {
  if (!Array.isArray(data?.alerts) || !data.alerts.length) return;

  const pills = data.alerts
    .slice(0, 6)
    .map((a, idx) => {
      const eventName = safeText(a.event || "Alert");
      const detail = safeText(a.description || a.instruction || a.headline || "No additional details provided.");
      const detailId = `alert-detail-${idx}`;
      return `
        <div class="alert-item">
          <button class="alert-pill" type="button" data-alert-toggle="true" aria-expanded="false" aria-controls="${detailId}">⚠️ ${eventName}</button>
          <div id="${detailId}" class="alert-detail" hidden>${detail}</div>
        </div>
      `;
    })
    .join("");

  els.alertsContent.innerHTML = `<div class="alerts">${pills}</div>`;
  els.alertsCard.hidden = false;
}

function renderToday(data) {
  const outlook = data?.outlook;
  if (!outlook || !Array.isArray(outlook.periods) || outlook.periods.length === 0) return;

  const cleanName = (s) => safeText(s).replace(/^This\s+/i, "");

  const periodMetrics = data?.periodMetrics || {};

  const rows = outlook.periods.slice(0, 2).map(p => {
    const name = cleanName(p.name || "");
    const short = safeText(p.shortForecast || "");
    const icon = iconFromForecastIconUrl(p.icon, short);
    const temp = formatTempF(p.temperature);

    const pop = extractPopPercent(p);
    const showPop = (typeof pop === "number" && pop >= 10);

    const m = getPeriodMetrics(periodMetrics, p?.number);
    const detailsRows = [
      { label: "Precipitation Chance", value: pop, formatter: formatPercent },
      { label: "Feels Like", value: m?.apparentTempF, formatter: (v) => `${Math.round(v)}°F` },
      { label: "Dew Point", value: m?.dewpointF, formatter: (v) => `${Math.round(v)}°F` },
      { label: "Humidity", value: m?.relativeHumidityPct, formatter: formatPercent },
      { label: "Cloud Cover", value: m?.skyCoverPct, formatter: formatPercent },
    ];
    return `
      <section class="today-period" data-expandable="true" tabindex="0" role="button" aria-expanded="false">
        <div class="today-row">
          <div class="today-left">
            <div class="today-name">${name}</div>
            <div class="today-short">${short || "—"}</div>
          </div>

          <div class="today-precip ${showPop ? "" : "is-hidden"}">
            <span class="drop">💧</span>
            <span class="pct">${showPop ? `${pop}%` : ""}</span>
          </div>

          <div class="today-icon" aria-hidden="true">${icon}</div>
          <div class="today-temp">${temp}</div>
        </div>
        <div class="tile-details">
          ${detailRowsHtml(detailsRows)}
        </div>
      </section>
    `;
  }).join("");

  els.todayContent.innerHTML = `<div class="today-rows">${rows}</div>`;
  els.todayCard.hidden = false;
}

function renderWind(data) {
  const windTile = buildWindTile(data);
  if (!windTile) return;

  const windCompassModal = `
    <div class="wind-compass-modal" data-wind-compass-modal="true" hidden>
      <div class="wind-compass-dialog" role="dialog" aria-modal="true" aria-label="Wind compass">
        <button type="button" class="wind-compass-close" data-close-wind-compass="true" aria-label="Close wind compass">×</button>
        <div class="wind-compass-title">Wind Compass</div>
        <div class="wind-compass-subtitle">Wind coming from: <span data-wind-direction-label="true">—</span></div>
        <div class="wind-compass" data-compass="true">
          <div class="wind-compass-dial" data-compass-dial="true">
            <span class="wind-compass-north">N</span>
            <span class="wind-compass-east">E</span>
            <span class="wind-compass-south">S</span>
            <span class="wind-compass-west">W</span>
          </div>
          <span class="wind-compass-arrow wind-arrow" data-compass-wind-arrow="true" aria-hidden="true"></span>
          <span class="wind-compass-arrow wind-compass-heading-arrow" data-compass-heading-arrow="true" aria-hidden="true"></span>
        </div>
        <div class="wind-compass-legend">
          <span><span class="legend-dot legend-dot-heading"></span>Your heading</span>
          <span><span class="legend-dot legend-dot-wind"></span>Wind from</span>
        </div>
        <div class="wind-compass-status" data-compass-status="true">Move your phone to calibrate compass…</div>
      </div>
    </div>
  `;

  els.windContent.innerHTML = `${windTile}${windCompassModal}`;
  els.windCard.hidden = false;
}

/* ✅ Shoe tile (swap emojis -> images) */

const SHOE_ICONS = {
  Sandal: "/assets/shoes/sandal.png",
  Sneaker: "/assets/shoes/sneaker.png",
  "Hiking Boot": "/assets/shoes/hiking-boot.png",
  "Rain Boot": "/assets/shoes/boot.png",
};

// If your filenames/paths differ, only update these strings.
function shoeIconSrcForLabel(label) {
  const key = safeText(label);
  return SHOE_ICONS[key] || SHOE_ICONS.Sneaker;
}

function shoeLabelFromSoilMoisture(sm) {
  const v = Number(sm);
  if (!Number.isFinite(v)) return { label: "—", sub: "—" };

  // Thresholds (match Worker): <0.12 dry, 0.12–0.25 damp, >0.25–<0.46 wet, >=0.46 rainy
  if (v < 0.12) return { label: "Sandal", sub: `${Math.round(v * 100)}% Soil Moisture` };
  if (v <= 0.25) return { label: "Sneaker", sub: `${Math.round(v * 100)}% Soil Moisture` };
  if (v < 0.46) return { label: "Hiking Boot", sub: `${Math.round(v * 100)}% Soil Moisture` };
  return { label: "Rain Boot", sub: `${Math.round(v * 100)}% Soil Moisture` };
}

function renderShoe(data) {
  const soil = data?.soil;
  if (!soil) return;

  const sm = soil?.soilMoisture0To7cm;
  const smOk = !!soil?.ok && typeof sm === "number";

  // ✅ Prefer Worker-computed (and rain-boosted) shoe result if available
  const shoe = soil?.shoe;
  const useBoosted = !!shoe?.ok && (shoe.boostedLabel || shoe.boostedEmoji);

  const baseComputed = smOk ? shoeLabelFromSoilMoisture(sm) : { label: "—", sub: "—" };

  const label = useBoosted ? (shoe.boostedLabel || "—") : (baseComputed.label || "—");

  // Keep your existing sub line (soil moisture %), optionally add boost note
  const subBase = smOk ? `${Math.round(sm * 100)}% Soil Moisture` : "—";
  const subBoost = (useBoosted && typeof shoe.boost === "number" && shoe.boost > 0)
    ? ` • +${shoe.boost} for rain`
    : "";
  const sub = `${subBase}${subBoost}`;

  const iconSrc = shoeIconSrcForLabel(label);

  els.shoeContent.innerHTML = `
    <div class="shoe-wrap">
      <div class="shoe-main">
        <img class="shoe-icon-img" src="${iconSrc}" alt="" aria-hidden="true" />
        <div class="shoe-meta-row">
          <div class="shoe-text">
            <div class="shoe-sub">${sub}</div>
          </div>
        </div>
      </div>

      <div class="shoe-popover" hidden>
        <div class="shoe-popover-title">About Shoe Index</div>
        <div class="shoe-popover-text">
          Shoe Index is a super scientific representation of today's forecast and current ground conditions so you know what shoes to wear outside today.
        </div>

        <div class="shoe-scale">
          <div class="shoe-scale-row">
            <span class="shoe-scale-emoji">
              <img class="shoe-scale-img" src="${SHOE_ICONS.Sandal}" alt="" />
            </span>
            <span class="shoe-scale-label">Sandal</span>
            <span class="shoe-scale-range">0–11%</span>
          </div>
          <div class="shoe-scale-row">
            <span class="shoe-scale-emoji">
              <img class="shoe-scale-img" src="${SHOE_ICONS.Sneaker}" alt="" />
            </span>
            <span class="shoe-scale-label">Sneaker</span>
            <span class="shoe-scale-range">12–25%</span>
          </div>
          <div class="shoe-scale-row">
            <span class="shoe-scale-emoji">
              <img class="shoe-scale-img" src="${SHOE_ICONS["Hiking Boot"]}" alt="" />
            </span>
            <span class="shoe-scale-label">Hiking Boot</span>
            <span class="shoe-scale-range">26–45%</span>
          </div>
          <div class="shoe-scale-row">
            <span class="shoe-scale-emoji">
              <img class="shoe-scale-img" src="${SHOE_ICONS["Rain Boot"]}" alt="" />
            </span>
            <span class="shoe-scale-label">Rain Boot</span>
            <span class="shoe-scale-range">46%+</span>
          </div>
        </div>
        <div class="shoe-popover-note">(+1) Based on the severity of rain in the forecast, the Index may recommend the next level of feet protection.</div>
      </div>
    </div>
  `;

  // Toggle popover
  const wrap = els.shoeContent.querySelector(".shoe-wrap");
  const btn = document.getElementById("shoeInfoBtn");
  const pop = els.shoeContent.querySelector(".shoe-popover");

  const close = () => { if (pop) pop.hidden = true; };

  btn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!pop) return;
    pop.hidden = !pop.hidden;
  });

  // Close when tapping elsewhere inside the tile
  wrap?.addEventListener("click", (e) => {
    if (e.target.closest(".shoe-popover") || e.target.closest(".shoe-info-btn")) return;
    close();
  });

  els.shoeCard.hidden = false;
}

function renderAstroUv(data) {
  const astro = data?.astro;
  if (!astro) return;

  const timeZone = data?.timeZone || null;

  const sunriseRaw = safeText(astro.sunrise);
  const sunsetRaw  = safeText(astro.sunset);
  const moonriseRaw = safeText(astro.moonrise);
  const moonsetRaw  = safeText(astro.moonset);

   const sunrise = formatHHMMTo12h(sunriseRaw);
   const sunset  = formatHHMMTo12h(sunsetRaw);
   const moonrise = formatHHMMTo12h(moonriseRaw);
   const moonset  = formatHHMMTo12h(moonsetRaw);

  const { illum, waxing, label: phaseLabel } = moonIllumFromPhaseLabel(astro.moonPhase);

  const uv = data?.uv;
  const showUv = !!astro.isDaytimeNow;

  const uvLabel = (() => {
    if (!showUv) return "";
    if (uv?.ok && typeof uv.current === "number") return `UV ${Math.round(uv.current)}`;
    return "UV —";
  })();

  // --- Sun position along the daylight arc ---
  const srMin = parseHHMMToMinutes(sunriseRaw);
  const ssMin = parseHHMMToMinutes(sunsetRaw);
  const nowMin = getNowMinutesInTimeZone(timeZone);

  let sunT = null;
  if (srMin !== null && ssMin !== null && nowMin !== null && ssMin > srMin) {
    sunT = clamp((nowMin - srMin) / (ssMin - srMin), 0, 1);
  }

  const beforeSunrise = (srMin !== null && nowMin !== null) ? (nowMin < srMin) : false;
  const afterSunset   = (ssMin !== null && nowMin !== null) ? (nowMin > ssMin) : false;

  // Make the dot follow the *same* quadratic curve as the SVG:
  // Path: M0,55 Q50,0 100,55
  // Parameter t in [0..1]:
  // x = 100t
  // y = (1-t)^2*55 + 2(1-t)t*0 + t^2*55 = 55(1 - 2t + 2t^2)
  const sunX = (typeof sunT === "number") ? (sunT * 100) : 50;

  const ySvg = (typeof sunT === "number")
    ? (55 * (1 - 2 * sunT + 2 * sunT * sunT))
    : 55;

  // Map SVG y (0..55) directly onto the rendered SVG arc box (60px tall, bottom anchored at 28px).
  // This keeps the sun marker on the path instead of floating above it.
  const sunArcSvgTopPx = 44;
  const sunArcSvgHeightPx = 60;
  const sunYPx = sunArcSvgTopPx + clamp(ySvg / 55, 0, 1) * sunArcSvgHeightPx;

  // --- Moon phase visual: compute light-mask offset in px ---
  // We render a dark base disc and slide a same-sized light disc across it.
  // This keeps gibbous phases from looking "scooped out" while preserving
  // left/right orientation for waxing vs waning.
  // - illum 0   => offset diameter (light fully off-disc)
  // - illum 0.5 => offset radius   (half lit)
  // - illum 1   => offset 0        (fully lit)
  const moonIllumPct = (typeof illum === "number") ? Math.round(illum * 100) : null;

  const diameter = 58; // must match .moon-disc size in CSS
  const normalizedIllum = (typeof illum === "number") ? clamp(illum, 0, 1) : 0.5;
  const shift = (1 - normalizedIllum) * diameter;

  // Waxing and waning both use the same base light-mask geometry.
  // For waning phases we mirror the disc in CSS so the same silhouette
  // becomes left-lit without introducing asymmetric clipping artifacts.
  let moonOffsetPx = 0;
  if (waxing === true || waxing === false) moonOffsetPx = shift;
  const moonWaningClass = waxing === false ? " is-waning" : "";

  const showSunDot = !!(typeof sunT === "number") && !beforeSunrise && !afterSunset;

  els.astroUvContent.innerHTML = `
    <div class="astro-tiles">
      <div class="astro-tile sun-tile">
        <div class="sun-arc" style="--sun-x:${sunX}; --sun-y-px:${sunYPx}px;">
          <div class="astro-tile-head sun-arc-head">
            <div class="astro-tile-title">Sun</div>
            ${showUv ? `<button type="button" class="astro-tile-pill" data-open-uv-graph="true">${uvLabel}</button>` : ``}
          </div>

          <svg class="sun-arc-svg" viewBox="0 0 100 55" preserveAspectRatio="none" aria-hidden="true">
            <path d="M 0 55 Q 50 0 100 55" fill="none" />
          </svg>

          ${
            beforeSunrise
              ? `<div class="sun-endglow left" aria-hidden="true"></div>`
              : afterSunset
                ? `<div class="sun-endglow right" aria-hidden="true"></div>`
                : ``
          }

          <div class="sun-dot ${showSunDot ? "" : "is-hidden"}" aria-hidden="true"></div>

          <div class="sun-times">
            <div class="sun-time-left">${sunrise || "—"}</div>
            <div class="sun-time-right">${sunset || "—"}</div>
          </div>
        </div>
      </div>

      <div class="astro-tile moon-tile" style="--moon-offset:${moonOffsetPx}px;">
        <div class="astro-tile-head">
          <div class="astro-tile-title">Moon</div>
        </div>

        <div class="moon-wrap">
          <div class="moon-disc${moonWaningClass}" aria-hidden="true"></div>
          <div class="moon-label">
            <div class="moon-phase">${phaseLabel || "—"}</div>
            <div class="moon-sub moon-times">↑ ${moonrise || "—"} • ↓ ${moonset || "—"}</div>
            ${moonIllumPct !== null ? `<div class="moon-sub moon-illum">💡 ${moonIllumPct}%</div>` : ""}
          </div>
        </div>
      </div>
    </div>
  `;

  els.astroUvCard.hidden = false;

  const uvBtn = els.astroUvContent.querySelector("[data-open-uv-graph='true']");
  uvBtn?.addEventListener("click", () => {
    selectedGraphMetric = "uv";
    renderGraphs(data);
    els.graphsCard.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}


function renderHourly(data) {
  const hourly = data?.hourly;
  if (!hourly || !Array.isArray(hourly.periods) || hourly.periods.length === 0) return;

  const timeZone = data?.timeZone || null;
  const hourlyMetrics = data?.hourlyMetrics || {};
  const todayKey = getDayKey(new Date().toISOString(), timeZone);

  const allPeriods = hourly.periods;
  const visible = clamp(hourlyVisibleCount, HOURLY_INITIAL_COUNT, allPeriods.length);

  const cards = allPeriods.slice(0, visible).map(p => {
    const d = new Date(p.startTime);
    const time = (() => {
      try {
        return new Intl.DateTimeFormat("en-US", {
          timeZone: timeZone || undefined,
          hour: "numeric",
        }).format(d);
      } catch {
        return safeText(p.name || "");
      }
    })();

    const dayLabel = (() => {
      const periodDay = getDayKey(p.startTime, timeZone);
      if (!periodDay || periodDay === todayKey) return "";
      try {
        return new Intl.DateTimeFormat("en-US", { timeZone: timeZone || undefined, weekday: "short" }).format(d);
      } catch {
        return "";
      }
    })();

    const temp = formatTempF(p.temperature);
    const desc = safeText(p.shortForecast || "");
    const icon = iconFromForecastIconUrl(p.icon, desc);
    const pop = extractPopPercent(p);

    const m = getPeriodMetrics(hourlyMetrics, p?.number);
    const windDetail = parseWind(p?.windDirection, p?.windSpeed);
    const detailRows = [
      { label: "Wind", value: windDetail || "", formatter: (v) => v },
      { label: "Feels", value: m?.apparentTempF, formatter: (v) => `${Math.round(v)}°F` },
      { label: "Dewpoint", value: m?.dewpointF, formatter: (v) => `${Math.round(v)}°F` },
      { label: "Humidity", value: m?.relativeHumidityPct, formatter: formatPercent },
      { label: "Clouds", value: m?.skyCoverPct, formatter: formatPercent },
    ];

    return `
      <div class="hour-card" data-flippable="true" tabindex="0" role="button" aria-pressed="false">
        <div class="hour-flip">
          <div class="hour-face hour-front">
            <div class="hour-time">${time}${dayLabel ? `<span class="hour-day">${dayLabel}</span>` : ""}</div>
            <div class="hour-temp">${temp}</div>
            <div class="hour-desc">${desc || "—"}</div>
            <div class="hour-meta">
              <div class="wx-icon-sm" aria-hidden="true">${icon}</div>
              ${
                (typeof pop === "number" && pop >= 10)
                  ? `<span class="pop-badge"><span class="drop">💧</span>${pop}%</span>`
                  : ``
              }
            </div>
          </div>
          <div class="hour-face hour-back">
            <div class="tile-details tile-details-back">
              ${typeof pop === "number" ? `<div class="tile-detail-row"><span class="tile-detail-label">Precip</span><span class="tile-detail-value">${pop}%</span></div>` : ""}
              ${detailRowsHtml(detailRows)}
            </div>
          </div>
        </div>
      </div>
    `;
  }).join("");

  const remaining = allPeriods.length - visible;
  const nextStep = Math.min(HOURLY_LOAD_STEP, remaining);
  const loadMoreCard = remaining > 0
    ? `<button class="hour-load-more" type="button" data-hour-load-more="true" aria-label="Load more hourly forecast"><span class="hour-load-arrow">&gt;</span><span class="hour-load-text">Load Next ${nextStep} Hours</span></button>`
    : "";

  els.hourlyContent.innerHTML = `<div class="row-scroll">${cards}${loadMoreCard}</div>`;
  const loadBtn = els.hourlyContent.querySelector("[data-hour-load-more='true']");
  loadBtn?.addEventListener("click", () => {
    const row = els.hourlyContent.querySelector(".row-scroll");
    const priorScrollLeft = row ? row.scrollLeft : 0;
    hourlyVisibleCount = Math.min(hourlyVisibleCount + HOURLY_LOAD_STEP, allPeriods.length);
    renderHourly(data);
    renderGraphs(data);

    const nextRow = els.hourlyContent.querySelector(".row-scroll");
    if (nextRow) {
      requestAnimationFrame(() => {
        nextRow.scrollLeft = priorScrollLeft;
      });
    }
  });
  els.hourlyCard.hidden = false;
}


function getHourlyGraphPoints(data, metric) {
  const periods = Array.isArray(data?.hourly?.periods) ? data.hourly.periods.slice(0, hourlyVisibleCount) : [];
  const timeZone = data?.timeZone || undefined;
  const metrics = data?.hourlyMetrics || {};
  const uvHourly = Array.isArray(data?.uv?.hourly) ? data.uv.hourly : [];

  return periods
    .map((p, idx) => {
      const m = getPeriodMetrics(metrics, p?.number);
      const hourOfDay = (() => {
        try {
          const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).formatToParts(new Date(p.startTime));
          return Number(parts.find((part) => part.type === "hour")?.value);
        } catch {
          return null;
        }
      })();

      const label = (() => {
        try {
          return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric" }).format(new Date(p.startTime));
        } catch {
          return safeText(p?.name || `${idx + 1}`);
        }
      })();

      const dayKey = getDayKey(p?.startTime, timeZone);
      const dayLabel = (() => {
        try {
          return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(p.startTime));
        } catch {
          return "";
        }
      })();

      let value = null;
      if (metric === "precipitation") value = extractPopPercent(p);
      if (metric === "temperature") value = Number.isFinite(p?.temperature) ? p.temperature : null;
      if (metric === "humidity") value = Number.isFinite(m?.relativeHumidityPct) ? Math.round(m.relativeHumidityPct) : null;
      if (metric === "dewpoint") value = Number.isFinite(m?.dewpointF) ? Math.round(m.dewpointF) : null;
      if (metric === "cloudcover") value = Number.isFinite(m?.skyCoverPct) ? Math.round(m.skyCoverPct) : null;
      if (metric === "feelslike") value = Number.isFinite(m?.apparentTempF) ? Math.round(m.apparentTempF) : null;
      if (metric === "wind") value = extractWindMph(p?.windSpeed);
      if (metric === "uv") {
        const uvPoint = uvHourly.find((u) => {
          const uvHour = Number(u?.hour);
          const uvDay = safeText(u?.day);
          if (!Number.isFinite(uvHour) || uvHour !== hourOfDay) return false;
          if (!uvDay) return true;
          return uvDay === dayKey;
        });
        value = Number.isFinite(uvPoint?.value) ? uvPoint.value : null;
      }

      return { label, value, dayKey, dayLabel };
    })
    .filter((pt) => Number.isFinite(pt.value));
}

function getGraphRange(points, metric) {
  const values = points.map((p) => p.value).filter(Number.isFinite);
  if (!values.length) return { min: 0, max: 100 };

  const needsDefaultBand = ["precipitation", "temperature", "humidity", "dewpoint", "cloudcover", "feelslike"].includes(metric);
  if (needsDefaultBand) {
    const dataMin = Math.min(...values);
    const dataMax = Math.max(...values);
    const min = dataMin < 0 ? Math.floor(dataMin / 5) * 5 : 0;
    const max = dataMax > 100 ? Math.ceil(dataMax / 5) * 5 : 100;
    return { min, max: Math.max(max, min + 1) };
  }

  const min = Math.min(0, Math.floor(Math.min(...values) / 5) * 5);
  const max = Math.max(5, Math.ceil(Math.max(...values) / 5) * 5);
  return { min, max: Math.max(max, min + 1) };
}

function renderLineGraphSvg(points, metric) {
  if (!points.length) return `<div class="graph-empty">No hourly data available for this factor yet.</div>`;

  const height = 220;
  const padL = 12;
  const padR = 18;
  const padT = 14;
  const padB = 30;
  const visibleHours = Math.max(GRAPH_DEFAULT_VISIBLE_HOURS, 2);
  const stepX = 56;
  const innerWidth = Math.max((visibleHours - 1) * stepX, (points.length - 1) * stepX);
  const width = padL + innerWidth + padR;

  const { min: minV, max: maxV } = getGraphRange(points, metric);
  const span = Math.max(maxV - minV, 1);

  const coords = points.map((p, idx) => {
    const x = padL + (idx * (width - padL - padR) / Math.max(points.length - 1, 1));
    const y = height - padB - ((p.value - minV) / span) * (height - padT - padB);
    return { ...p, x, y };
  });

  const path = coords.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const yTicks = [0, 0.5, 1].map((ratio) => {
    const value = maxV - ratio * span;
    const y = padT + ratio * (height - padT - padB);
    return { value, y };
  });

  const dayMarkers = [];
  let previousDay = "";
  coords.forEach((p) => {
    if (p.dayKey && p.dayKey !== previousDay) {
      dayMarkers.push(p);
      previousDay = p.dayKey;
    }
  });

  const formatTickValue = (rawValue) => {
    const rounded = Math.round(rawValue);
    if (["temperature", "dewpoint", "feelslike"].includes(metric)) return `${rounded}°`;
    if (["precipitation", "humidity", "cloudcover"].includes(metric)) return `${rounded}%`;
    return `${rounded}`;
  };

  return `
    <div class="graph-layout">
      <div class="graph-yaxis" aria-hidden="true">
        <svg class="graph-yaxis-svg" viewBox="0 0 32 ${height}" role="presentation">
          ${yTicks.map((tick) => `<text x="28" y="${tick.y + 4}" text-anchor="end" class="graph-label">${formatTickValue(tick.value)}</text>`).join("")}
          <line x1="30" y1="${padT}" x2="30" y2="${height - padB}" class="graph-axis"/>
        </svg>
      </div>
      <div class="graph-scroll" data-graph-scroll="true">
        <div class="graph-plot" data-graph-plot="true">
          <svg class="metric-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="Hourly trend graph">
            ${yTicks.map((tick) => `<line x1="${padL}" y1="${tick.y}" x2="${width - padR}" y2="${tick.y}" class="graph-grid"/>`).join("")}
            <line x1="${padL}" y1="${height - padB}" x2="${width - padR}" y2="${height - padB}" class="graph-axis"/>
            ${dayMarkers.map((day) => `
              <line x1="${day.x}" y1="${padT}" x2="${day.x}" y2="${height - padB}" class="graph-day-marker" data-day-marker="true" data-day-label="${day.dayLabel}" data-day-x="${day.x}"/>
              <text x="${day.x + 3}" y="${padT + 10}" class="graph-day-label">${day.dayLabel}</text>
            `).join("")}
            <path d="${path}" class="graph-line"/>
            ${coords.map((p, idx) => `<circle cx="${p.x}" cy="${p.y}" r="4" class="graph-dot" data-graph-point="${idx}" data-label="${p.label}" data-value="${Math.round(p.value)}" data-x="${p.x}" data-y="${p.y}"></circle>`).join("")}
            ${coords.map((p, idx) => `<circle cx="${p.x}" cy="${p.y}" r="16" class="graph-hit" data-graph-hit="${idx}" data-label="${p.label}" data-value="${Math.round(p.value)}" data-x="${p.x}" data-y="${p.y}" aria-label="${p.label}: ${Math.round(p.value)}"></circle>`).join("")}
            ${coords.map((p) => `<text x="${p.x}" y="${height - 8}" text-anchor="middle" class="graph-hour-label">${p.label}</text>`).join("")}
          </svg>
          <div class="graph-callout" data-graph-callout="true" hidden></div>
        </div>
      </div>
    </div>
  `;
}

function renderGraphs(data) {
  const primaryOptions = [
    ["precipitation", "Precipitation", "Precip"],
    ["temperature", "Temperature", "Temp"],
    ["wind", "Wind", "Wind"],
  ];
  const extraOptions = [
    ["humidity", "Humidity"],
    ["dewpoint", "Dew Point"],
    ["cloudcover", "Cloud Cover"],
    ["feelslike", "Feels Like"],
    ["uv", "UV"],
  ];
  const isExtraMetric = extraOptions.some(([value]) => value === selectedGraphMetric);

  const graphPoints = getHourlyGraphPoints(data, selectedGraphMetric);

  els.graphsContent.innerHTML = `
    <div class="graph-controls" aria-label="Graph metric options">
      <div class="graph-primary-options" role="tablist" aria-label="Primary graph metric options">
        ${primaryOptions.map(([v, label, mobileLabel]) => `<button type="button" class="graph-option ${selectedGraphMetric === v ? "is-active" : ""}" data-graph-metric="${v}" role="tab" aria-selected="${selectedGraphMetric === v ? "true" : "false"}"><span class="graph-label-desktop">${label}</span><span class="graph-label-mobile">${mobileLabel}</span></button>`).join("")}
        <div class="graph-option graph-more-option ${isExtraMetric ? "is-active" : ""}">
          <select id="graphMetricMore" class="graph-more-select" data-graph-metric-select="true" aria-label="Additional graph metrics">
            <option value="" ${isExtraMetric ? "" : "selected"}>More</option>
            ${extraOptions.map(([v, label]) => `<option value="${v}" ${selectedGraphMetric === v ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </div>
      </div>
    </div>
    ${renderLineGraphSvg(graphPoints, selectedGraphMetric)}
  `;

  const callout = els.graphsContent.querySelector("[data-graph-callout='true']");
  const graphPlot = els.graphsContent.querySelector("[data-graph-plot='true']");
  const graphSvg = els.graphsContent.querySelector(".metric-graph");
  const graphScroll = els.graphsContent.querySelector("[data-graph-scroll='true']");
  const valueFormatter = (rawValue, rawLabel) => {
    const value = safeText(rawValue);
    const label = safeText(rawLabel);
    if (!value) return "";
    if (selectedGraphMetric === "precipitation") return `${value}% chance at ${label}`;
    if (selectedGraphMetric === "temperature" || selectedGraphMetric === "dewpoint" || selectedGraphMetric === "feelslike") return `${value}°F at ${label}`;
    if (selectedGraphMetric === "humidity" || selectedGraphMetric === "cloudcover") return `${value}% at ${label}`;
    if (selectedGraphMetric === "wind") return `${value} mph at ${label}`;
    if (selectedGraphMetric === "uv") return `UV ${value} at ${label}`;
    return `${value} at ${label}`;
  };

  const clearSelection = () => {
    els.graphsContent.querySelectorAll("[data-graph-point]").forEach((dot) => dot.classList.remove("is-active"));
    if (callout) callout.hidden = true;
  };

  const handlePointSelection = (pointEl) => {
    if (!pointEl || !callout || !graphSvg || !graphPlot) return;
    clearSelection();
    const idx = pointEl.getAttribute("data-graph-hit");
    const selectedDot = idx !== null
      ? els.graphsContent.querySelector(`[data-graph-point='${idx}']`)
      : pointEl;
    selectedDot?.classList.add("is-active");

    callout.hidden = false;
    callout.textContent = valueFormatter(pointEl.getAttribute("data-value"), pointEl.getAttribute("data-label"));

    const x = Number(pointEl.getAttribute("data-x"));
    const y = Number(pointEl.getAttribute("data-y"));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const scaleX = graphSvg.clientWidth / graphSvg.viewBox.baseVal.width;
    const scaleY = graphSvg.clientHeight / graphSvg.viewBox.baseVal.height;
    let leftPx = x * scaleX;
    let topPx = (y * scaleY) - 18;

    const pad = 8;
    const bubbleW = callout.offsetWidth;
    const bubbleH = callout.offsetHeight;
    const maxLeft = graphPlot.clientWidth - bubbleW - pad;
    const maxTop = graphPlot.clientHeight - bubbleH - pad;

    leftPx = clamp(leftPx - (bubbleW / 2), pad, Math.max(maxLeft, pad));
    topPx = clamp(topPx - bubbleH, pad, Math.max(maxTop, pad));

    const tailLeft = clamp((x * scaleX) - leftPx, 12, Math.max(bubbleW - 12, 12));

    callout.style.left = `${leftPx}px`;
    callout.style.top = `${topPx}px`;
    callout.style.setProperty("--callout-tail-left", `${tailLeft}px`);
  };

  const allPoints = Array.from(els.graphsContent.querySelectorAll("[data-graph-hit]"));
  allPoints.forEach((point) => {
    point.addEventListener("click", () => handlePointSelection(point));
  });

  graphScroll?.addEventListener("scroll", () => {
    clearSelection();
  }, { passive: true });
  graphScroll?.addEventListener("wheel", clearSelection, { passive: true });
  graphScroll?.addEventListener("touchmove", clearSelection, { passive: true });
  if (graphOutsideClickHandler) {
    document.removeEventListener("click", graphOutsideClickHandler);
  }
  graphOutsideClickHandler = (e) => {
    if (!graphPlot?.contains(e.target)) clearSelection();
  };
  document.addEventListener("click", graphOutsideClickHandler);

  els.graphsContent.querySelectorAll("[data-graph-metric]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedGraphMetric = safeText(btn.getAttribute("data-graph-metric")) || "precipitation";
      renderGraphs(data);
    });
  });

  const metricSelect = els.graphsContent.querySelector("[data-graph-metric-select='true']");
  metricSelect?.addEventListener("change", () => {
    const selectedValue = safeText(metricSelect.value);
    if (!selectedValue) return;
    selectedGraphMetric = selectedValue;
    renderGraphs(data);
  });

  els.graphsCard.hidden = false;
}


/* ---------- Daily ---------- */

function dayKeyFromIso(iso, timeZone) {
  try {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);

    const y = parts.find(p => p.type === "year")?.value;
    const m = parts.find(p => p.type === "month")?.value;
    const da = parts.find(p => p.type === "day")?.value;
    return y && m && da ? `${y}-${m}-${da}` : safeText(iso).slice(0, 10);
  } catch {
    return safeText(iso).slice(0, 10);
  }
}

function groupDailyIntoDays(periods, timeZone) {
  const out = [];
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i];
    if (!p) continue;
    if (!p.isDaytime) continue;

    const k = dayKeyFromIso(p.startTime, timeZone);

    let night = null;
    for (let j = i + 1; j < Math.min(i + 3, periods.length); j++) {
      const q = periods[j];
      if (q && q.isDaytime === false) {
        const k2 = dayKeyFromIso(q.startTime, timeZone);
        if (k2 === k) {
          night = q;
          break;
        }
      }
    }

    out.push({ day: p, night });
    if (out.length >= DAILY_DAYS_VISIBLE) break;
  }

  if (out.length === 0) {
    return periods.slice(0, DAILY_DAYS_VISIBLE).map(p => ({ day: p, night: null }));
  }

  return out;
}

function renderDaily(data) {
  const daily = data?.daily;
  if (!daily || !Array.isArray(daily.periods) || daily.periods.length === 0) return;

  const timeZone = data?.timeZone || null;
  const metrics = data?.periodMetrics || {};

  const grouped = groupDailyIntoDays(daily.periods, timeZone);
  const shouldShowToggle = grouped.length > DAILY_INITIAL_VISIBLE;
  const visibleDays = dailyExpanded ? grouped : grouped.slice(0, DAILY_INITIAL_VISIBLE);

  const list = visibleDays.map(({ day, night }, dayIndex) => {
    const name = safeText(day?.name || "");
    const short = safeText(day?.shortForecast || "");
    const icon = iconFromForecastIconUrl(day?.icon, short);

    const hi = formatTempF(day?.temperature);
    const overnightLow = Number.isFinite(day?.overnightLow) ? day.overnightLow : null;
    const lo = night ? formatTempF(night?.temperature) : (overnightLow !== null ? formatTempF(overnightLow) : "—");
    const popDay = extractPopPercent(day);
    const popNight = night ? extractPopPercent(night) : null;

    const when = day?.startTime ? formatDateShort(day.startTime, timeZone) : "";

    const windDay = parseWind(day?.windDirection, day?.windSpeed);
    const mDay = metrics?.[String(day?.number)] || metrics?.[day?.number];
    const dewDayF = (mDay && typeof mDay.dewpointF === "number") ? Math.round(mDay.dewpointF) : null;
    const rhDay = (mDay && typeof mDay.relativeHumidityPct === "number") ? Math.round(mDay.relativeHumidityPct) : null;

    const windNight = night ? parseWind(night?.windDirection, night?.windSpeed) : "";
    const mNight = night ? (metrics?.[String(night?.number)] || metrics?.[night?.number]) : null;
    const dewNightF = (mNight && typeof mNight.dewpointF === "number") ? Math.round(mNight.dewpointF) : null;
    const rhNight = (mNight && typeof mNight.relativeHumidityPct === "number") ? Math.round(mNight.relativeHumidityPct) : null;

    const buildStatsRows = ({ pop, windStr, dewF, rh }) => {
      return [
        { label: "Precip", value: (typeof pop === "number") ? `${pop}%` : "" },
        { label: "Wind", value: windStr || "" },
        { label: "Dew Point", value: (dewF !== null) ? `${dewF}°F` : "" },
        { label: "Humidity", value: (rh !== null) ? `${rh}%` : "" },
      ].filter((row) => !!row.value);
    };

    const statsRowsHtml = (rows) => {
      if (!rows.length) return "";
      return `<div class="daypart-stats">${rows.map((row) => `<div class="tile-detail-row"><span class="tile-detail-label">${row.label}</span><span class="tile-detail-value">${row.value}</span></div>`).join("")}</div>`;
    };

    const dayStats = buildStatsRows({ pop: popDay, windStr: windDay, dewF: dewDayF, rh: rhDay });
    const nightStats = night ? buildStatsRows({ pop: popNight, windStr: windNight, dewF: dewNightF, rh: rhNight }) : [];

    const dayDetail = stripWindFromForecastText(stripChanceOfPrecipSentence(day?.detailedForecast || short));
    const nightDetail = night
      ? stripWindFromForecastText(stripChanceOfPrecipSentence(night?.detailedForecast || night?.shortForecast))
      : "";

    const isExtendedDay = dailyExpanded && dayIndex >= DAILY_INITIAL_VISIBLE;

    const buildDayPartCard = ({ title, period, detailText, pop, statsRows }) => {
      if (!period) return "";
      const partShort = safeText(period?.shortForecast || "");
      const partIcon = iconFromForecastIconUrl(period?.icon, partShort);
      const precipLabel = typeof pop === "number" ? `${pop}%` : "—";

      if (isExtendedDay) {
        return `
          <div class="daypart-card daypart-card-static" role="group" aria-label="${title} forecast stats">
            <div class="daypart-face daypart-front">
              <div class="daypart-head">
                <span class="dn-title">${title}</span>
                <span class="daypart-icon" aria-hidden="true">${partIcon}</span>
                <span class="daypart-precip">💧 ${precipLabel}</span>
              </div>
              ${statsRowsHtml(statsRows) || `<div class="daypart-empty">No additional stats.</div>`}
            </div>
          </div>
        `;
      }

      return `
        <button class="daypart-card" type="button" data-flippable="true" aria-pressed="false" aria-label="Flip ${title.toLowerCase()} forecast card for details">
          <div class="daypart-flip">
            <div class="daypart-face daypart-front">
              <div class="daypart-head">
                <span class="dn-title">${title}</span>
                <span class="daypart-icon" aria-hidden="true">${partIcon}</span>
                <span class="daypart-precip">💧 ${precipLabel}</span>
              </div>
              <div class="dn-text">${detailText || "—"}</div>
            </div>
            <div class="daypart-face daypart-back">
              <div class="daypart-back-title">${title} Stats</div>
              ${statsRowsHtml(statsRows) || `<div class="daypart-empty">No additional stats.</div>`}
            </div>
          </div>
        </button>
      `;
    };

    const detailHtml = `
      <div class="daypart-grid">
        ${buildDayPartCard({ title: "Day", period: day, detailText: dayDetail, pop: popDay, statsRows: dayStats })}
        ${night ? buildDayPartCard({ title: "Night", period: night, detailText: nightDetail, pop: popNight, statsRows: nightStats }) : ""}
      </div>
    `;

    return `
      <details class="day-details">
        <summary class="day-summary">
          <div class="day-left">
            <div class="day-name">${name}</div>
            ${when ? `<div class="day-date">${when.replace(/^\w+,\s*/, "")}</div>` : ""}
            <div class="day-short">${short || "—"}</div>
          </div>
          <div class="day-right">
            <div class="precip ${(typeof popDay === "number" && popDay >= 10) ? "" : "is-hidden"}">
              <span class="drop">💧</span>
              <span class="pct">${(typeof popDay === "number" && popDay >= 10) ? (popDay + "%") : ""}</span>
            </div>
            <div class="wx-icon" aria-hidden="true">${icon}</div>
            <div class="day-temp">${hi}<span class="day-low">/${lo}</span></div>
          </div>
        </summary>
        <div class="day-detail">
          ${detailHtml}
        </div>
      </details>
    `;
  }).join("");

  const toggleLabel = dailyExpanded ? "Show First 7 Days" : "Next 7 Days";
  const toggleHtml = shouldShowToggle
    ? `<div class="daily-toggle-wrap"><button class="daily-toggle" type="button" data-daily-toggle="true">${toggleLabel}</button></div>`
    : "";

  els.dailyContent.innerHTML = `<div class="daily-list">${list}</div>${toggleHtml}`;
  els.dailyCard.hidden = false;

  els.dailyContent.querySelector("[data-daily-toggle='true']")?.addEventListener("click", () => {
    dailyExpanded = !dailyExpanded;
    renderDaily(data);
  });
}

async function loadAndRender({ lat, lon, labelOverride = null, zipForUv = null }) {
  resetVisibleSections();
  setStatus("Loading forecast…");

  const data = await fetchWeather(lat, lon, zipForUv);
  hourlyVisibleCount = HOURLY_INITIAL_COUNT;
  selectedGraphMetric = "precipitation";
  dailyExpanded = false;

  localStorage.setItem(STORAGE_KEYS.lastLat, String(lat));
  localStorage.setItem(STORAGE_KEYS.lastLon, String(lon));
  if (labelOverride) localStorage.setItem(STORAGE_KEYS.label, labelOverride);

  const label = labelOverride || data?.location?.label || localStorage.getItem(STORAGE_KEYS.label) || "";
  setLocationLabel(label);
  setStatus("");

  trackEvent("weather_loaded", {
    action: "weather_rendered",
    locationLabel: label,
    locationLat: Number(lat),
    locationLon: Number(lon),
  });

  renderCurrent(data);
  renderAlerts(data);
  renderToday(data);
  renderWind(data);
  renderShoe(data);      // between Outlook and Sun/Moon
  renderEarthTile();
  renderAstroUv(data);
  renderHourly(data);
  renderGraphs(data);
  renderDaily(data);

  earthRefreshTimer = window.setInterval(() => {
    renderEarthTile();
  }, EARTH_SATELLITE_REFRESH_MS);
}

function getStoredSearch() {
  return safeText(localStorage.getItem(STORAGE_KEYS.search));
}

async function runSearch(query) {
  const q = safeText(query);
  if (!q) return;

  trackEvent("search_submitted", {
    action: "submit_search",
    searchQuery: q,
  });

  clearSuggestions();
  els.zipBtn.disabled = true;
  setStatus("Finding location…");

  try {
    const loc = await fetchLocation(q);
    trackEvent("search_resolved", {
      action: "location_lookup_success",
      searchQuery: q,
      locationLabel: safeText(loc.label),
      locationLat: Number(loc.lat),
      locationLon: Number(loc.lon),
      metadata: { zip: safeText(loc.zip), city: safeText(loc.city), state: safeText(loc.state) },
    });
    localStorage.setItem(STORAGE_KEYS.search, q);
    els.zipInput.value = q;

    try {
      await loadAndRender({
        lat: loc.lat,
        lon: loc.lon,
        labelOverride: loc.label,
        zipForUv: loc.zip || null,
      });
    } catch (err) {
      console.error(err);
      setStatus("Unable to load weather for that location right now.");
    }
  } catch (err) {
    console.error(err);
    trackEvent("search_failed", {
      action: "location_lookup_failed",
      searchQuery: q,
      metadata: { error: safeText(err?.message) },
    });
    setStatus("Could not find that location. Try ZIP or City, ST.");
  } finally {
    els.zipBtn.disabled = false;
  }
}

async function init() {
  setupExpandableTiles();
  setupFlippableCards();
  setupAlertDisclosure();
  setupWindCompassModal();

  [els.currentCard].forEach((card) => {
    card.setAttribute("data-expandable", "true");
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "button");
    card.setAttribute("aria-expanded", "false");
  });

  els.zipInput.addEventListener("input", async (e) => {
    const q = safeText(e.target.value);
    await queueLocationSuggestions(q);
  });

  els.zipInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      if (!suggestionItems.length) return;
      e.preventDefault();
      setActiveSuggestion((suggestionActiveIndex < 0 ? -1 : suggestionActiveIndex) + 1);
      return;
    }

    if (e.key === "ArrowUp") {
      if (!suggestionItems.length) return;
      e.preventDefault();
      setActiveSuggestion((suggestionActiveIndex < 0 ? 1 : suggestionActiveIndex) - 1);
      return;
    }

    if (e.key === "Escape") {
      clearSuggestions();
      return;
    }

    if (e.key === "Enter" && suggestionActiveIndex >= 0 && suggestionItems.length) {
      e.preventDefault();
      pickSuggestion(suggestionActiveIndex);
    }
  });

  els.locationSuggestions?.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".location-suggestion-item");
    if (!item) return;
    e.preventDefault();
    const index = Number(item.dataset.index);
    if (Number.isFinite(index)) pickSuggestion(index);
  });

  document.addEventListener("click", (e) => {
    if (e.target === els.zipInput || e.target.closest("#locationSuggestions")) return;
    clearSuggestions();
  });

  els.zipForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = safeText(els.zipInput.value);
    if (!query) {
      setStatus("Please enter a ZIP or City, ST.");
      return;
    }

   await runSearch(query);
  });

  const storedSearch = getStoredSearch();

if (!storedSearch) {
  // --- Codex/GitHub preview convenience: auto-load a default ZIP ---
  const params = new URLSearchParams(window.location.search);
  const zipFromUrl = safeText(params.get("zip"));

  const host = window.location.hostname || "";
  const isPreviewHost =
    host.includes("pages.dev") ||
    host.includes("localhost") ||
    host.includes("127.0.0.1") ||
    host.includes("codex") ||
    host.includes("github");

  const previewZip = zipFromUrl || (isPreviewHost ? "10001" : "");

  if (previewZip) {
    els.zipInput.value = previewZip;
    await runSearch(previewZip);
    return;
  }
}

  if ("geolocation" in navigator) {
    setStatus("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        trackEvent("geolocation_success", {
          action: "browser_geolocation_granted",
          userLat: Number(lat),
          userLon: Number(lon),
        });
        try {
          await loadAndRender({ lat, lon, labelOverride: null, zipForUv: null });
        } catch (err) {
          console.error(err);
          setStatus("Unable to load weather for your location.");
        }
      },
      async (err) => {
        console.warn(err);
        trackEvent("geolocation_failed", {
          action: "browser_geolocation_denied_or_failed",
          metadata: { code: err?.code || null, message: safeText(err?.message) },
        });
        const lastLat = Number(localStorage.getItem(STORAGE_KEYS.lastLat));
        const lastLon = Number(localStorage.getItem(STORAGE_KEYS.lastLon));
        if (Number.isFinite(lastLat) && Number.isFinite(lastLon)) {
          try {
            await loadAndRender({ lat: lastLat, lon: lastLon, labelOverride: null, zipForUv: null });
            return;
          } catch (e2) {
            console.error(e2);
          }
        }
        setStatus("Location permission denied. Enter a ZIP or City, ST to continue.");
      },
      { enableHighAccuracy: false, timeout: 7000, maximumAge: 300000 }
    );
  } else {
    setStatus("Geolocation not supported. Enter a ZIP or City, ST to continue.");
  }
}



document.addEventListener("click", (event) => {
  const target = event.target.closest("button, .card, summary, .location-suggestion-item, .graph-point, .metric-btn");
  if (!target) return;
  const text = safeText(target.innerText || target.textContent).slice(0, 120);
  trackEvent("ui_click", {
    action: "click",
    target: text || target.className || target.tagName,
  });
});
init().catch((e) => {
  console.error(e);
  setStatus("Something went wrong loading the app.");
});
