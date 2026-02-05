const el = (id) => document.getElementById(id);

// Worker URL
const WORKER_BASE_URL = "";

// localStorage keys
const SAVED_ZIP_KEY = "savedWeatherZip";

const state = { lat: null, lon: null, data: null };

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

// ===== Today tile helpers (Today / Tonight from NWS dailyPeriods) =====
function pickTodayTonight(dailyPeriods) {
  const periods = Array.isArray(dailyPeriods) ? dailyPeriods : [];

  // NWS dailyPeriods are typically ordered: Today, Tonight, Fri, Fri Night, ...
  const firstTwo = periods.slice(0, 2);
  if (firstTwo.length === 2) return firstTwo;

  // Fallback: name matching
  const today = periods.find((p) => (p?.name || "").toLowerCase() === "today");
  const tonight = periods.find((p) => (p?.name || "").toLowerCase() === "tonight");
  return [today, tonight].filter(Boolean);
}

function formatWind(dir, speed) {
  const s = safeText(speed, "").trim();
  const d = safeText(dir, "").trim();
  if (!s && !d) return null;
  if (s && d) return `Wind ${d} ${s}`;
  return `Wind ${s || d}`;
}

function formatChance(popValue) {
  return typeof popValue === "number" ? `${popValue}% Chance` : null;
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
      const shortForecast = safeText(p?.shortForecast, "—");

      const temp = `${safeText(p?.temperature, "--")}°${safeText(p?.temperatureUnit, "")}`;

      const pop = p?.probabilityOfPrecipitation?.value;
      const chanceLine = formatChance(pop);

      const windLine = formatWind(p?.windDirection, p?.windSpeed);

      const iconUrl = safeText(p?.icon, "");

      // Lines under temp: % Chance (top) then Wind (bottom)
      const line1 = chanceLine || "—";
      const line2 = windLine || "—";

      return `
        <div class="segment-row">
          <div class="segment-name">${name}</div>

          <img class="segment-icon" alt="" ${iconUrl ? `src="${iconUrl}"` : ""} />

          <div class="segment-desc">${shortForecast}</div>

          <div class="segment-right">
            <div class="segment-temp">${temp}</div>
            <div class="segment-meta">
              <div class="segment-line">${line1}</div>
              <div class="segment-line">${line2}</div>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  card.hidden = false;
}

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

function showZipBox(message) {
  // If you still have zipCard in your HTML, keep using it.
  // If you later move ZIP to the hamburger menu only, you can remove this.
  const zipCard = el("zipCard");
  if (!zipCard) return;

  el("zipHelpText").textContent = message;
  zipCard.hidden = false;

  const savedZip = localStorage.getItem(SAVED_ZIP_KEY);
  const hasSaved = !!(savedZip && /^\d{5}$/.test(savedZip));

  const useSavedBtn = el("useSavedZipBtn");
  const clearSavedBtn = el("clearSavedZipBtn");
  if (useSavedBtn) useSavedBtn.hidden = !hasSaved;
  if (clearSavedBtn) clearSavedBtn.hidden = !hasSaved;

  if (hasSaved) el("zipInput").value = savedZip;
}

function hideZipBox() {
  const zipCard = el("zipCard");
  if (!zipCard) return;

  zipCard.hidden = true;

  const err = el("zipError");
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
}

function showZipError(msg) {
  const err = el("zipError");
  if (!err) return;
  err.textContent = msg;
  err.hidden = false;
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

function renderCurrent(hourlyPeriods) {
  const cur = hourlyPeriods?.[0];
  if (!cur) return;

  el("currentTemp").textContent = `${safeText(cur.temperature, "--")}°${safeText(cur.temperatureUnit, "")}`;
  el("currentDesc").textContent = safeText(cur.shortForecast, "--");

  const wind = cur.windSpeed ? `Wind ${safeText(cur.windDirection, "")} ${cur.windSpeed}`.trim() : null;
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

async function loadAndRender(lat, lon, labelOverride = null) {
  hideZipBox();
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

function setupZipHandlers() {
  const zipForm = el("zipForm");
  if (!zipForm) return;

  zipForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = el("zipError");
    if (err) err.hidden = true;

    const zip = (el("zipInput").value || "").trim();
    if (!/^\d{5}$/.test(zip)) {
      showZipError("Please enter a valid 5-digit ZIP code.");
      return;
    }

    localStorage.setItem(SAVED_ZIP_KEY, zip);

    try {
      setStatus("Loading", "Looking up ZIP…", { loading: true, showRetry: false });
      const loc = await fetchLocationFromZip(zip);
      await loadAndRender(loc.lat, loc.lon, loc.label || `ZIP ${zip}`);
    } catch (error) {
      setStatus("Could not load weather", safeText(error?.message, "Please try again."), {
        loading: false,
        showRetry: true,
      });
      showZipBox("ZIP lookup failed. Please try again.");
      showZipError(safeText(error?.message, "ZIP lookup failed."));
    }
  });

  const useSavedBtn = el("useSavedZipBtn");
  if (useSavedBtn) {
    useSavedBtn.addEventListener("click", () => {
      const zip = localStorage.getItem(SAVED_ZIP_KEY);
      if (!zip) return;
      el("zipInput").value = zip;
      zipForm.requestSubmit();
    });
  }

  const clearSavedBtn = el("clearSavedZipBtn");
  if (clearSavedBtn) {
    clearSavedBtn.addEventListener("click", () => {
      localStorage.removeItem(SAVED_ZIP_KEY);
      el("zipInput").value = "";
      if (useSavedBtn) useSavedBtn.hidden = true;
      clearSavedBtn.hidden = true;
      showZipError("Saved ZIP cleared.");
    });
  }
}

async function start() {
  // If radarBtn exists in your HTML, this will work; otherwise it won’t throw.
  const radarBtn = el("radarBtn");
  if (radarBtn) radarBtn.onclick = () => window.open("https://radar.weather.gov/", "_blank", "noopener,noreferrer");

  el("retryBtn").onclick = () => {
    resetVisibleSections();
    hideZipBox();
    start();
  };

  setupZipHandlers();

  setStatus("Location", "Requesting permission…", { loading: true, showRetry: false });

  if (!("geolocation" in navigator)) {
    setStatus("Location unavailable", "Enter ZIP code below.", { loading: false, showRetry: false });
    showZipBox("Geolocation is not available. Enter ZIP code.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        await loadAndRender(pos.coords.latitude, pos.coords.longitude);
      } catch (error) {
        setStatus("Could not load weather", safeText(error?.message, "Please try again."), {
          loading: false,
          showRetry: true,
        });
        showZipBox("Weather failed to load. Enter ZIP code instead.");
      }
    },
    () => {
      setStatus("Location blocked", "Enter ZIP code below.", { loading: false, showRetry: true });

      const savedZip = localStorage.getItem(SAVED_ZIP_KEY);
      if (savedZip && /^\d{5}$/.test(savedZip)) {
        showZipBox("Location is blocked. You can use your saved ZIP or enter a new one.");
      } else {
        showZipBox("Location is blocked on this computer. Enter ZIP code.");
      }
    },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 5 * 60 * 1000 }
  );
}

start();
