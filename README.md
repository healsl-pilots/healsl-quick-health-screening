# HEAL-SL Health Quick Checkup

Offline-first web app for household health screening, with **three roles**. Installs from a
QR, works on low-spec phones in poor connectivity, and **syncs to one Google Sheet**.

Live (pilot): `https://healsl-pilots.github.io/healsl-quick-health-screening/`

## Roles

| Role | Can do |
|------|--------|
| **Field-worker** | Log in, capture checkups, sync their own data. |
| **Supervisor** | Read-only team progress (who captured how many, today/total). |
| **Admin** | Create/disable users, manage the **area list**, see per-question analysis, pause access, clean devices at end of day. Sets up the Sheet **once for everyone**. |

## Key design choices

- **One setup, used by everyone.** Only the admin connects the Sheet. Every other phone
  gets the data link automatically from the install QR (or a baked-in `CONFIG.ENDPOINT`), so
  **workers only ever log in** — they never see a setup screen.
- **No overwrites, no data loss.** The `Responses` sheet is an **append-only immutable log**:
  the server only ADDS new unique IDs and never edits/deletes a row; ownership is stamped from
  the login token. On top of that the app **autosaves the in-progress checkup**, **auto-syncs
  every minute** and on reconnect, and only erases local data **after** confirming it's synced.
- **Auto IDs.** Each checkup's ID is generated automatically as **`<user code><3-digit sequence>`**
  (e.g. user `121` → `121001, 121002, …`). Surveyors never type it.
- **Areas are a dropdown.** Admin enters the area list once; surveyors pick from it.
- **PIN login, daily expiry.** Username + 4-digit PIN (stored hashed); tokens expire at end of
  day, even offline.

## Setup (admin, once)

1. New Google Sheet → **File ▸ Settings** → set your time zone (e.g. *Africa/Freetown*).
2. **Extensions ▸ Apps Script** → paste **`Code.gs`** → edit `BOOTSTRAP_ADMIN` (admin username,
   numeric **code**, and PIN) → **Run ▸ setup** and authorise (only this spreadsheet).
   *On Advanced Protection accounts, the `/** @OnlyCurrentDoc */` line at the top keeps the scope
   narrow enough to allow it; if it still blocks, use a Google account not in Advanced Protection.*
3. **Deploy ▸ New deployment ▸ Web app** → Execute as **Me**, Access **Anyone** → copy **/exec**.
4. Open the app → paste **/exec** on the admin Connect screen (or put it in `CONFIG.ENDPOINT` and
   redeploy so every install is pre-connected). Then **Users** (add staff + give each a code) and
   **Areas** (enter the list). Share the **Install & share** QR — workers scan, then just log in.

## Daily use

- **Morning (brief signal):** each worker logs in once; the app then works offline all day.
- **Field-worker:** *New checkup* → ID auto-fills, pick area, answer 4 questions, tap each
  reaction, **Save**, **Sync**.
- **Supervisor:** opens to **Team progress**.
- **Admin → Analysis:** per-question Yes-rates, symptom frequency, reaction/unease distribution
  (in-app charts + **Sheet tab** button). **Day controls:** *Pause* and *Clean all devices*.

## Gauging reaction

After each question the worker taps 🙂 *At ease* / 😐 *Neutral* / 😟 *Uneasy* (`reaction_q1…q4`).
Choosing **Uneasy** reveals an optional note for *why* (`unease_note_q1…q4`).

## `Responses` columns (one row per checkup)

`synced_at, submitted_at, record_id, username, device_id, app_version, area, household_id,
q1_fever, q1_fever_count, q1_symptoms, q2_bleeding, q2_bleeding_count, q3_travel,
q3_travel_count, q3_travel_country, q3_travel_date, q4_sudden_death, q4_death_count,
reaction_q1, unease_note_q1, reaction_q2, unease_note_q2, reaction_q3, unease_note_q3,
reaction_q4, unease_note_q4, gps_lat, gps_lng, notes`

## AI Final Feedback summary (optional)

Admin can group the open-ended Final Feedback into clear categories (e.g. "No feedback",
"Wants more medicine", "Malaria concerns") with counts, in the app (Analysis, "Summarize
feedback") and on the Sheet Dashboard. This calls Google's Gemini from the Apps Script:

1. Get a free key from Google AI Studio (aistudio.google.com).
2. Apps Script: Project Settings, Script properties, add `GEMINI_API_KEY` = your key
   (optionally `GEMINI_MODEL`, default `gemini-2.0-flash`). The key stays in the script,
   never in this repo.
3. Re-deploy the web app. This adds a "connect to an external service" permission, so you
   re-authorize once. If Advanced Protection blocks it, host the script on a Google account
   not in Advanced Protection. Without a key, the app just lists the feedback instead.

## Files

`index.html` · `service-worker.js` · `manifest.webmanifest` · `qrcode.min.js` ·
`icon-192.png` / `icon-512.png` · `Code.gs`.

**After any change, bump the cache version** in `service-worker.js` (`heal-sl-v4` → `v5`) so
installed phones update on next open. No Ebola wording appears anywhere — it reads as a generic
household health checkup.
