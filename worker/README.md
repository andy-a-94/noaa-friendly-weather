# Event Tracking (Cloudflare-native)

This worker now supports anonymous user event tracking and CSV export.

## Configure bindings

> Important: this repository intentionally does **not** commit account-specific binding IDs.
> Configure bindings in your Cloudflare dashboard (or via CI secrets + generated config) per environment.

1. Create D1 DB and apply migration:
   - `wrangler d1 create noaa-friendly-weather-events`
   - `wrangler d1 execute noaa-friendly-weather-events --file=./migrations/0001_user_events.sql`
2. In Worker settings, add a D1 binding:
   - Binding variable: `EVENTS_DB`
   - Database: `noaa-friendly-weather-events`
3. Add environment variables:
   - `TRACKING_SALT` = long random secret
   - `EXPORT_API_TOKEN` = long random API token
4. (Optional) Create Analytics Engine dataset for high-volume aggregation.
   - If Cloudflare asks for **dataset name**, use: `weather_user_events`
   - If Cloudflare asks for **dataset binding**, use: `EVENTS_ANALYTICS`

### What to enter in the Cloudflare UI

When enabling Analytics Engine in the dashboard:

- **Dataset name**: `weather_user_events`
- **Binding variable**: `EVENTS_ANALYTICS`

If you only want D1 storage + CSV exports and do not want Analytics Engine yet, you can skip this binding entirely.

## Why deploy was failing

Cloudflare rejected deploys because the committed config had a placeholder D1 ID (`replace-with-your-d1-database-id`).
That value is not a valid D1 database id, so deploy fails with:
`binding EVENTS_DB of type d1 must have a valid id specified`.

## API endpoints

### `POST /api/track`
Receives anonymous events from frontend.

### `GET /api/track/export?from=<ISO>&to=<ISO>&limit=5000`
Returns CSV (Excel-friendly). Requires:
- `Authorization: Bearer <EXPORT_API_TOKEN>`

Use CSV as the default export format for compatibility with Excel and BI tools.
