const el = (id) => document.getElementById(id);

// Worker URL (same-origin)
const WORKER_BASE_URL = "";

// localStorage keys
const SAVED_ZIP_KEY = "savedWeatherZip";

const state = { lat: null, lon: null, data: null };

// ---------- Status ----------
function setStatus(title, subtitle, { loading = false, showRetry = false } = {}) {
  el("statusTitle").textContent = title;
  el("statusSubtitle").textContent = subtitle;
  el("spinner").style.display = loading ? "inline-block" : "none";
  el("retryBtn").hidden = !showRetry;
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

function chooseDaily7(periods) {
  const daytime = periods.filter((p) => p.isDaytime === true);
  const src = daytime.length >= 7 ? daytime : periods;
  return src.slice(0, 7);
}

// ---------- Today tile (Today / Tonight) ----------
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

      const windTxt = formatWind(p?.windDirection, p?.windSpeed);
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

// ---------- Render sections ----------
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

function renderCurrent(hourlyPeriods) {
  const cur = hourlyPeriods?.[0];
  if (!cur) return;

  el("currentTemp").textContent = `${safeText(cur.temperature, "--")}°${safeText(cur.temperatureUnit, "")}`;
  el("currentDesc").textContent = safeText(cur.shortForecast, "--");

  const wind = cur.windSpeed ? `Wind ${cur.windSpeed} ${safeText(cur.windDirection, "")}` : null;
  const pop = cur.probabilityOfPrecipitation?.value;
  const popTxt = typeof pop === "number" ? `Precip ${pop}%` : null;

  el("currentMeta").textContent = [wind, popTxt].filter(Boolean).join(" • ") || "—";

  if (cur.icon) {
    el("currentIcon").src = cur.icon;
    el("currentIcon").alt = safeText(cur.shortForecast, "Weather icon");
    el("currentIcon").style.display = "block";
  } else {
    el("currentIcon").style.display = "none";
  }

  el("currentCard").hidden = false;
}

function renderHourly(hourlyPeriods) {
  const row = el("hourlyRow");
  row.innerHTML = "";

  const next12 = (hourlyPeriods || []).slice(0, 12);
  for (const p of next12) {
    const card = document.createElement("div");
    card.className = "hour-card";

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

    card.appendChild(t);
    card.appendChild(temp);
    card.appendChild(desc);
    card.appendChild(img);
    row.appendChild(card);
  }

  el("hourlyCard").hidden = false;
}

function renderDaily(dailyPeriods) {
  const list = el("dailyList");
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

  el("dailyCard").hidden = false;
}

function renderAlerts(alerts) {
  const section = el("alertsSection");
  const summary = el("alertSummary");
  const detailsWrap = el("alertsDetails");

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

  el("toggleAlertsBtn").onclick = () => {
    const open = !detailsWrap.hidden;
    detailsWrap.hidden = open;
    el("toggleAlertsBtn").textContent = open ? "Details" : "Hide";
    if (!open) detailsWrap.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  detailsWrap.hidden = true;
  el("toggleAlertsBtn").textContent = "Details";
}

// ---------- ZIP menu (hamburger) helpers ----------
// This expects these elements in index.html:
// - button id="menuBtn" (hamburger button)
// - div/section id="menuPanel" (dropdown container, start hidden)
// - form id="menuZipForm" and input id="menuZipInput" (zip search UI)
// Optional: p/span id="menuZipHint" for helper text, p id="menuZipError" for errors
function setMenuOpen(open) {
  const panel = el("menuPanel");
  if (!panel) return;
  panel.hidden = !open;

  if (open) {
    const input = el("menuZipInput");
    if (input) setTimeout(() => input.focus(), 0);
  }
}

function setMenuHint(text) {
  const hint = el("menuZipHint");
  if (hint) hint.textContent = text;
}

function setMenuError(text) {
  const err = el("menuZipError");
  if (!err) return;
  if (text) {
    err.textContent = text;
    err.hidden = false;
  } else {
    err.textContent = "";
    err.hidden = true;
  }
}

async function fetchLocationFromZip(zip) {
  const url = `${WORKER_BASE_URL}/api/location?zip=${encodeURIComponent(zip)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || "ZIP lookup failed.");
  return data; // { zip, lat, lon, label, cached }
}

async function fetchWeather(lat, lon) {
  const url = `${WORKER_BASE_URL}/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || "Weather data is unavailable.");
  return data;
}

async function loadAndRender(lat, lon, labelOverride = null) {
  resetVisibleSections();
  setStatus("Loading", "Connecting to National Weather Service…", { loading: true, showRetry: false });

  const data = await fetchWeather(lat, lon);
  state.data = data;
  state.lat = lat;
  state.lon = lon;

  el("locationName").textContent = labelOverride || data?.location?.name || "Your area";

  renderAlerts(data.alerts || []);
  renderCurrent(data.hourlyPeriods || []);
  renderToday(data.dailyPeriods || []);
  renderHourly(data.hourlyPeriods || []);
  renderDaily(data.dailyPeriods || []);

  setStatus("Updated", `Last updated: ${new Date(data.fetchedAt).toLocaleTimeString()}`, {
    loading: false,
    showRetry: false,
  });
}

function setupMenuZipHandlers() {
  const menuBtn = el("menuBtn");
  const panel = el("menuPanel");
  const form = el("menuZipForm");
  const input = el("menuZipInput");

  if (menuBtn) {
    menuBtn.addEventListener("click", () => setMenuOpen(panel?.hidden ?? true));
  }

  // Close menu when clicking outside (subtle UX)
  document.addEventListener("click", (e) => {
    if (!panel || panel.hidden) return;
    const target = e.target;
    if (target === menuBtn || panel.contains(target)) return;
    setMenuOpen(false);
  });

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setMenuOpen(false);
  });

  if (!form || !input) return;

  // Prefill saved ZIP
  const savedZip = localStorage.getItem(SAVED_ZIP_KEY);
  if (savedZip && /^\d{5}$/.test(savedZip)) input.value = savedZip;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setMenuError("");

    const zip = (input.value || "").trim();
    if (!/^\d{5}$/.test(zip)) {
      setMenuError("Enter a valid 5-digit ZIP code.");
      return;
    }

    localStorage.setItem(SAVED_ZIP_KEY, zip);

    try {
      setStatus("Loading", "Looking up ZIP…", { loading: true, showRetry: false });
      const loc = await fetchLocationFromZip(zip);
      setMenuOpen(false);
      await loadAndRender(loc.lat, loc.lon, loc.label || `ZIP ${zip}`);
    } catch (err) {
      setStatus("Location could not be found", "Please search by ZIP code.", { loading: false, showRetry: false });
      setMenuError(safeText(err?.message, "ZIP lookup failed."));
    }
  });
}

async function start() {
  // Remove Radar button behavior (Radar button should also be removed from index.html)
  // If radarBtn still exists, do nothing.

  el("retryBtn").onclick = () => {
    resetVisibleSections();
    start();
  };

  setupMenuZipHandlers();
  setMenuHint("Search by ZIP code");

  setStatus("Location", "Requesting permission…", { loading: true, showRetry: false });

  if (!("geolocation" in navigator)) {
    setStatus("Location could not be found", "Please search by ZIP code.", { loading: false, showRetry: false });
    setMenuOpen(true);
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        await loadAndRender(pos.coords.latitude, pos.coords.longitude);
      } catch (err) {
        setStatus("Could not load weather", safeText(err?.message, "Please try again."), {
          loading: false,
          showRetry: true,
        });
        setMenuHint("Location failed. Search by ZIP code.");
        setMenuOpen(true);
      }
    },
    () => {
      setStatus("Location could not be found", "Please search by ZIP code.", { loading: false, showRetry: false });
      setMenuHint("Location blocked. Search by ZIP code.");
      setMenuOpen(true);
    },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 5 * 60 * 1000 }
  );
}

start();
