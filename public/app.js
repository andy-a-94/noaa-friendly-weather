const el = (id) => document.getElementById(id);

/* ---------------- Config ---------------- */

// Worker base URL:
// - Leave blank to use same-origin (if /api/* routes exist on the site domain)
// - If blank AND you have <meta name="worker-base-url" ...>, we will use that.
let WORKER_BASE_URL = "";

// localStorage keys
const SAVED_ZIP_KEY = "savedWeatherZip";

const state = { lat: null, lon: null, data: null };

/* ---------------- Small utilities ---------------- */

function getWorkerBaseUrl() {
  if (WORKER_BASE_URL && WORKER_BASE_URL.trim()) return WORKER_BASE_URL.trim();

  const meta = document.querySelector('meta[name="worker-base-url"]');
  const fromMeta = meta?.getAttribute("content")?.trim();
  if (fromMeta) return fromMeta.replace(/\/+$/, ""); // remove trailing slash

  return ""; // same-origin fallback
}

function safeText(x, fallback = "—") {
  return x === null || x === undefined || x === "" ? fallback : String(x);
}

function formatHour(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric" });
}

function formatDayName(iso) {
  return new Date(iso).toLocaleDateString([], { weekday: "short" });
}

function setStatus(title, subtitle, { loading = false, showRetry = false } = {}) {
  const t = el("statusTitle");
  const s = el("statusSubtitle");
  const sp = el("spinner");
  const r = el("retryBtn");

  if (t) t.textContent = title;
  if (s) s.textContent = subtitle;
  if (sp) sp.style.display = loading ? "inline-block" : "none";

  // If you want Retry gone forever, keep it hidden no matter what:
  if (r) r.hidden = true;

  // If you ever want Retry back later, use this instead:
  // if (r) r.hidden = !showRetry;
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
  setHidden("todayCard", true);
  setHidden("hourlyCard", true);
  setHidden("dailyCard", true);
  setHidden("alertsSection", true);
  setHidden("alertsDetails", true);

  const details = el("alertsDetails");
  if (details) details.innerHTML = "";
}

/* ---------------- ZIP fallback card (if still in HTML) ---------------- */

function showZipBox(message) {
  // If you still have #zipCard in the HTML, show it.
  // If you removed it, this just updates status + opens the menu.
  const zipCard = el("zipCard");
  const help = el("zipHelpText");

  if (help) help.textContent = message;

  if (zipCard) {
    zipCard.hidden = false;

    const savedZip = localStorage.getItem(SAVED_ZIP_KEY);
    const hasSaved = !!(savedZip && /^\d{5}$/.test(savedZip));

    const useBtn = el("useSavedZipBtn");
    const clearBtn = el("clearSavedZipBtn");
    if (useBtn) useBtn.hidden = !hasSaved;
    if (clearBtn) clearBtn.hidden = !hasSaved;

    const input = el("zipInput");
    if (hasSaved && input) input.value = savedZip;
  } else {
    // No zip card exists; rely on hamburger menu.
    setMenuOpen(true);
  }
}

function hideZipBox() {
  const zipCard = el("zipCard");
  const zipError = el("zipError");
  if (zipCard) zipCard.hidden = true;
  if (zipError) {
    zipError.hidden = true;
    zipError.textContent = "";
  }
}

function showZipError(msg) {
  const zipError = el("zipError");
  if (!zipError) return;
  zipError.textContent = msg;
  zipError.hidden = false;
}

/* ---------------- API calls ---------------- */

async function fetchLocationFromZip(zip) {
  const base = getWorkerBaseUrl();
  const url = `${base}/api/location?zip=${encodeURIComponent(zip)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || "ZIP lookup failed.");
  return data; // { zip, lat, lon, label, cached }
}

async function fetchWeather(lat, lon) {
  const base = getWorkerBaseUrl();
  const url = `${base}/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || "Weather data is unavailable.");
  return data;
}

/* ---------------- Renderers ---------------- */

function renderCurrent(hourlyPeriods) {
  const cur = hourlyPeriods?.[0];
  if (!cur) return;

  const tempEl = el("currentTemp");
  const descEl = el("currentDesc");
  const metaEl = el("currentMeta");
  const iconEl = el("currentIcon");

  if (tempEl) tempEl.textContent = `${safeText(cur.temperature, "--")}°${safeText(cur.temperatureUnit, "")}`;
  if (descEl) descEl.textContent = safeText(cur.shortForecast, "--");

  const wind = cur.windSpeed ? `Wind ${cur.windSpeed} ${safeText(cur.windDirection, "")}` : null;
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

function formatWind(dir, speed) {
  const s = safeText(speed, "").trim();
  const d = safeText(dir, "").trim();
  if (!s && !d) return null;
  if (s && d) return `${d} ${s}`;
  return s || d;
}

function renderToday(dailyPeriods) {
  const card = el("todayCard");
  if (!card) return;

  let list = el("todayList");
  if (!list) list = card.querySelector(".today-list");
  if (!list) {
    card.hidden = false;
    return;
  }

  const picks = pickTodayTonight(dailyPeriods);

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

function renderHourly(hourlyPeriods) {
  const row = el("hourlyRow");
  const card = el("hourlyCard");
  if (!row || !card) return;

  row.innerHTML = "";

  const next12 = (hourlyPeriods || []).slice(0, 12);
  for (const p of next12) {
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

  card.hidden = false;
}

function chooseDaily7(periods) {
  const daytime = periods.filter((p) => p.isDaytime === true);
  const src = daytime.length >= 7 ? daytime : periods;
  return src.slice(0, 7);
}

function renderDaily(dailyPeriods) {
  const list = el("dailyList");
  const card = el("dailyCard");
  if (!list || !card) return;

  list.innerHTML = "";

  const days = chooseDaily7(dailyPeriods || []);
  for (const p of days) {
    const row = document.createElement("div");
    row.className = "day-row";

    const left = document.createElement("div");
    left.className = "day-left";

    const name = document.createElement("div");
    name.className = "day-name";
    name.textContent = p.name || formatDayName(p.startTime);

    const forecast = document.createElement("div");
    forecast.className = "day-forecast";
    forecast.textContent = safeText(p.shortForecast, "—");

    left.appendChild(name);
    left.appendChild(forecast);

    const icon = document.createElement("img");
    icon.className = "day-icon";
    icon.alt = "";
    if (p.icon) icon.src = p.icon;

    const temp = document.createElement("div");
    temp.className = "day-temp";
    temp.textContent = `${safeText(p.temperature, "--")}°${safeText(p.temperatureUnit, "")}`;

    row.appendChild(left);
    row.appendChild(icon);
    row.appendChild(temp);

    list.appendChild(row);
  }

  card.hidden = false;
}

function renderAlerts(alerts) {
  const section = el("alertsSection");
  const summary = el("alertSummary");
  const detailsWrap = el("alertsDetails");
  const toggleBtn = el("toggleAlertsBtn");

  if (!section || !summary || !detailsWrap || !toggleBtn) return;

  if (!alerts || alerts.length === 0) {
    section.hidden = true;
    detailsWrap.hidden = true;
    detailsWrap.innerHTML = "";
    return;
  }

  section.hidden = false;
  summary.textContent = `${alerts.length} active alert${alerts.length === 1 ? "" : "s"} in your area`;

  detailsWrap.innerHTML = "";
  for (const a of alerts) {
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
  hideZipBox();
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

function setupZipCardHandlersIfPresent() {
  const form = el("zipForm");
  if (!form) return; // zipCard not present, ignore

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const zipError = el("zipError");
    if (zipError) zipError.hidden = true;

    const zip = (el("zipInput")?.value || "").trim();
    if (!/^\d{5}$/.test(zip)) {
      showZipError("Please enter a valid 5-digit ZIP code.");
      return;
    }

    localStorage.setItem(SAVED_ZIP_KEY, zip);

    try {
      setStatus("Loading", "Looking up ZIP…", { loading: true });
      const loc = await fetchLocationFromZip(zip);
      await loadAndRender(loc.lat, loc.lon, loc.label || `ZIP ${zip}`);
    } catch (err) {
      setStatus("Location could not be found", "Please search by ZIP code.", { loading: false });
      showZipError(safeText(err?.message, "ZIP lookup failed."));
      showZipBox("Location could not be found. Please search by ZIP code.");
    }
  });

  const useSaved = el("useSavedZipBtn");
  if (useSaved) {
    useSaved.addEventListener("click", () => {
      const zip = localStorage.getItem(SAVED_ZIP_KEY);
      if (!zip) return;
      const input = el("zipInput");
      if (input) input.value = zip;
      form.requestSubmit();
    });
  }

  const clearSaved = el("clearSavedZipBtn");
  if (clearSaved) {
    clearSaved.addEventListener("click", () => {
      localStorage.removeItem(SAVED_ZIP_KEY);
      const input = el("zipInput");
      if (input) input.value = "";
      if (useSaved) useSaved.hidden = true;
      clearSaved.hidden = true;
      showZipError("Saved ZIP cleared.");
    });
  }
}

/* ---------------- Start ---------------- */

async function start() {
  // Always wire up hamburger first (so user can recover even if location fails)
  setupMenuZipHandlers();
  setupZipCardHandlersIfPresent();

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
        // “Failed to fetch” commonly means Worker route / CORS / domain mismatch
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
