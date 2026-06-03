/**
 * HEAL-SL Health Quick Checkup — Google Sheets sync backend (Apps Script)
 *
 * Setup (see README):
 *   1. Create a Google Sheet.
 *   2. Extensions → Apps Script. Paste this file. Save.
 *   3. Deploy → New deployment → Web app.
 *        Execute as: Me   |   Who has access: Anyone
 *   4. Copy the /exec URL → paste into the app's Settings (or the install link).
 *
 * Writes are idempotent: a record_id is never stored twice, so re-syncing
 * the same record (e.g. after patchy network) never creates duplicates.
 */

var SHEET_NAME = "Responses";

var HEADERS = [
  "submitted_at", "record_id", "app_version", "device_label", "screener_name",
  "community", "household_id", "q1_fever", "q1_fever_count", "q1_symptoms",
  "q2_bleeding", "q2_bleeding_count", "q3_travel", "q3_travel_date",
  "q4_sudden_death", "q4_death_count", "triage_flag",
  "reaction_q1", "unease_note_q1", "reaction_q2", "unease_note_q2",
  "reaction_q3", "unease_note_q3", "reaction_q4", "unease_note_q4",
  "gps_lat", "gps_lng", "notes"
];

/* ---------- POST: receive and append records ---------- */
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var body = JSON.parse(e.postData.contents);
    var records = body.records || [];
    var sheet = getSheet_();
    var ids = getIdSet_(sheet);
    var rows = [], written = 0;

    records.forEach(function (r) {
      if (r && r.record_id && !ids.has(r.record_id)) {
        rows.push(toRow_(r));
        ids.add(r.record_id);
        written++;
      }
    });
    if (rows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
    }
    return json_({ ok: true, written: written });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- GET: health check + sync verification (JSONP) ---------- */
function doGet(e) {
  var p = e.parameter || {};
  var action = p.action || "ping";
  var out;

  if (action === "check") {
    var sheet = getSheet_();
    var set = getIdSet_(sheet);
    var asked = (p.ids || "").split(",").filter(String);
    out = { ok: true, present: asked.filter(function (id) { return set.has(id); }) };
  } else { // ping
    var s = getSheet_();
    out = { ok: true, count: Math.max(0, s.getLastRow() - 1) };
  }
  return p.callback ? jsonp_(p.callback, out) : json_(out);
}

/* ---------- Helpers ---------- */
function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

function getIdSet_(sheet) {
  var set = new Set();
  var last = sheet.getLastRow();
  if (last < 2) return set;
  var col = HEADERS.indexOf("record_id") + 1;
  var vals = sheet.getRange(2, col, last - 1, 1).getValues();
  vals.forEach(function (v) { if (v[0]) set.add(String(v[0])); });
  return set;
}

function toRow_(r) {
  return HEADERS.map(function (h) {
    var v = r[h];
    if (Array.isArray(v)) return v.join("; ");
    return (v === undefined || v === null) ? "" : v;
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonp_(cb, obj) {
  return ContentService.createTextOutput(cb + "(" + JSON.stringify(obj) + ")")
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}
