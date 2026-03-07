# Code Review Findings (Significant Issues)

## 1) IP anonymization is weak when `TRACKING_SALT` is missing (privacy/security)

**Why this is significant:**
The code falls back to a hardcoded salt (`"weather-default-salt"`) when `TRACKING_SALT` is not configured. That means hashes are predictable and consistent across environments that miss this secret, weakening privacy guarantees and making correlation easier.

**Evidence:**
- `anonymizeIp()` uses `safeStr(env.TRACKING_SALT) || "weather-default-salt"`.

**Recommended fix:**
- Treat `TRACKING_SALT` as required at runtime.
- If missing, reject tracking writes with a clear 500/503 operational error (or skip storing IP hash entirely) rather than hashing with a public fallback.

---

## 2) NWS `validTime` parsing does not support day-based ISO-8601 durations (data correctness)

**Why this is significant:**
NWS grid series often use durations like `P1DT6H` (includes day components). `parseNwsValidTime()` only parses `PT...` (hours/minutes only). When parsing fails, `valueAt()` cannot correctly select time-bucketed values, degrading metrics derived from forecast grid data.

**Evidence:**
- `parseNwsValidTime()` accepts only regex `^PT(?:(\d+)H)?(?:(\d+)M)?`.
- `valueAt()` depends on `parseNwsValidTime()` for interval matching.

**Recommended fix:**
- Expand duration parsing to support full ISO-8601 day/hour/minute forms used by NWS (at least `P[n]DT[n]H[n]M` and pure-day durations).
- Add unit tests for representative NWS samples.

---

## 3) Public tracking endpoint has no worker-level abuse controls (cost/availability risk)

**Why this is significant:**
`POST /api/track` accepts client-supplied payloads and writes directly to D1. There is no request authentication, no proof-of-origin check, and no in-worker rate limiting. If external edge controls are changed/misconfigured, this route can be spammed, increasing DB costs and potentially degrading performance.

**Evidence:**
- Route handling exposes `/api/track` publicly.
- `handleTrackEvent()` inserts into `EVENTS_DB` for any request with a `userId`.

**Recommended fix:**
- Add in-worker basic abuse defenses (e.g., per-IP and per-user short-window quotas using Durable Objects/KV or soft-drop heuristics).
- Enforce payload size limits and stricter field validation.
- Consider optional signed event tokens for first-party clients if abuse increases.

---

## 4) NASA moon data source is hard-pinned to dataset `a005587` while year is dynamic (future reliability risk)

**Why this is significant:**
The code uses a fixed dataset ID that appears specific to a given annual moon product, but requests `mooninfo_<current year>.json`. This can break when the current year no longer exists in that dataset, causing silent fallback behavior and reduced moon metadata quality.

**Evidence:**
- `NASA_MOON_DATASET_ID = "a005587"`.
- URL built as `.../a005500/${NASA_MOON_DATASET_ID}/mooninfo_${year}.json` where `year` is current UTC year.

**Recommended fix:**
- Decouple moon source selection from a fixed dataset/year.
- Use a data source that is explicitly multi-year, or maintain a year→dataset mapping with validation and monitoring.
