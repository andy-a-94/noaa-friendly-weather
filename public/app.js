/* Almanac Weather - Frontend (Pages)
   - Calls same-origin Worker routes (/api/*) by default
   - Renders: Current, Outlook, Sun & Moon (+UV), Hourly, Daily
*/

const els = {
  statusBar: document.getElementById("statusBar"),

  zipForm: document.getElementById("zipForm"),
  zipInput: document.getElementById("zipInput"),
  zipBtn: document.getElementById("zipBtn"),

  currentCard: document.getElementById("currentCard"),
  currentContent: document.getElementById("currentContent"),

  todayCard: document.getElementById("todayCard"),
  todayContent: document.getElementById("todayContent"),

  astroUvCard: document.getElementById("astroUvCard"),
  astroUvContent: document.getElementById("astroUvContent"),

  hourlyCard: document.getElementById("hourlyCard"),
  hourlyContent: document.getElementById("hourlyContent"),

  dailyCard: document.getElementById("dailyCard"),
  dailyContent: document.getElementById("dailyContent"),
};

const STORAGE_KEYS = {
  zip: "aw_zip",
  lastLat: "aw_lat",
  lastLon: "aw_lon",
  label: "aw_label",
};

function getWorkerBaseUrl() {
  const meta = document.querySelector('meta[name="worker-base-url"]');
  const v = meta?.getAttribute("content")?.trim();
  return v ? v.replace(/\/+$/, "") : "";
}
const WORKER_BASE = getWorkerBaseUrl();

function apiUrl(path, params = {}) {
  const u = new URL(`${WORKER_BASE}${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).length) u.searchParams.set(k, v);
  }
  return u.toString();
}

function setStatus(msg) {
  els.statusBar.textContent = msg || "";
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
  return t === null ? "—" : `${t}°F`;
}

function parseWind(dir, speedStr) {
  const d = safeText(dir);
  const s = safeText(speedStr);
  if (!d && !s) return "";
  // Keep NWS windSpeed string as-is (e.g., "2 to 7 mph"), just append direction.
  return `${s}${d ? ` ${d}` : ""}`.trim();
}

function stripChanceOfPrecipSentence(text) {
  // Remove the specific “Chance of precipitation is XX%.” sentence so we don't show duplicate %s.
  let t = safeText(text);
  t = t.replace(/\s*Chance of precipitation is\s*\d+%\.?\s*/gi, " ");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
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

async function fetchLocationByZip(zip) {
  const res = await fetch(apiUrl("/api/location", { zip }), { cache: "no-store" });
  if (!res.ok) throw new Error(`Location lookup failed (${res.status})`);
  return await res.json();
}

async function fetchWeather(lat, lon, zip) {
  const res = await fetch(apiUrl("/api/weather", { lat, lon, zip }), { cache: "no-store" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Weather fetch failed (${res.status}) ${t}`);
  }
  return await res.json();
}

function resetVisibleSections() {
  els.currentCard.hidden = true;
  els.todayCard.hidden = true;
  els.astroUvCard.hidden = true;
  els.hourlyCard.hidden = true;
  els.dailyCard.hidden = true;

  els.currentContent.innerHTML = "";
  els.todayContent.innerHTML = "";
  els.astroUvContent.innerHTML = "";
  els.hourlyContent.innerHTML = "";
  els.dailyContent.innerHTML = "";
}

function iconFromForecastIconUrl(url, shortForecast) {
  // Basic mapping to keep the aesthetic consistent without depending on NWS image assets.
  // (You can refine/replace later with your own SVG set.)
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

  els.currentContent.innerHTML = `
    <div class="current-row">
      <div>
        <div class="current-temp">${temp}</div>
        <div class="current-desc">${desc}</div>
        ${meta ? `<div class="current-meta">${meta}</div>` : ""}
      </div>
      <div class="wx-icon" aria-hidden="true">${icon}</div>
    </div>
  `;

  // Alerts (optional)
  if (Array.isArray(data.alerts) && data.alerts.length) {
    const pills = data.alerts
      .slice(0, 6)
      .map(a => `<span class="alert-pill">⚠️ ${safeText(a.event || "Alert")}</span>`)
      .join("");
    els.currentContent.insertAdjacentHTML("beforeend", `<div class="alerts">${pills}</div>`);
  }

  els.currentCard.hidden = false;
}

function renderToday(data) {
  const outlook = data?.outlook;
  if (!outlook || !Array.isArray(outlook.periods) || outlook.periods.length === 0) return;

  const rows = outlook.periods.slice(0, 2).map(p => {
    const name = safeText(p.name || "");
    const short = safeText(p.shortForecast || "");
    const icon = iconFromForecastIconUrl(p.icon, short);
    const temp = formatTempF(p.temperature);

    const windStr = parseWind(p.windDirection, p.windSpeed);
    const pop = extractPopPercent(p);

    const badges = [];
    if (typeof pop === "number" && pop >= 10) {
      badges.push(`<span class="pop-badge"><span class="drop">💧</span>${pop}%</span>`);
    }
    if (windStr) {
      badges.push(`<span class="pop-badge"><span class="drop">💨</span>${windStr}</span>`);
    }

    return `
      <div class="today-row">
        <div class="wx-icon-sm" aria-hidden="true">${icon}</div>
        <div class="today-mid">
          <div class="today-name">${name}</div>
          <div class="today-short">${short || "—"}</div>
        </div>
        <div class="today-right">
          <div class="today-temp">${temp}</div>
          <div class="today-badges">${badges.join("")}</div>
        </div>
      </div>
    `;
  }).join("");

  els.todayContent.innerHTML = `<div class="today-rows">${rows}</div>`;
  els.todayCard.hidden = false;
}

function renderAstroUv(data) {
  const astro = data?.astro;
  if (!astro) return;

  const sunrise = safeText(astro.sunrise);
  const sunset = safeText(astro.sunset);
  const moonrise = safeText(astro.moonrise);
  const moonset = safeText(astro.moonset);
  const phase = safeText(astro.moonPhase);
  const illum = (typeof astro.moonIlluminationPct === "number")
    ? `${Math.round(astro.moonIlluminationPct)}%`
    : "";

  const uv = data?.uv;
  const showUv = !!astro.isDaytimeNow;

  const uvPills = [];
  if (showUv) {
    if (uv?.ok && typeof uv.current === "number") {
      uvPills.push(`<span class="pop-badge"><span class="drop">🔆</span>UV ${Math.round(uv.current)}</span>`);
      if (typeof uv.max === "number") {
        uvPills.push(`<span class="pop-badge muted">Max ${Math.round(uv.max)}</span>`);
      }
    } else {
      uvPills.push(`<span class="pop-badge muted">🔆 UV —</span>`);
    }
  }

  els.astroUvContent.innerHTML = `
    <div class="astro-stack">
      <div class="astro-line">
        <div>
          <div class="astro-title">Sun</div>
          <div class="astro-sub">🌅 ${sunrise || "—"} • 🌇 ${sunset || "—"}</div>
        </div>
        <div class="astro-right">
          ${uvPills.join("")}
        </div>
      </div>

      <div class="astro-line">
        <div>
          <div class="astro-title">Moon</div>
          <div class="astro-sub">🌙 ${phase || "—"}${illum ? ` • ${illum}` : ""}<br/>⬆️ ${moonrise || "—"} • ⬇️ ${moonset || "—"}</div>
        </div>
      </div>
    </div>
  `;

  els.astroUvCard.hidden = false;
}

function renderHourly(data) {
  const hourly = data?.hourly;
  if (!hourly || !Array.isArray(hourly.periods) || hourly.periods.length === 0) return;

  const timeZone = data?.timeZone || null;

  const cards = hourly.periods.slice(0, 18).map(p => {
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

    const temp = formatTempF(p.temperature);
    const desc = safeText(p.shortForecast || "");
    const icon = iconFromForecastIconUrl(p.icon, desc);
    const pop = extractPopPercent(p);

    return `
      <div class="hour-card">
        <div class="hour-time">${time}</div>
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
    `;
  }).join("");

  els.hourlyContent.innerHTML = `<div class="row-scroll">${cards}</div>`;
  els.hourlyCard.hidden = false;
}

function renderDaily(data) {
  const daily = data?.daily;
  if (!daily || !Array.isArray(daily.periods) || daily.periods.length === 0) return;

  const timeZone = data?.timeZone || null;
  const metrics = data?.periodMetrics || {};

  const list = daily.periods.slice(0, 8).map(p => {
    const name = safeText(p.name || "");
    const short = safeText(p.shortForecast || "");
    const icon = iconFromForecastIconUrl(p.icon, short);
    const temp = formatTempF(p.temperature);

    const pop = extractPopPercent(p);

    // For expanded details
    const when = formatDateShort(p.startTime, timeZone);
    const windStr = parseWind(p.windDirection, p.windSpeed);

    const m = metrics?.[String(p.number)] || metrics?.[p.number];
    const dewF = (m && typeof m.dewpointF === "number") ? Math.round(m.dewpointF) : null;
    const rh = (m && typeof m.relativeHumidityPct === "number") ? Math.round(m.relativeHumidityPct) : null;

    const metaParts = [];
    if (when) metaParts.push(when);
    if (typeof pop === "number") metaParts.push(`💧 ${pop}%`);
    if (windStr) metaParts.push(`💨 ${windStr}`);
    if (dewF !== null) metaParts.push(`🌱 ${dewF}°F`);
    if (rh !== null) metaParts.push(`Relative Humidity ${rh}%`);

    const detailText = stripChanceOfPrecipSentence(p.detailedForecast || short);

    return `
      <details class="day-details">
        <summary class="day-summary">
          <div class="day-left">
            <div class="day-name">${name}</div>
            <div class="day-short">${short || "—"}</div>
          </div>
          <div class="day-right">
            ${
              (typeof pop === "number" && pop >= 10)
                ? `<span class="pop-badge"><span class="drop">💧</span>${pop}%</span>`
                : ``
            }
            <div class="wx-icon-sm" aria-hidden="true">${icon}</div>
            <div class="day-temp">${temp}</div>
          </div>
        </summary>
        <div class="day-detail">
          ${detailText || "—"}
          ${metaParts.length ? `<div class="detail-meta">${metaParts.join(" • ")}</div>` : ""}
        </div>
      </details>
    `;
  }).join("");

  els.dailyContent.innerHTML = `<div class="daily-list">${list}</div>`;
  els.dailyCard.hidden = false;
}

async function loadAndRender({ lat, lon, labelOverride = null, zipForUv = null }) {
  resetVisibleSections();
  setStatus("Loading forecast…");

  const data = await fetchWeather(lat, lon, zipForUv);

  // Persist last-known location
  localStorage.setItem(STORAGE_KEYS.lastLat, String(lat));
  localStorage.setItem(STORAGE_KEYS.lastLon, String(lon));
  if (labelOverride) localStorage.setItem(STORAGE_KEYS.label, labelOverride);

  // Optional: update status with label
  const label = labelOverride || data?.location?.label || localStorage.getItem(STORAGE_KEYS.label) || "";
  setStatus(label ? `Showing weather for ${label}` : "");

  renderCurrent(data);
  renderToday(data);
  renderAstroUv(data);
  renderHourly(data);
  renderDaily(data);
}

function getStoredZip() {
  const z = safeText(localStorage.getItem(STORAGE_KEYS.zip));
  return /^\d{5}$/.test(z) ? z : "";
}

async function init() {
  // ZIP form
  els.zipForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const zip = safeText(els.zipInput.value);
    if (!/^\d{5}$/.test(zip)) {
      setStatus("Please enter a valid 5-digit ZIP code.");
      return;
    }

    els.zipBtn.disabled = true;
    setStatus("Finding ZIP location…");
    try {
      const loc = await fetchLocationByZip(zip);
      localStorage.setItem(STORAGE_KEYS.zip, zip);
      els.zipInput.value = zip;

      await loadAndRender({
        lat: loc.lat,
        lon: loc.lon,
        labelOverride: loc.label,
        zipForUv: zip, // helps UV resolve even if city/state differs slightly
      });
    } catch (err) {
      console.error(err);
      setStatus("Could not find that ZIP. Try another.");
    } finally {
      els.zipBtn.disabled = false;
    }
  });

  // Auto-load: prefer stored ZIP, else geolocation, else last lat/lon
  const storedZip = getStoredZip();
  if (storedZip) {
    els.zipInput.value = storedZip;
    try {
      setStatus("Loading saved ZIP…");
      const loc = await fetchLocationByZip(storedZip);
      await loadAndRender({
        lat: loc.lat,
        lon: loc.lon,
        labelOverride: loc.label,
        zipForUv: storedZip,
      });
      return;
    } catch (e) {
      console.warn("Stored ZIP failed, falling back.", e);
    }
  }

  // Geolocation
  if ("geolocation" in navigator) {
    setStatus("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        try {
          await loadAndRender({ lat, lon, labelOverride: null, zipForUv: null });
        } catch (err) {
          console.error(err);
          setStatus("Unable to load weather for your location.");
        }
      },
      async (err) => {
        console.warn(err);
        // Fallback to last known
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
        setStatus("Location permission denied. Enter a ZIP to continue.");
      },
      { enableHighAccuracy: false, timeout: 7000, maximumAge: 300000 }
    );
  } else {
    setStatus("Geolocation not supported. Enter a ZIP to continue.");
  }
}

init().catch((e) => {
  console.error(e);
  setStatus("Something went wrong loading the app.");
});
