# HEAL-SL Health Quick Checkup

A tiny, offline-first web app for household health screening with **three roles**
(field-worker, supervisor, admin). It installs from a QR, works on low-spec phones in
low/no connectivity, and **syncs to a Google Sheet** — no backend server to run.

Live (pilot): `https://healsl-pilots.github.io/healsl-quick-health-screening/`

---

## Roles

| Role | Can do |
|------|--------|
| **Field-worker** | Log in, capture checkups, sync their own data. Sees only their own records. |
| **Supervisor** | Read-only team progress: who captured how many, today/total, follow-up counts. No PII. |
| **Admin** | Everything: create/disable users, link the Sheet, per-question analysis, pause access, clean devices at end of day. Can also capture. |

## How data is protected from overwrites

The `Responses` sheet is an **append-only, immutable log**. Every checkup is one row with
a globally-unique `record_id`, and the server **only ever appends new IDs — it never edits
or deletes a row**. Ownership (`username`) is stamped from the login token, not the device,
so it can't be spoofed. Result: two workers (or repeat syncs) can **never overwrite each
other** — conflicts are impossible by design, not patched up afterwards.

## Security model (honest version)

Login is **username + 4-digit PIN**. PINs are stored only as salted SHA-256 hashes. A login
returns a **day-keyed HMAC token that expires at the end of the day**, so access auto-ends
each day — even on phones that are offline. This is solid *operational* security for field
health data on shared devices; it is not bank-grade cryptography. Treat PINs as daily access
codes, sent over HTTPS.

---

## Setup (≈10 min, once)

### A. Backend (Google Sheet + Apps Script)

1. Create a Google Sheet. **File → Settings →** set the time zone to your country
   (e.g. *Africa/Freetown*) so "end of day" matches local midnight.
2. **Extensions → Apps Script**, delete the sample, paste **`Code.gs`**, **Save**.
3. At the top of `Code.gs`, edit `BOOTSTRAP_ADMIN` (admin username + a PIN you choose).
4. Run the **`setup`** function once (**Run ▸ setup**) and authorise. This creates the
   `Responses`, `Users`, `Control`, `Audit` tabs and your first admin account.
5. **Deploy → New deployment → Web app**: *Execute as* = **Me**, *Who has access* = **Anyone**.
   Copy the **/exec URL** — that's the app's data link.

### B. App (GitHub Pages)

Already published for the pilot at the URL above (org `healsl-pilots`). To host your own:
put the files in a public repo, then **Settings → Pages →** deploy from `main` / root.
`*.github.io` gives HTTPS automatically — required for offline/install to work.

### C. Connect + first login

- Open the app; paste the **/exec link** on the connect screen (or bake it into the install
  QR as `…/?api=PASTE_/exec_LINK`). Field phones that scan the QR are connected automatically.
- Log in as the admin you created, then **Users** → add your supervisors and field workers
  (each gets a username + PIN). That's the only thing field workers need.

---

## Daily use

- **Morning (needs a moment of signal):** each worker logs in once. The app then works
  **offline all day** and syncs whenever signal returns.
- **Field-worker:** *Start new checkup* → 4 questions, tap each respondent's reaction,
  review, **Save**. Data is stored on the phone instantly; *Sync* pushes it up. Re-syncing
  never duplicates a row.
- **Supervisor:** opens straight to **Team progress**.
- **Admin → Analysis:** per-question Yes-rates, symptom frequency, reaction/unease
  distribution, follow-up rate. *Build Sheet tab* also writes a **Dashboard** tab with a chart.
- **Admin → Day controls (end of day):** *Pause access* (blocks new capture) and *Clean all
  devices* (each phone uploads anything pending, then erases its local copy — **unsynced data
  is never deleted**).

---

## Gauging reaction to each question

After each question the worker taps a **3-point comfort scale** — 🙂 *At ease* / 😐 *Neutral*
/ 😟 *Uneasy* — saved per question (`reaction_q1…q4`). When **Uneasy** is chosen, an optional
box captures *why*, in the respondent's words (`unease_note_q1…q4`). It only shows for Uneasy,
so it never adds friction. The Analysis view shows which questions unsettle people most.
(Research-grade upgrade if ever needed: the Self-Assessment Manikin, valence + arousal.)

---

## What lands in the `Responses` sheet (one row per checkup)

`synced_at, submitted_at, record_id, username, device_id, app_version, community,
household_id, q1_fever, q1_fever_count, q1_symptoms, q2_bleeding, q2_bleeding_count,
q3_travel, q3_travel_country, q3_travel_date, q4_sudden_death, q4_death_count, triage_flag,
reaction_q1, unease_note_q1, reaction_q2, unease_note_q2, reaction_q3, unease_note_q3,
reaction_q4, unease_note_q4, gps_lat, gps_lng, notes`

`triage_flag` = **"Needs follow-up"** if there's unstoppable bleeding, a sudden death, recent
travel, or fever with ≥1 listed symptom — otherwise **"Routine"**. A screening aid, **not a
diagnosis**.

---

## Files

`index.html` (app) · `service-worker.js` (offline) · `manifest.webmanifest` (install) ·
`qrcode.min.js` (offline QR) · `icon-192.png` / `icon-512.png` · `Code.gs` (backend).

**After any change, bump the cache version** in `service-worker.js` (`heal-sl-v3` → `v4`) so
installed phones pick up the update on next open. No Ebola wording appears anywhere in the
app — it reads as a generic household health checkup.
