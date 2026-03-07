# NOAA Friendly Weather — Live Repository Log

Purpose
- This file is the living, human-readable map of where things live in this repo.
- It documents names, structure, settings, and operational wiring currently visible in code/docs.
- Keep this file updated as the source of truth whenever the repo structure or behavior changes.

How to use this file
- Read this file first when onboarding or planning changes.
- Use this file to quickly locate frontend, worker, database schema, and Cloudflare setup details.
- Use this file during reviews to verify architecture assumptions.

PR update requirement (important)
- If a PR changes any of the following, you must update this file in the same PR:
  - File/folder structure.
  - Route names or endpoint behavior.
  - Environment variables, bindings, or deployment settings.
  - Data schemas (D1 tables/columns/indexes).
  - External providers or data source wiring.
  - Frontend bootstrap/runtime behavior tied to environment.
- Include a short "Live Log Update" note in the PR description describing what changed in this file.
- Do not merge architecture-affecting changes without updating this file.

Repository structure
- `public/`
  - Frontend static app assets and runtime script.
  - Key files:
    - `public/index.html`: app shell and card containers.
    - `public/styles.css`: visual styling.
    - `public/app.js`: frontend runtime logic.
    - `public/assets/shoes/*`: shoe icon assets used by Shoe Index tile.
    - `public/brand/*`: logo/branding assets.
- `worker/`
  - Cloudflare Worker backend, config, migration, and operations notes.
  - Key files:
    - `worker/src/index.js`: Worker routes and backend logic.
    - `worker/wrangler.jsonc`: Worker config.
    - `worker/migrations/0001_user_events.sql`: D1 schema migration for tracking events.
    - `worker/README.md`: Cloudflare operational runbook.

Frontend structure and behavior
- Main UI containers (defined in `public/index.html`):
  - Current, Severe Weather, Outlook, Wind, Shoe Index, Sun/Moon + UV, Hourly, Hourly Graphs, Forecast, Earth.
- API base resolution (`public/app.js`):
  - Uses `<meta name="worker-base-url">` if provided.
  - Otherwise uses same-origin `/api/*`.
  - In preview-like hosts (`pages.dev`, `localhost`, `127.0.0.1`, `codex`, `github`), includes fallback candidate `https://www.almanacweather.com`.
- Search/location flow:
  - Input accepts ZIP or `City, ST`.
  - Suggestion endpoint is used while typing.
  - Location endpoint resolves to coordinates.
  - Weather endpoint is called with coordinates.
- Frontend local/session persistence:
  - Local storage keys: `aw_search`, `aw_lat`, `aw_lon`, `aw_label`, `aw_uid`.
  - Session storage key: `aw_session_id`.
- Preview convenience behavior:
  - On preview-like hosts, if no stored search exists, app auto-runs ZIP `10001` (or URL `?zip=` override).

Worker/API structure and behavior
- Worker name and entry (from `worker/wrangler.jsonc`):
  - Name: `noaa-friendly-weather`.
  - Entry: `src/index.js`.
- Exposed routes (from `worker/src/index.js`):
  - `POST /api/track`
  - `GET /api/track/export`
  - `GET /api/health`
  - `GET /api/location/suggest`
  - `GET /api/location`
  - `GET /api/weather`
- Health endpoint payload includes `source: "github"`.

Data sources and provider wiring
- NOAA/NWS (`api.weather.gov`): forecasts, hourly, grid, alerts.
- USNO Astronomical Applications: sun/moon times and phase-related data.
- Open-Meteo Forecast: UV and forecast extension.
- Open-Meteo Archive: soil moisture used for shoe recommendation logic.
- NASA SVS moon imagery references are present for moon visualization context.

Cloudflare settings and operational wiring
- Operational guidance is documented in `worker/README.md`.
- Recommended production route patterns:
  - `almanacweather.com/api/*`
  - `www.almanacweather.com/api/*`
- Required runtime binding:
  - D1 binding variable: `EVENTS_DB`.
- Optional runtime binding:
  - Analytics Engine binding: `EVENTS_ANALYTICS`.
- Required runtime secrets/variables:
  - `TRACKING_SALT`
  - `EXPORT_API_TOKEN`
- Important practice:
  - Runtime secrets should be configured in Worker runtime settings (not build vars).
- Note:
  - Repo intentionally avoids committing account-specific binding IDs.

Database schema (D1)
- Migration file: `worker/migrations/0001_user_events.sql`.
- Table: `user_events`.
- Current columns:
  - `id`
  - `event_time`
  - `user_id`
  - `session_id`
  - `event_type`
  - `action`
  - `target`
  - `page`
  - `search_query`
  - `location_label`
  - `location_lat`
  - `location_lon`
  - `user_lat`
  - `user_lon`
  - `device_type`
  - `user_agent`
  - `ip_hash`
  - `metadata_json`
- Indexes:
  - `idx_user_events_event_time`
  - `idx_user_events_user_id`
  - `idx_user_events_event_type`

Tracking/export behavior
- Event ingest:
  - Frontend posts anonymous interaction events to `/api/track`.
  - Worker normalizes payload fields and writes to D1 if `EVENTS_DB` is bound.
- CSV export:
  - `GET /api/track/export` requires `Authorization: Bearer <EXPORT_API_TOKEN>`.
  - Worker reads rows from `user_events` and returns CSV.

GitHub/deploy notes visible in repo
- Worker health response contains `source: "github"`.
- `worker/README.md` references Cloudflare Build/Git integration as the deploy wiring location.
- No GitHub workflow files are currently present in the tracked file list at this time.

Maintenance checklist for contributors
- When adding/changing endpoints:
  - Update route list in this file.
  - Update provider wiring notes if source behavior changed.
- When changing frontend app structure:
  - Update section names and file paths in this file.
- When changing Cloudflare settings:
  - Update bindings, vars/secrets, and route patterns in this file.
- When changing schema:
  - Add migration details and update table/index descriptions in this file.
- Before merge:
  - Confirm this file still accurately reflects current repo state.
