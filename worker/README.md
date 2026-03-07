# NOAA Friendly Weather Worker Operations Guide

This guide explains how this Worker is set up in Cloudflare, how to run/verify D1 migrations, and how to export tracking data.

It is written for **beginner operators** and should be the source of truth for day-to-day operations.

---

## 1) Architecture at a glance

- **Worker name**: `noaa-friendly-weather` (from `wrangler.jsonc`).
- **Runtime file**: `worker/src/index.js`.
- **Config file**: `worker/wrangler.jsonc`.
- **Data store**: Cloudflare **D1** database, bound to Worker as `EVENTS_DB`.
- **Primary event endpoints**:
  - `POST /api/track` (writes tracking events)
  - `GET /api/track/export` (exports CSV)
- **Health endpoint**:
  - `GET /api/health`

---

## 2) Where settings live in Cloudflare

### A) Worker Settings → **Domains & Routes**
Use this for where requests are sent to the Worker.

Recommended production routes:
- `almanacweather.com/api/*`
- `www.almanacweather.com/api/*`

### B) Worker Settings → **Bindings**
Use this for runtime resources (databases/services).

Required:
- **D1 binding variable**: `EVENTS_DB`
- **D1 database**: your real DB (example from setup: `d_weather-events`)

Optional:
- **Analytics Engine binding**: `EVENTS_ANALYTICS`

### C) Worker Settings → **Variables and Secrets** (runtime)
Use this for values read by the Worker while serving requests.

Required runtime values:
- `TRACKING_SALT` (long random secret)
- `EXPORT_API_TOKEN` (long random secret)

> Important: Runtime variables/secrets are what the Worker code uses at request time.  
> Build variables are not a substitute for runtime secrets for these values.

### D) Worker → **Build / Git integration**
Use this for CI/CD only.

- Keep deploy wiring to GitHub here.
- Keep API/build token(s) needed for deployment here.
- Do **not** rely on build vars for runtime auth/database behavior.

---

## 3) D1 migration setup

### If database already exists (common)
If your database is already created (for example `d_weather-events`), run only the migration SQL:

```bash
npx wrangler d1 execute d_weather-events --remote --file=./migrations/0001_user_events.sql
```

### If database does not exist yet
Create DB first, then migrate:

```bash
npx wrangler d1 create d_weather-events
npx wrangler d1 execute d_weather-events --remote --file=./migrations/0001_user_events.sql
```

Why `--remote`? This repo intentionally avoids committing account-specific D1 IDs in config, so running remote is the safest default.

---

## 4) CSV export (download) flow

The Worker is already set up to return CSV from:

```text
GET /api/track/export?from=<ISO>&to=<ISO>&limit=5000
Authorization: Bearer <EXPORT_API_TOKEN>
```

### Windows PowerShell: verify Worker is live

```powershell
curl.exe -i https://almanacweather.com/api/health
```

### Windows PowerShell: export and save CSV

```powershell
$token = Read-Host "Paste EXPORT_API_TOKEN" -AsSecureString
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($token)
$plainToken = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

curl.exe "https://almanacweather.com/api/track/export?limit=5000" -H "Authorization: Bearer $plainToken" -o "$HOME\Downloads\weather-user-events.csv"
```

### Where the downloaded file is
- If you use `-o "$HOME\Downloads\weather-user-events.csv"`, it lands in your **Downloads** folder.
- If you use `-o weather-user-events.csv`, it lands in your **current terminal folder**.

### Helpful checks

```powershell
Get-Item "$HOME\Downloads\weather-user-events.csv"
Get-Content "$HOME\Downloads\weather-user-events.csv" -TotalCount 5
```

---

## 5) Troubleshooting quick reference

- `401 Unauthorized` on export:
  - `EXPORT_API_TOKEN` missing/wrong in runtime secrets, or wrong token used in curl.

- `500 EVENTS_DB binding missing`:
  - D1 binding `EVENTS_DB` is not configured in Worker Bindings.

- Migration command can’t find DB:
  - Use `--remote`, and ensure DB name is correct in Cloudflare D1.

---

## 6) Working style for a beginner operator (Codex response contract)

Use this operating contract for future prompts to keep responses aligned with your goals.

### You (operator) profile
You are new to:
- web design
- coding
- app creation
- Cloudflare
- GitHub
- Power Query

### How Codex should respond
Codex should:
1. Give **step-by-step instructions** in plain language.
2. Prefer **copy/paste commands** and specify exactly **where** to run them.
3. Explain expected output and what to do if output differs.
4. Avoid unnecessary jargon; define terms when needed.
5. Default to secure practices (secrets as secrets, least privilege, no hardcoded credentials).
6. Recommend scalable/commercial-ready patterns:
   - clear separation of runtime config vs build config
   - route and API version planning
   - monitoring/logging enabled during rollout
   - environment separation (dev/staging/prod)
   - documented runbooks for repeatability

### Long-term best-practice checklist (commercial growth)
- [ ] Keep runtime secrets only in runtime secret store
- [ ] Enable logs/traces during launches and incident triage
- [ ] Add staging environment before major releases
- [ ] Add rate limiting / abuse protection for public APIs
- [ ] Add backup/export procedures for D1 data
- [ ] Add onboarding docs for future team members

---

## 7) Repo-specific note

This repo intentionally does **not** commit account-specific binding IDs. Configure Cloudflare resource bindings in dashboard/secure deployment process per environment.
