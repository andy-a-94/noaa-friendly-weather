const el = (id) => document.getElementById(id);

// Worker URL
const WORKER_BASE_URL = "";

// localStorage keys
const SAVED_ZIP_KEY = "savedWeatherZip";

const state = {
  lat: null,
  lon: null,
  data: null,
  hourlyShowAll: false,
};

function setStatus(title, subtitle, { loading = false } = {}) {
  el("statusTitle").textContent = title;
  el("statusSubtitle").textContent = subtitle;
  el("spinner").style.display = loading ? "inline-block" : "none";
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

function resetVisibleSections() {
  const ids = ["currentCard", "shoeCard", "todayCard", "hourlyCard", "dailyCard", "alertsSection", "alertsDetails"];
  for (const id of ids) {
    const node = el(id);
    if (node) node.hidden = true;
  }
  const details = el("alertsDetails");
  if (details) details.innerHTML = "";
}

/* ---------------- Menu ZIP UI ---------------- */

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

/* ---------------- Renderers ---------------- */

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

function getSoilMoisturePercent(data) {
  const directValue = data?.soilMoisture?.value ?? data?.soil?.moisture?.value ?? data?.soil?.moisture;
  if (typeof directValue === "number" && Number.isFinite(directValue)) {
    return Math.max(0, Math.min(100, directValue));
  }
  return null;
}

function renderShoeIndicator(data) {
  const card = el("shoeCard");
  if (!card) return;

  const moisture = getSoilMoisturePercent(data);
  let emoji = "👟";
  let title = "Soil moisture unavailable";
  let subtitle = "We’ll suggest the best shoes once moisture data is available.";
  let meta = "Soil moisture: —";

  if (moisture !== null) {
    if (moisture < 25) {
      emoji = "👟";
      title = "Dry ground";
      subtitle = "Light sneakers or running shoes should be comfortable.";
    } else if (moisture < 60) {
      emoji = "🥾";
      title = "Damp ground";
      subtitle = "Water-resistant shoes will keep feet dry.";
    } else {
      emoji = "👢";
      title = "Wet ground";
      subtitle = "Waterproof boots are your best bet.";
    }
    meta = `Soil moisture: ${Math.round(moisture)}%`;
  }

  el("shoeEmoji").textContent = emoji;
  el("shoeTitle").textContent = title;
  el("shoeSubtitle").textContent = subtitle;
  el("shoeMeta").textContent = meta;

  card.hidden = false;
}

// Outlook tile: first two daily periods (typically Today + Tonight)
function renderOutlook(dailyPeriods) {
  const card = el("todayCard");
  const list = el("todayList");
  if (!card || !list) return;

  const periods = Array.isArray(dailyPeriods) ? dailyPeriods : [];
  const picks = periods.slice(0, 2);

  list.innerHTML = picks
    .map((p) => {
      const name = safeText(p?.name, "—");
      const desc = safeText(p?.shortForecast, "—");
      const temp = `${safeText(p?.temperature, "--")}°${safeText(p?.temperatureUnit, "")}`;

      const pop = p?.probabilityOfPrecipitation?.value;
      const popTxt = typeof pop === "number" ? `${pop}% chance` : null;

      const windDir = safeText(p?.windDirection, "").trim();
      const windSpd = safeText(p?.windSpeed, "").trim();
      const windTxt = windDir || windSpd ? `Wind ${[windDir, windSpd].filter(Boolean).join(" ")}` : null;

      const meta = [popTxt, windTxt].filter(Boolean).join("\n") || "—";
      const iconUrl = safeText(p?.icon, "");

      return `
        <div class="segment-row">
          <img class="segment-icon" alt="" ${iconUrl ? `src="${iconUrl}"` : ""} />
          <div class="segment-name">${name}</div>
          <div class="segment-desc">${desc}</div>
          <div class="segment-right">
            <div class="segment-temp">${temp}</div>
            <div class="segment-pop">${meta.replaceAll("\n", "<br/>")}</div>
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

  const periods = Array.isArray(hourlyPeriods) ? hourlyPeriods : [];
  const visible = state.hourlyShowAll ? periods : periods.slice(0, 24);

  const frag = document.createDocumentFragment();
  for (const p of visible) {
    const tile = document.createElement("div");
    tile.className = "hour-card";

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

    tile.appendChild(t);
    tile.appendChild(temp);
    tile.appendChild(desc);
    tile.appendChild(img);

    frag.appendChild(tile);
  }
  row.appendChild(frag);

  // Toggle label
  const toggle = el("toggleHourlyBtn");
  if (toggle) {
    toggle.textContent = state.hourlyShowAll ? "Show less" : "Show all";
    toggle.hidden = periods.length <= 24;
  }

  card.hidden = false;
}

// Group dailyPeriods into “days” with day+night
function groupDaily(periods) {
  const out = [];
  const list = Array.isArray(periods) ? periods : [];

  // NWS commonly alternates: Today, Tonight, Fri, Fri Night, ...
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p) continue;

    if (p.isDaytime === true) {
      const night = list[i + 1] && list[i + 1].isDaytime === false ? list[i + 1] : null;
      out.push({ day: p, night });
    } else if (p.isDaytime === false) {
      // If data starts on a night period, still include it (rare)
      out.push({ day: null, night: p });
    }
  }
  return out;
}

function renderDailyExpandable(dailyPeriods) {
  const wrap = el("dailyList");
  const card = el("dailyCard");
  if (!wrap || !card) return;

  wrap.innerHTML = "";

  const groups = groupDaily(dailyPeriods);

  const frag = document.createDocumentFragment();

  for (const g of groups) {
    const day = g.day;
    const night = g.night;

    const title = day?.name || night?.name || formatDayName(day?.startTime || night?.startTime);
    const short = safeText(day?.shortForecast || night?.shortForecast, "—");

    const hi = day?.temperature != null ? `${day.temperature}°${safeText(day.temperatureUnit, "")}` : null;
    const lo = night?.temperature != null ? `${night.temperature}°${safeText(night.temperatureUnit, "")}` : null;

    const pop = day?.probabilityOfPrecipitation?.value ?? night?.probabilityOfPrecipitation?.value;
    const popTxt = typeof pop === "number" ? `${pop}% chance` : null;

    const iconUrl = safeText(day?.icon || night?.icon, "");

    const detailParts = [];
    if (day?.detailedForecast) detailParts.push(`Day: ${day.detailedForecast}`);
    if (night?.detailedForecast) detailParts.push(`Night: ${night.detailedForecast}`);

    const details = document.createElement("details");
    details.className = "day-details";

    const summary = document.createElement("summary");
    summary.className = "day-summary";

    const left = document.createElement("div");
    left.className = "day-left";

    const nameEl = document.createElement("div");
    nameEl.className = "day-name";
    nameEl.textContent = title;

    const forecastEl = document.createElement("div");
    forecastEl.className = "day-forecast";
    forecastEl.textContent = short;

    left.appendChild(nameEl);
    left.appendChild(forecastEl);

    const icon = document.createElement("img");
    icon.className = "day-icon";
    icon.alt = "";
    if (iconUrl) icon.src = iconUrl;

    const temp = document.createElement("div");
    temp.className = "day-temp";
    temp.textContent = [hi ? `H ${hi}` : null, lo ? `L ${lo}` : null].filter(Boolean).join(" • ") || "—";

    summary.appendChild(left);
    summary.appendChild(icon);
    summary.appendChild(temp);

    const expanded = document.createElement("div");
    expanded.className = "day-expanded";

    const meta = document.createElement("div");
    meta.className = "day-meta";
    meta.textContent = [popTxt].filter(Boolean).join(" • ");

    const extra = document.createElement("div");
    extra.className = "day-extra";
    extra.textContent = detailParts.join("\n\n") || "—";

    if (meta.textContent) expanded.appendChild(meta);
    expanded.appendChild(extra);

    details.appendChild(summary);
    details.appendChild(expanded);

    frag.appendChild(details);
  }

  wrap.appendChild(frag);
  card.hidden = false;
}

function renderAlerts(alerts) {
  const section = el("alertsSection");
  const summary = el("alertSummary");
  const detailsWrap = el("alertsDetails");

  if (!section || !summary || !detailsWrap) return;

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

/* ---------------- Main loading ---------------- */

async function loadAndRender(lat, lon, labelOverride = null) {
  resetVisibleSections();

  setStatus("Loading", "Connecting to National Weather Service…", { loading: true });

  const data = await fetchWeather(lat, lon);
  state.data = data;
  state.lat = lat;
  state.lon = lon;

  el("locationName").textContent = labelOverride || data?.location?.name || "Your area";

  renderAlerts(data.alerts || []);
  renderCurrent(data.hourlyPeriods || []);
  renderShoeIndicator(data);
  renderOutlook(data.dailyPeriods || []);
  renderHourly(data.hourlyPeriods || []);
  renderDailyExpandable(data.dailyPeriods || []);

  setStatus("Updated", `Last updated: ${new Date(data.fetchedAt).toLocaleTimeString()}`, { loading: false });
}

function setupMenuZipHandlers() {
  el("menuBtn").addEventListener("click", () => {
    const isOpen = el("topbarMenu") && !el("topbarMenu").hidden;
    setMenuOpen(!isOpen);
  });

  // Close the menu if you click outside it (best practice)
  document.addEventListener("click", (e) => {
    const menu = el("topbarMenu");
    const btn = el("menuBtn");
    if (!menu || !btn) return;

    const clickedInside = menu.contains(e.target) || btn.contains(e.target);
    if (!clickedInside) setMenuOpen(false);
  });

  // ESC closes menu
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setMenuOpen(false);
  });

  el("menuZipForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    clearMenuZipError();

    const zip = (el("menuZipInput").value || "").trim();
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

  const toggleHourlyBtn = el("toggleHourlyBtn");
  if (toggleHourlyBtn) {
    toggleHourlyBtn.addEventListener("click", () => {
      state.hourlyShowAll = !state.hourlyShowAll;
      renderHourly(state.data?.hourlyPeriods || []);
    });
  }
}

async function start() {
  setupMenuZipHandlers();

  // Hide retry button permanently (per your requirement)
  if (el("retryBtn")) el("retryBtn").hidden = true;

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
        setStatus("Could not load weather", safeText(err?.message, "Please search by ZIP code."), { loading: false });
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
