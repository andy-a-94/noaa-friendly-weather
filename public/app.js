const el = (id) => document.getElementById(id);

/* ---------------- Config ---------------- */

// For production on www.almanacweather.com, use same-origin /api/*
// For previews (pages.dev) you can optionally use the meta worker-base-url.
let WORKER_BASE_URL = "";

// localStorage keys
const SAVED_ZIP_KEY = "savedWeatherZip";

const state = {
  lat: null,
  lon: null,
  data: null,
  showAllHours: false,
};

/* ---------------- Small utilities ---------------- */

function normalizeBaseUrl(value) {
  const v = (value || "").trim();
  return v ? v.replace(/\/+$/, "") : "";
}

function getWorkerBaseUrl() {
  // If explicitly set in code, respect it.
  const explicit = normalizeBaseUrl(WORKER_BASE_URL);
  if (explicit) return explicit;

  const host = window.location.hostname.toLowerCase();

  // Production domains: force same-origin (prevents CORS/device issues).
  if (host === "almanacweather.com" || host === "www.almanacweather.com") {
    return "";
  }

  // Local dev / preview: allow meta override.
  const meta = document.querySelector('meta[name="worker-base-url"]');
  const fromMeta = normalizeBaseUrl(meta?.getAttribute("content"));
  return fromMeta || "";
}

function safeText(x, fallback = "—") {
  return x === null || x === undefined || x === "" ? fallback : String(x);
}

function formatHour(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "numeric" });
  } catch {
    return "—";
  }
}

function formatDayName(iso) {
  try {
    return new Date(iso).toLocaleDateString([], { weekday: "short" });
  } catch {
    return "—";
  }
}

function setStatus(title, subtitle, { loading = false } = {}) {
  const t = el("statusTitle");
  const s = el("statusSubtitle");
  const sp = el("spinner");
  const r = el("retryBtn");

  if (t) t.textContent = title;
  if (s) s.textContent = subtitle;
  if (sp) sp.style.display = loading ? "inline-block" : "none";

  // Keep Retry hidden for now.
  if (r) r.hidden = true;
}

/* ---------------- Menu ZIP UI ---------------- */

function isMenuOpen() {
  const menu = el("topbarMenu");
  return menu ? !menu.hidden : false;
}

function setMenuOpen(open) {
  const menu = el("topbarMenu");
  const btn = el("menuBtn");
  if (!menu || !btn) return;

  menu.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");

  if (open) {
    const input = el("menuZipInput");
    if (input) input.focus();
  }
}

function showMenuZipError(msg) {
  const p = el("menuZipError");
  if (!p) return;
  p.textContent = msg;
  p.hidden = false;
}

function clearMenuZipError() {
  const p = el("menuZipError");
  if (!p) return;
  p.textContent = "";
  p.hidden = true;
}

/* ---------------- Visibility ---------------- */

function resetVisibleSections() {
  const setHidden = (id, hidden) => {
    const node = el(id);
    if (node) node.hidden = hidden;
  };

  setHidden("currentCard", true);
  setHidden("shoeCard", true);
  setHidden("todayCard", true);
  setHidden("hourlyCard", true);
  setHidden("dailyCard", true);
  setHidden("alertsSection", true);
  setHidden("alertsDetails", true);

  const details = el("alertsDetails");
  if (details) details.innerHTML = "";
}

/* ---------------- API calls ---------------- */

async function fetchJsonOrThrow(url, fallbackMessage) {
  const res = await fetch(url, { method: "GET" });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || fallbackMessage);
  return data;
}

async function fetchLocationFromZip(zip) {
  const base = getWorkerBaseUrl();
  const url = `${base}/api/location?zip=${encodeURIComponent(zip)}`;
  return fetchJsonOrThrow(url, "ZIP lookup failed.");
}

async function fetchWeather(lat, lon) {
  const base = getWorkerBaseUrl();
  const url = `${base}/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
  return fetchJsonOrThrow(url, "Weather data is unavailable.");
}

/* ---------------- Renderers ---------------- */

function formatWind(dir, speed) {
  const s = safeText(speed, "").trim();
  const d = safeText(dir, "").trim();
  if (!s && !d) return null;
  if (s && d) return `${d} ${s}`;
  return s || d;
}

function renderCurrent(hourlyPeriods) {
  const cur = hourlyPeriods?.[0];
  if (!cur) return;

  const tempEl = el("currentTemp");
  const descEl = el("currentDesc");
  const metaEl = el("currentMeta");
  const iconEl = el("currentIcon");

  if (tempEl) tempEl.textContent = `${safeText(cur.temperature, "--")}°${safeText(cur.temperatureUnit, "")}`;
  if (descEl) descEl.textContent = safeText(cur.shortForecast, "--");

  const wind = cur.windSpeed ? `Wind ${safeText(cur.windSpeed)} ${safeText(cur.windDirection, "")}` : null;
  const pop = cur.probabilityOfPrecipitation?.value;
  const popTxt = typeof pop === "number" ? `Precip ${pop}%` : null;

  if (metaEl) metaEl.textContent = [wind, popTxt].filter(Boolean).join(" • ") || "—";

  if (iconEl) {
    if (cur.icon) {
      iconEl.src = cur.icon;
      iconEl.alt = safeText(cur.shortForecast, "Weather icon");
      iconEl.style.display = "block";
    } else {
      iconEl.style.display = "none";
    }
  }

  const card = el("currentCard");
  if (card) card.hidden = false;
}

// Outlook tile: Today + Tonight from dailyPeriods
function pickTodayTonight(dailyPeriods) {
  const periods = Array.isArray(dailyPeriods) ? dailyPeriods : [];
  const firstTwo = periods.slice(0, 2);
  if (firstTwo.length === 2) return firstTwo;

  const today = periods.find((p) => (p?.name || "").toLowerCase() === "today");
  const tonight = periods.find((p) => (p?.name || "").toLowerCase() === "tonight");
  return [today, tonight].filter(Boolean);
}

function renderToday(dailyPeriods) {
  const card = el("todayCard");
  const list = el("todayList");
  if (!card || !list) return;

  const picks = pickTodayTonight(dailyPeriods);
  if (!picks.length) {
    card.hidden = true;
    return;
  }

  list.innerHTML = picks
    .map((p) => {
      const name = safeText(p?.name, "—");
      const desc = safeText(p?.shortForecast, "—");
      const temp = `${safeText(p?.temperature, "--")}°${safeText(p?.temperatureUnit, "")}`;

      const pop = p?.probabilityOfPrecipitation?.value;
      const popTxt = typeof pop === "number" ? `${pop}% precip` : null;

      const wind = formatWind(p?.windDirection, p?.windSpeed);
      const windTxt = wind ? `Wind ${wind}` : null;

      const meta = [popTxt, windTxt].filter(Boolean).join(" • ") || "—";
      const iconUrl = safeText(p?.icon, "");

      return `
        <div class="segment-row">
          <img class="segment-icon" alt="" ${iconUrl ? `src="${iconUrl}"` : ""} />
          <div class="segment-name">${name}</div>
          <div class="segment-desc">${desc}</div>
          <div class="segment-right">
            <div class="segment-temp">${temp}</div>
            <div class="segment-pop">${meta}</div>
          </div>
        </div>
      `;
    })
    .join("");

  card.hidden = false;
}

function renderShoeIndicator(soilMoisture, hourlyPeriods) {
  const card = el("shoeCard");
  if (!card) return;

  // Always show
  card.hidden = false;

  const emojiEl = el("shoeEmoji");
  const titleEl = el("shoeTitle");
  const subEl = el("shoeSubtitle");
  const metaEl = el("shoeMeta");

  const cur = Array.isArray(hourlyPeriods) ? hourlyPeriods[0] : null;

  const pop = cur?.probabilityOfPrecipitation?.value;
  const popNum = typeof pop === "number" ? pop : null;

  const short = (cur?.shortForecast || "").toLowerCase();
  const precipWords = /(rain|shower|thunder|storm|drizzle|sleet|snow|ice)/.test(short);
  const precipLikely = precipWords || (popNum !== null && popNum >= 50);

  // Soil moisture is currently null from the Worker; keep future-proof logic anyway.
  const sm = typeof soilMoisture === "number" && Number.isFinite(soilMoisture) ? soilMoisture : null;
  const smPct = sm !== null ? `${Math.round(sm * 100)}%` : "—";

  let emoji = "👟";
  let title = "Sneakers look fine";
  let subtitle = "Based on current conditions.";

  if (sm !== null) {
    if (sm >= 0.6) {
      emoji = "👢";
      title = "Waterproof boots recommended";
      subtitle = "Ground looks wet.";
    } else if (sm >= 0.35) {
      emoji = "🥾";
      title = "Boots recommended";
      subtitle = "Ground may be damp.";
    }
  } else if (precipLikely) {
    emoji = "👢";
    title = "Waterproof boots recommended";
    subtitle = "Precipitation likely soon.";
  } else if (popNum !== null && popNum >= 25) {
    emoji = "🥾";
    title = "Boots recommended";
    subtitle = "Some precipitation possible.";
  }

  if (emojiEl) emojiEl.textContent = emoji;
  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = subtitle;

  const metaParts = [];
  metaParts.push(`Soil moisture: ${smPct}`);
  if (popNum !== null) metaParts.push(`Precip: ${popNum}%`);
  if (metaEl) metaEl.textContent = metaParts.join(" • ");
}

function renderHourly(hourlyPeriods) {
  const row = el("hourlyRow");
  const card = el("hourlyCard");
  const toggle = el("toggleHourlyBtn");
  if (!row || !card || !toggle) return;

  row.innerHTML = "";

  const periods = Array.isArray(hourlyPeriods) ? hourlyPeriods : [];
  if (!periods.length) {
    card.hidden = true;
    return;
  }

  const count = state.showAllHours ? Math.min(periods.length, 48) : Math.min(periods.length, 12);
  const slice = periods.slice(0, count);

  for (const p of slice) {
    const item = document.createElement("div");
    item.className = "hour-card";

    const t = document.createElement("div");
    t.className = "hour-time";
    t.textContent = formatHour(p.startTime);

    const temp = document.createElement("div");
    temp.className = "hour-temp";
    temp.textContent = `${safeText(p.temperature, "--")}°`;

    const desc = document.createElement("div");
    desc.className = "hour-desc";
    desc.textContent = safeText(p.shortForecast, "—");

    const img = document.createElement("img");
    img.className = "icon-sm";
    img.alt = "";
    if (p.icon) img.src = p.icon;

    item.appendChild(t);
    item.appendChild(temp);
    item.appendChild(desc);
    item.appendChild(img);

    row.appendChild(item);
  }

  toggle.textContent = state.showAllHours ? "Show less" : "Show all";
  toggle.onclick = () => {
    state.showAllHours = !state.showAllHours;
    renderHourly(state.data?.hourlyPeriods || []);
  };

  card.hidden = false;
}

function chooseDaily7(periods) {
  const list = Array.isArray(periods) ? periods : [];
  const daytime = list.filter((p) => p?.isDaytime === true);
  const src = daytime.length >= 7 ? daytime : list;
  return src.slice(0, 7);
}

function renderDaily(dailyPeriods) {
  const list = el("dailyList");
  const card = el("dailyCard");
  if (!list || !card) return;

  list.innerHTML = "";

  const days = chooseDaily7(dailyPeriods);
  if (!days.length) {
    card.hidden = true;
    return;
  }

  const formatWhen = (p) => {
    if (!p?.startTime || !p?.endTime) return null;
    try {
      const start = new Date(p.startTime);
      const end = new Date(p.endTime);
      const day = start.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      const s = start.toLocaleTimeString([], { hour: "numeric" });
      const e = end.toLocaleTimeString([], { hour: "numeric" });
      return `${day} • ${s}–${e}`;
    } catch {
      return null;
    }
  };

  for (const p of days) {
    const detailsEl = document.createElement("details");
    detailsEl.className = "day-details";

    const summaryEl = document.createElement("summary");
    summaryEl.className = "day-summary";

    const leftEl = document.createElement("div");
    leftEl.className = "day-left";

    const nameEl = document.createElement("div");
    nameEl.className = "day-name";
    nameEl.textContent = safeText(p?.name, formatDayName(p?.startTime));

    const forecastEl = document.createElement("div");
    forecastEl.className = "day-forecast";
    forecastEl.textContent = safeText(p?.shortForecast, "—");

    leftEl.appendChild(nameEl);
    leftEl.appendChild(forecastEl);

    const iconEl = document.createElement("img");
    iconEl.className = "day-icon";
    iconEl.alt = "";
    if (p?.icon) iconEl.src = p.icon;

    const tempEl = document.createElement("div");
    tempEl.className = "day-temp";
    tempEl.textContent = `${safeText(p?.temperature, "--")}°${safeText(p?.temperatureUnit, "")}`;

    summaryEl.appendChild(leftEl);
    summaryEl.appendChild(iconEl);
    summaryEl.appendChild(tempEl);

    const expandedEl = document.createElement("div");
    expandedEl.className = "day-expanded";

    const extraEl = document.createElement("div");
    extraEl.className = "day-extra";
    extraEl.textContent = safeText(p?.detailedForecast, safeText(p?.shortForecast, "—"));

    const whenTxt = formatWhen(p);
    const pop = p?.probabilityOfPrecipitation?.value;
    const popTxt = typeof pop === "number" ? `Precip: ${pop}%` : null;
    const wind = formatWind(p?.windDirection, p?.windSpeed);
    const windTxt = wind ? `Wind: ${wind}` : null;

    const metaEl = document.createElement("div");
    metaEl.className = "day-meta";
    metaEl.textContent = [whenTxt, popTxt, windTxt].filter(Boolean).join(" • ") || "—";

    expandedEl.appendChild(extraEl);
    expandedEl.appendChild(metaEl);

    detailsEl.appendChild(summaryEl);
    detailsEl.appendChild(expandedEl);

    // Keep UX tidy: one open at a time.
    detailsEl.addEventListener("toggle", () => {
      if (!detailsEl.open) return;
      list.querySelectorAll("details.day-details").forEach((d) => {
        if (d !== detailsEl) d.open = false;
      });
    });

    list.appendChild(detailsEl);
  }

  card.hidden = false;
}

function renderAlerts(alerts) {
  const section = el("alertsSection");
  const summary = el("alertSummary");
  const detailsWrap = el("alertsDetails");
  const toggleBtn = el("toggleAlertsBtn");

  if (!section || !summary || !detailsWrap || !toggleBtn) return;

  const list = Array.isArray(alerts) ? alerts : [];
  if (!list.length) {
    section.hidden = true;
    detailsWrap.hidden = true;
    detailsWrap.innerHTML = "";
    return;
  }

  section.hidden = false;
  summary.textContent = `${list.length} active alert${list.length === 1 ? "" : "s"} in your area`;

  detailsWrap.innerHTML = "";
  for (const a of list) {
    const card = document.createElement("details");
    card.className = "alert-item";

    const s = document.createElement("summary");
    s.textContent = a.headline || a.event || "Weather Alert";

    const meta = document.createElement("div");
    meta.className = "alert-meta";
    const parts = [
      a.severity ? `Severity: ${a.severity}` : null,
      a.urgency ? `Urgency: ${a.urgency}` : null,
      a.expires ? `Expires: ${new Date(a.expires).toLocaleString()}` : null,
    ].filter(Boolean);
    meta.textContent = parts.join(" • ") || "—";

    const body = document.createElement("div");
    body.className = "alert-text";
    body.textContent = [a.description, a.instruction].filter(Boolean).join("\n\n") || "—";

    card.appendChild(s);
    card.appendChild(meta);
    card.appendChild(body);

    detailsWrap.appendChild(card);
  }

  toggleBtn.onclick = () => {
    const open = !detailsWrap.hidden;
    detailsWrap.hidden = open;
    toggleBtn.textContent = open ? "Details" : "Hide";
    if (!open) detailsWrap.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  detailsWrap.hidden = true;
  toggleBtn.textContent = "Details";
}

/* ---------------- Main loading ---------------- */

async function loadAndRender(lat, lon, labelOverride = null) {
  resetVisibleSections();
  setStatus("Loading", "Connecting to National Weather Service…", { loading: true });

  const data = await fetchWeather(lat, lon);

  state.data = data;
  state.lat = lat;
  state.lon = lon;

  const loc = el("locationName");
  if (loc) loc.textContent = labelOverride || data?.location?.name || "Your area";

  renderAlerts(data.alerts || []);
  renderCurrent(data.hourlyPeriods || []);
  renderShoeIndicator(data.soilMoisture, data.hourlyPeriods || []);
  renderToday(data.dailyPeriods || []);
  renderHourly(data.hourlyPeriods || []);
  renderDaily(data.dailyPeriods || []);

  setStatus("Updated", `Last updated: ${new Date(data.fetchedAt).toLocaleTimeString()}`, { loading: false });
}

/* ---------------- Handlers ---------------- */

function setupMenuZipHandlers() {
  const btn = el("menuBtn");
  const menu = el("topbarMenu");
  const form = el("menuZipForm");

  if (btn && menu) {
    btn.addEventListener("click", () => setMenuOpen(!isMenuOpen()));

    // Close when clicking outside
    document.addEventListener("click", (e) => {
      if (!menu.contains(e.target) && !btn.contains(e.target)) setMenuOpen(false);
    });

    // ESC closes
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setMenuOpen(false);
    });
  }

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      clearMenuZipError();

      const zip = (el("menuZipInput")?.value || "").trim();
      if (!/^\d{5}$/.test(zip)) {
        showMenuZipError("Please enter a valid 5-digit ZIP code.");
        return;
      }

      localStorage.setItem(SAVED_ZIP_KEY, zip);

      try {
        setStatus("Loading", "Looking up ZIP…", { loading: true });

        const loc = await fetchLocationFromZip(zip);

        setMenuOpen(false);
        await loadAndRender(loc.lat, loc.lon, loc.label || `ZIP ${zip}`);
      } catch (err) {
        setStatus("Location could not be found", "Please search by ZIP code.", { loading: false });
        showMenuZipError(safeText(err?.message, "ZIP lookup failed."));
        setMenuOpen(true);
      }
    });
  }
}

/* ---------------- Start ---------------- */

function start() {
  setupMenuZipHandlers();

  setStatus("Location", "Requesting permission…", { loading: true });

  if (!("geolocation" in navigator)) {
    setStatus("Location could not be found", "Please search by ZIP code.", { loading: false });
    setMenuOpen(true);
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        await loadAndRender(pos.coords.latitude, pos.coords.longitude);
      } catch (err) {
        setStatus("Could not load weather", safeText(err?.message, "Failed to fetch."), { loading: false });
        setMenuOpen(true);
      }
    },
    () => {
      setStatus("Location could not be found", "Please search by ZIP code.", { loading: false });
      setMenuOpen(true);
    },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 5 * 60 * 1000 }
  );
}

start();
