const el = (id) => document.getElementById(id);

const state = {
  lat: null,
  lon: null,
  data: null,
};

function setStatus(title, subtitle, { loading = false, showRetry = false } = {}) {
  el("statusTitle").textContent = title;
  el("statusSubtitle").textContent = subtitle;
  el("spinner").style.display = loading ? "inline-block" : "none";
  el("retryBtn").hidden = !showRetry;
}

function formatHour(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric" });
}

function formatDayName(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString([], { weekday: "short" });
}

function safeText(x, fallback = "—") {
  return (x === null || x === undefined || x === "") ? fallback : String(x);
}

function chooseDaily7(periods) {
  // The /forecast endpoint often returns 12-hour periods (day/night).
  // For a simple 7-day display: prefer daytime periods; otherwise take first 7.
  const daytime = periods.filter((p) => p.isDaytime === true);
  const src = daytime.length >= 7 ? daytime : periods;
  return src.slice(0, 7);
}

function renderCurrent(hourlyPeriods) {
  const cur = hourlyPeriods?.[0];
  if (!cur) return;

  el("currentTemp").textContent = `${safeText(cur.temperature, "--")}°${safeText(cur.temperatureUnit, "")}`;
  el("currentDesc").textContent = safeText(cur.shortForecast, "--");

  const wind = cur.windSpeed ? `Wind ${cur.windSpeed} ${safeText(cur.windDirection, "")}` : null;
  const pop = cur.probabilityOfPrecipitation?.value;
  const popTxt = (typeof pop === "number") ? `Precip ${pop}%` : null;

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
  const banner = el("alertBanner");
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

  // Banner “Details” toggle
  el("toggleAlertsBtn").onclick = () => {
    const open = !detailsWrap.hidden;
    detailsWrap.hidden = open;
    el("toggleAlertsBtn").textContent = open ? "Details" : "Hide";
    if (!open) detailsWrap.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  detailsWrap.hidden = true;
  el("toggleAlertsBtn").textContent = "Details";
}

async function fetchWeather(lat, lon) {
  setStatus("Loading", "Fetching NWS forecast…", { loading: true, showRetry: false });

  const url = `/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.error || "Weather data is unavailable.";
    throw new Error(msg);
  }

  return data;
}

async function start() {
  // Radar button: open the official NWS radar display in a new tab. :contentReference[oaicite:5]{index=5}
  el("radarBtn").onclick = () => window.open("https://radar.weather.gov/", "_blank", "noopener,noreferrer");

  el("retryBtn").onclick = () => {
    // Reset visible sections
    el("currentCard").hidden = true;
    el("hourlyCard").hidden = true;
    el("dailyCard").hidden = true;
    el("alertsSection").hidden = true;
    el("alertsDetails").hidden = true;
    el("alertsDetails").innerHTML = "";
    start();
  };

  if (!("geolocation" in navigator)) {
    setStatus("Location not supported", "Your browser does not support geolocation.", { loading: false, showRetry: false });
    return;
  }

  setStatus("Location", "Requesting permission…", { loading: true, showRetry: false });

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;

        state.lat = lat;
        state.lon = lon;

        const data = await fetchWeather(lat, lon);
        state.data = data;

        el("locationName").textContent = data?.location?.name || "Your area";

        renderAlerts(data.alerts || []);
        renderCurrent(data.hourlyPeriods || []);
        renderHourly(data.hourlyPeriods || []);
        renderDaily(data.dailyPeriods || []);

        setStatus("Updated", `Last updated: ${new Date(data.fetchedAt).toLocaleTimeString()}`, {
          loading: false,
          showRetry: false,
        });
      } catch (err) {
        setStatus("Could not load weather", safeText(err?.message, "Please try again."), {
          loading: false,
          showRetry: true,
        });
      }
    },
    (err) => {
      const reason =
        err?.code === 1
          ? "Location permission was denied. Please allow location access and try again."
          : "We couldn’t get your location. Please try again.";
      setStatus("Location needed", reason, { loading: false, showRetry: true });
    },
    {
      enableHighAccuracy: false,
      timeout: 12000,
      maximumAge: 5 * 60 * 1000,
    }
  );
}

start();
