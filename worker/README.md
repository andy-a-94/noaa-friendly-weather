# Event Tracking (Cloudflare-native)

This worker now supports anonymous user event tracking and CSV export.

## Configure bindings

1. Create D1 DB and apply migration:
   - `wrangler d1 create noaa-friendly-weather-events`
   - `wrangler d1 execute noaa-friendly-weather-events --file=./migrations/0001_user_events.sql`
2. Update `wrangler.jsonc` placeholders:
   - `d1_databases[].database_id`
   - `vars.TRACKING_SALT`
   - `vars.EXPORT_API_TOKEN`
3. (Optional) Create Analytics Engine dataset for high-volume aggregation.

## API endpoints

### `POST /api/track`
Receives anonymous events from frontend.

### `GET /api/track/export?from=<ISO>&to=<ISO>&limit=5000`
Returns CSV (Excel-friendly). Requires:
- `Authorization: Bearer <EXPORT_API_TOKEN>`

Use CSV as the default export format for compatibility with Excel and BI tools.
