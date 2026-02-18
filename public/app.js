/* Almanac Weather - Frontend (Pages)
   - Calls same-origin Worker routes (/api/*) by default
   - Renders: Current, Outlook, Shoe, Sun & Moon (+UV), Hourly, Daily
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

  // ✅ Shoe
  shoeCard: document.getElementById("shoeCard"),
  shoeContent: document.getElementById("shoeContent"),

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
  els.shoeCard.hidden = true;
  els.astroUvCard.hidden = true;
  els.hourlyCard.hidden = true;
  els.dailyCard.hidden = true;

  els.currentContent.innerHTML = "";
  els.todayContent.innerHTML = "";
  els.shoeContent.innerHTML = "";
  els.astroUvContent.innerHTML = "";
  els.hourlyContent.innerHTML = "";
  els.dailyContent.innerHTML = "";
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

  const cleanName = (s) => safeText(s).replace(/^This\s+/i, "");

  const rows = outlook.periods.slice(0, 2).map(p => {
    const name = cleanName(p.name || "");
    const short = safeText(p.shortForecast || "");
    const icon = iconFromForecastIconUrl(p.icon, short);
    const temp = formatTempF(p.temperature);

    const pop = extractPopPercent(p);
    const showPop = (typeof pop === "number" && pop >= 10);

    return `
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
    `;
  }).join("");

  els.todayContent.innerHTML = `<div class="today-rows">${rows}</div>`;
  els.todayCard.hidden = false;
}

/* ✅ Shoe tile (swap emojis -> images) */

const SHOE_ICONS = {
  Sandal: "/assets/shoes/sandal.png",
  Sneaker: "/assets/shoes/sneaker.png",
  "Hiking Boot": "/assets/shoes/hiking-boot.png",
  Boot: "/assets/shoes/boot.png",
};

// If your filenames/paths differ, only update these strings.
function shoeIconSrcForLabel(label) {
  const key = safeText(label);
  return SHOE_ICONS[key] || SHOE_ICONS.Sneaker;
}

function shoeLabelFromSoilMoisture(sm) {
  const v = Number(sm);
  if (!Number.isFinite(v)) return { label: "—", sub: "—" };

  // Thresholds (match Worker): <0.12 dry, 0.12–0.22 damp, 0.22–0.32 wet, >0.32 muddy
  if (v < 0.12) return { label: "Sandal", sub: `${Math.round(v * 100)}% Soil Moisture` };
  if (v < 0.22) return { label: "Sneaker", sub: `${Math.round(v * 100)}% Soil Moisture` };
  if (v < 0.32) return { label: "Hiking Boot", sub: `${Math.round(v * 100)}% Soil Moisture` };
  return { label: "Boot", sub: `${Math.round(v * 100)}% Soil Moisture` };
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
      <div class="shoe-row">
        <div class="shoe-icon" aria-hidden="true">
          <img class="shoe-icon-img" src="${iconSrc}" alt="" />
        </div>
        <div class="shoe-text">
          <div class="shoe-title">${label}</div>
          <div class="shoe-sub">${sub}</div>
        </div>
      </div>

      <button class="shoe-info-btn" type="button" aria-label="About Shoe Index">i</button>

      <div class="shoe-popover" hidden>
        <div class="shoe-popover-title">About Shoe Index</div>
        <div class="shoe-popover-text">
          Shoe Index is a super scientific representation of moisture in the soil so you know what shoes to wear today.
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
            <span class="shoe-scale-range">12–21%</span>
          </div>
          <div class="shoe-scale-row">
            <span class="shoe-scale-emoji">
              <img class="shoe-scale-img" src="${SHOE_ICONS["Hiking Boot"]}" alt="" />
            </span>
            <span class="shoe-scale-label">Hiking Boot</span>
            <span class="shoe-scale-range">22–31%</span>
          </div>
          <div class="shoe-scale-row">
            <span class="shoe-scale-emoji">
              <img class="shoe-scale-img" src="${SHOE_ICONS.Boot}" alt="" />
            </span>
            <span class="shoe-scale-label">Boot</span>
            <span class="shoe-scale-range">32%+</span>
          </div>
        </div>
      </div>
    </div>
  `;

  // Toggle popover
  const wrap = els.shoeContent.querySelector(".shoe-wrap");
  const btn = els.shoeContent.querySelector(".shoe-info-btn");
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

  const sunrise = safeText(astro.sunrise);
  const sunset = safeText(astro.sunset);
  const moonrise = safeText(astro.moonrise);
  const moonset = safeText(astro.moonset);

  const { illum, waxing, label: phaseLabel } = moonIllumFromPhaseLabel(astro.moonPhase);

  const uv = data?.uv;
  const showUv = !!astro.isDaytimeNow;

  const uvLabel = (() => {
    if (!showUv) return "";
    if (uv?.ok && typeof uv.current === "number") return `UV ${Math.round(uv.current)}`;
    return "UV —";
  })();

  const srMin = parseHHMMToMinutes(sunrise);
  const ssMin = parseHHMMToMinutes(sunset);
  const nowMin = getNowMinutesInTimeZone(timeZone);

  let sunT = null;
  if (srMin !== null && ssMin !== null && nowMin !== null && ssMin > srMin) {
    sunT = clamp((nowMin - srMin) / (ssMin - srMin), 0, 1);
  }

  const moonIllumPct = (typeof illum === "number") ? Math.round(illum * 100) : null;
  const moonShadePct = (typeof illum === "number") ? Math.round((1 - illum) * 100) : 50;
  const moonDir = waxing === null ? "wax" : (waxing ? "wax" : "wane");

  const sunX = (typeof sunT === "number") ? (sunT * 100) : 50;
  const sunY = (typeof sunT === "number")
    ? ((1 - Math.sin(Math.PI * sunT)) * 100)
    : 100;

  els.astroUvContent.innerHTML = `
    <div class="astro-tiles">
      <div class="astro-tile sun-tile">
        <div class="astro-tile-head">
          <div class="astro-tile-title">Sun</div>
          ${showUv ? `<div class="astro-tile-pill">${uvLabel}</div>` : ``}
        </div>

        <div class="sun-arc" style="--sun-x:${sunX}%; --sun-y:${sunY}%;">
          <svg class="sun-arc-svg" viewBox="0 0 100 55" preserveAspectRatio="none" aria-hidden="true">
            <path d="M 0 55 Q 50 0 100 55" fill="none" />
          </svg>
          <div class="sun-dot" aria-hidden="true">☀️</div>

          <div class="sun-times">
            <div class="sun-time-left">${sunrise || "—"}</div>
            <div class="sun-time-right">${sunset || "—"}</div>
          </div>
        </div>
      </div>

      <div class="astro-tile moon-tile" style="--moon-shadow:${moonShadePct}%; --moon-dir:${moonDir};">
        <div class="astro-tile-head">
          <div class="astro-tile-title">Moon</div>
        </div>

        <div class="moon-wrap">
          <div class="moon-disc" aria-hidden="true"></div>
          <div class="moon-label">
            <div class="moon-phase">${phaseLabel || "—"}</div>
            <div class="moon-sub">⬆️ ${moonrise || "—"} • ⬇️ ${moonset || "—"}${moonIllumPct !== null ? ` • ${moonIllumPct}%` : ""}</div>
          </div>
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
    if (out.length >= 7) break;
  }

  if (out.length === 0) {
    return periods.slice(0, 7).map(p => ({ day: p, night: null }));
  }

  return out;
}

function renderDaily(data) {
  const daily = data?.daily;
  if (!daily || !Array.isArray(daily.periods) || daily.periods.length === 0) return;

  const timeZone = data?.timeZone || null;
  const metrics = data?.periodMetrics || {};

  const grouped = groupDailyIntoDays(daily.periods, timeZone);

  const list = grouped.map(({ day, night }) => {
    const name = safeText(day?.name || "");
    const short = safeText(day?.shortForecast || "");
    const icon = iconFromForecastIconUrl(day?.icon, short);

    const hi = formatTempF(day?.temperature);
    const lo = night ? formatTempF(night?.temperature) : "—";
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

    const buildTagsLine = ({ pop, windStr, dewF, rh }) => {
      const parts = [];
      if (typeof pop === "number") parts.push(`💧 ${pop}%`);
      if (windStr) parts.push(`💨 ${windStr}`);
      if (dewF !== null) parts.push(`Dew Point ${dewF}°F`);
      if (rh !== null) parts.push(`Relative Humidity ${rh}%`);
      return parts.length ? parts.join(" • ") : "";
    };

    const dayTags = buildTagsLine({ pop: popDay, windStr: windDay, dewF: dewDayF, rh: rhDay });
    const nightTags = night ? buildTagsLine({ pop: popNight, windStr: windNight, dewF: dewNightF, rh: rhNight }) : "";

    const dayDetail = stripChanceOfPrecipSentence(day?.detailedForecast || short);
    const nightDetail = night ? stripChanceOfPrecipSentence(night?.detailedForecast || night?.shortForecast) : "";

    const detailHtml = `
      <div class="day-detail-block">
        <div class="dn-title">Day</div>
        ${dayTags ? `<div class="detail-meta">${(when ? `${when} • ` : "") + dayTags}</div>` : (when ? `<div class="detail-meta">${when}</div>` : "")}
        <div class="dn-text">${dayDetail || "—"}</div>
      </div>
      ${
        night
          ? `<div class="day-detail-block">
               <div class="dn-title">Night</div>
               ${nightTags ? `<div class="detail-meta">${nightTags}</div>` : ``}
               <div class="dn-text">${nightDetail || "—"}</div>
             </div>`
          : ``
      }
    `;

    return `
      <details class="day-details">
        <summary class="day-summary">
          <div class="day-left">
            <div class="day-name">${name}</div>
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

  els.dailyContent.innerHTML = `<div class="daily-list">${list}</div>`;
  els.dailyCard.hidden = false;
}

async function loadAndRender({ lat, lon, labelOverride = null, zipForUv = null }) {
  resetVisibleSections();
  setStatus("Loading forecast…");

  const data = await fetchWeather(lat, lon, zipForUv);

  localStorage.setItem(STORAGE_KEYS.lastLat, String(lat));
  localStorage.setItem(STORAGE_KEYS.lastLon, String(lon));
  if (labelOverride) localStorage.setItem(STORAGE_KEYS.label, labelOverride);

  const label = labelOverride || data?.location?.label || localStorage.getItem(STORAGE_KEYS.label) || "";
  setStatus(label ? `Showing weather for ${label}` : "");

  renderCurrent(data);
  renderToday(data);
  renderShoe(data);      // between Outlook and Sun/Moon
  renderAstroUv(data);
  renderHourly(data);
  renderDaily(data);
}

function getStoredZip() {
  const z = safeText(localStorage.getItem(STORAGE_KEYS.zip));
  return /^\d{5}$/.test(z) ? z : "";
}

async function init() {
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
        zipForUv: zip,
      });
    } catch (err) {
      console.error(err);
      setStatus("Could not find that ZIP. Try another.");
    } finally {
      els.zipBtn.disabled = false;
    }
  });

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
