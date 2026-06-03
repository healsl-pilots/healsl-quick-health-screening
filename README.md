# HEAL-SL Health Quick Checkup

A tiny, offline-first web app for household health screening. Health workers fill it
in on a shared phone, it **stores every checkup on the device**, and **syncs to a
Google Sheet** whenever there's internet. Installs from a QR code — no app store.

- Works on low-spec Android phones and in low/no connectivity.
- No backend server to run or pay for — just a Google Sheet.
- One file you host (free), one Apps Script you paste in. ~10 minutes.

---

## Files

| File | What it is |
|------|------------|
| `index.html` | The whole app (UI + offline storage + sync). |
| `service-worker.js` | Makes it load fully offline after first open. |
| `manifest.webmanifest` | Lets it install to the home screen. |
| `qrcode.min.js` | Offline QR generator for the in-app install/share screen. |
| `icon-192.png`, `icon-512.png` | App icons. |
| `Code.gs` | Google Apps Script that writes synced data into your Sheet. |

Keep all files together in one folder.

---

## Setup

### Part A — Create the Google Sheet backend (5 min)

1. Create a new Google Sheet (this is where data lands).
2. **Extensions → Apps Script**.
3. Delete the sample code, paste the contents of **`Code.gs`**, and **Save**.
4. **Deploy → New deployment**. Click the gear → **Web app**.
   - **Execute as:** Me
   - **Who has access:** **Anyone**
5. **Deploy**, authorise when asked, and **copy the Web app URL** — it ends in `/exec`.

That `/exec` link is your sync link.

### Part B — Publish the app on GitHub Pages (5 min)

1. Create a free GitHub account and a new **public** repository, e.g. `heal-sl`.
2. Upload all the files in this folder (drag-and-drop into the repo works).
3. **Settings → Pages →** Source: `Deploy from a branch`, Branch: `main`, Folder: `/ (root)`. Save.
4. After a minute your app is live at:
   `https://YOUR-USERNAME.github.io/heal-sl/`

### Part C — Make the install QR (1 min)

You have two easy options:

- **Zero-config link (recommended).** Build this URL and turn it into a QR with any
  free QR site (or the in-app **Install & share** screen):
  ```
  https://YOUR-USERNAME.github.io/heal-sl/?api=PASTE_YOUR_/exec_LINK_HERE
  ```
  Anyone who scans it opens the app **already connected to your Sheet** — no setup.

- **In-app QR.** Open the app once, go to **☰ → Install & share**, set the sync link in
  **Settings** first, then tap **Print poster**. The QR already includes the sync link,
  so one configured phone can seed every other phone — even offline on the same spot.

---

## How a health worker uses it

1. Scan the QR → the app opens → browser offers **"Add to Home screen" / "Install"**.
2. Tap **Start new checkup**, answer the 4 questions, add the respondent's reaction to
   each, review, **Save**.
3. Data is saved on the phone instantly. When there's internet it syncs automatically;
   the home screen shows how many are still **"To sync"**. They can also tap **Sync** or
   **Export CSV** for a manual backup.

Re-syncing is always safe — each checkup has a unique ID and is never written twice.

---

## Gauging reaction to each question

Some screening questions can make people uneasy. After each question the worker taps a
**3-point comfort scale** — 🙂 *At ease* / 😐 *Neutral* / 😟 *Uneasy* — recording how the
respondent reacted. It's one tap, optional, and language-light, so it never slows the visit.

This is a pragmatic, field-proven format (a single-item facial affect rating). Each tap is
saved per question (`reaction_q1…q4`) so you can later see **which questions cause the most
discomfort** and reword or re-sequence them. When the worker marks a question **😟 Uneasy**, an
optional text box appears to capture *why* — the concern in the respondent's own words, saved
to `unease_note_q1…q4`. It only shows for Uneasy, so it never adds friction otherwise.

**Want research-grade rigor?** Swap in the **Self-Assessment Manikin (SAM)** — a validated,
language-free pictorial scale measuring *valence* (pleasant↔unpleasant) and *arousal*
(calm↔excited). It's the gold standard for quick emotional-response measurement and works
well with low literacy; the trade-off is two taps per question instead of one. The app is
structured so this is a small change if you decide to upgrade.

---

## What lands in the Google Sheet

One row per checkup, columns in this order:

`submitted_at, record_id, app_version, device_label, screener_name, community,
household_id, q1_fever, q1_fever_count, q1_symptoms, q2_bleeding, q2_bleeding_count,
q3_travel, q3_travel_date, q4_sudden_death, q4_death_count, triage_flag,
reaction_q1, unease_note_q1, reaction_q2, unease_note_q2, reaction_q3, unease_note_q3,
reaction_q4, unease_note_q4, gps_lat, gps_lng, notes`

`triage_flag` is a transparent screening aid (**"Needs follow-up"** if there is unstoppable
bleeding, a sudden death, recent travel, or fever with at least one listed symptom — otherwise
**"Routine"**). It is **not a diagnosis**.

---

## Data safety & offline behaviour

- Every checkup is stored on the device the moment it's saved, before any sync.
- No internet? It queues and syncs later automatically — nothing is lost.
- **Export CSV** gives a full backup with zero connectivity.
- **Clear synced records** removes only data already confirmed in the Sheet.

---

## Customising the questions

Open `index.html`: the symptom list is the `SYMPTOMS` array and the questions are in
`renderStep()`. If you add or rename a field, add the matching column name to `HEADERS`
in `Code.gs` so it syncs. (No Ebola wording appears anywhere in the app — it reads as a
generic household health checkup.)
