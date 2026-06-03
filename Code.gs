/**
 * HEAL-SL Health Quick Checkup — role-based backend (Google Apps Script)
 * ---------------------------------------------------------------------------
 * One Google Sheet is the whole backend. Three roles: field-worker, supervisor, admin.
 *
 * SECURITY MODEL (pragmatic, for field health data on shared devices):
 *  - Login = username + PIN. PINs are stored only as salted SHA-256 hashes.
 *  - A successful login returns a day-keyed HMAC token (valid until local midnight),
 *    so access naturally expires every day — even on devices that go fully offline.
 *  - The Responses sheet is an APPEND-ONLY, immutable log. The server only ever adds
 *    new record_ids and NEVER edits/deletes a row, so workers can't overwrite each
 *    other (or themselves). Ownership is stamped from the token, not the client.
 *  - Admin can hard-lock access and bump a data epoch to wipe devices (the app only
 *    wipes local data AFTER confirming it is synced).
 *
 * FIRST-TIME SETUP (do once):
 *  1. Create a Google Sheet → Extensions → Apps Script → paste this file → Save.
 *  2. Edit BOOTSTRAP_ADMIN below (username + PIN), then run setup() once
 *     (Run ▸ setup) and authorise. This creates the first admin account.
 *  3. Deploy ▸ New deployment ▸ Web app: Execute as = Me, Access = Anyone.
 *     Copy the /exec URL — that's the app's API link (admin pastes it once).
 */

// ---- One-time admin bootstrap (change before running setup) ----
var BOOTSTRAP_ADMIN = { username: "admin", display_name: "Administrator", pin: "4729" };

var RESP_SHEET = "Responses";
var USER_SHEET = "Users";
var CTRL_SHEET = "Control";
var AUDIT_SHEET = "Audit";

var RESP_HEADERS = [
  "synced_at", "submitted_at", "record_id", "username", "device_id", "app_version",
  "community", "household_id",
  "q1_fever", "q1_fever_count", "q1_symptoms",
  "q2_bleeding", "q2_bleeding_count",
  "q3_travel", "q3_travel_country", "q3_travel_date",
  "q4_sudden_death", "q4_death_count", "triage_flag",
  "reaction_q1", "unease_note_q1", "reaction_q2", "unease_note_q2",
  "reaction_q3", "unease_note_q3", "reaction_q4", "unease_note_q4",
  "gps_lat", "gps_lng", "notes"
];
var USER_HEADERS = ["username", "display_name", "role", "salt", "pin_hash", "active", "created_at", "created_by"];
var ROLES = ["field-worker", "supervisor", "admin"];

/* ============================== ROUTING ============================== */
function doPost(e) {
  return handle_(e, (e.parameter && e.parameter.action) || safeParse_(e.postData && e.postData.contents).action);
}
function doGet(e) {
  return handle_(e, (e.parameter && e.parameter.action) || "ping");
}

function handle_(e, action) {
  var p = e.parameter || {};
  var body = (e.postData && e.postData.contents) ? safeParse_(e.postData.contents) : {};
  var cb = p.callback || body.callback;
  var out;
  try {
    switch (action) {
      case "ping":            out = { ok: true, service: "heal-sl", count: respCount_() }; break;
      case "login":           out = login_(body.username || p.username, body.pin || p.pin); break;
      case "status":          out = status_(tok_(p, body)); break;
      case "submit":          out = submit_(tok_(p, body), body.records || []); break;
      case "check":           out = check_(tok_(p, body), (p.ids || body.ids || "").split(",").filter(String)); break;
      case "progress":        out = progress_(tok_(p, body)); break;
      case "analytics":       out = analytics_(tok_(p, body)); break;
      case "listUsers":       out = listUsers_(tok_(p, body)); break;
      case "createUser":      out = createUser_(tok_(p, body), body); break;
      case "setUserActive":   out = setUserActive_(tok_(p, body), body.username, body.active); break;
      case "setLock":         out = setLock_(tok_(p, body), body.locked, body.message); break;
      case "clearDevices":    out = clearDevices_(tok_(p, body)); break;
      case "buildDashboard":  out = buildDashboard_(tok_(p, body)); break;
      default:                out = { ok: false, error: "unknown_action" };
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return cb ? jsonp_(cb, out) : json_(out);
}
function tok_(p, body) { return p.token || body.token || ""; }

/* ============================== AUTH ============================== */
function login_(username, pin) {
  username = String(username || "").toLowerCase().trim();
  if (!username || !pin) return { ok: false, error: "missing_credentials" };
  var u = findUser_(username);
  if (!u || String(u.active).toUpperCase() !== "TRUE") { audit_(username, "login_fail", "no/inactive user"); return { ok: false, error: "invalid_login" }; }
  if (hashPin_(pin, u.salt) !== u.pin_hash) { audit_(username, "login_fail", "bad pin"); return { ok: false, error: "invalid_login" }; }
  var ctrl = getControl_();
  audit_(username, "login_ok", u.role);
  return {
    ok: true, role: u.role, username: u.username, display_name: u.display_name,
    token: makeToken_(u.username, u.role), day_key: dayKey_(),
    locked: ctrl.locked, lock_message: ctrl.lock_message, data_epoch: ctrl.data_epoch
  };
}

function status_(token) {
  var t = requireRole_(token, ROLES, true); // allow even when locked, so the app can SEE it's locked
  var ctrl = getControl_();
  return { ok: true, role: t.role, username: t.username, day_key: dayKey_(),
           locked: ctrl.locked, lock_message: ctrl.lock_message, data_epoch: ctrl.data_epoch };
}

/* ============================== SUBMIT (append-only) ============================== */
function submit_(token, records) {
  var t = requireRole_(token, ["field-worker", "admin"]);
  if (getControl_().locked) return { ok: false, locked: true, error: "locked" };
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var sh = sheet_(RESP_SHEET, RESP_HEADERS);
    var ids = idSet_(sh, "record_id");
    var now = new Date().toISOString();
    var rows = [], written = 0;
    (records || []).forEach(function (r) {
      if (!r || !r.record_id || ids.has(r.record_id)) return;
      r.username = t.username;            // authoritative owner from token (anti-spoof)
      r.synced_at = now;
      rows.push(RESP_HEADERS.map(function (h) {
        var v = r[h];
        if (Array.isArray(v)) return v.join("; ");
        return (v === undefined || v === null) ? "" : v;
      }));
      ids.add(r.record_id); written++;
    });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, RESP_HEADERS.length).setValues(rows);
    return { ok: true, written: written };
  } finally { lock.releaseLock(); }
}

function check_(token, ids) {
  requireRole_(token, ["field-worker", "admin"], true);
  var sh = sheet_(RESP_SHEET, RESP_HEADERS);
  var set = idSet_(sh, "record_id");
  return { ok: true, present: ids.filter(function (id) { return set.has(id); }) };
}

/* ============================== SUPERVISOR / ADMIN READS ============================== */
function progress_(token) {
  requireRole_(token, ["supervisor", "admin"]);
  var rows = respRows_();
  var byUser = {};
  var today = dayKey_();
  rows.forEach(function (r) {
    var u = r.username || "(unknown)";
    var g = byUser[u] || (byUser[u] = { username: u, total: 0, today: 0, followups: 0, last: "" });
    g.total++;
    if (String(r.submitted_at).slice(0, 10) === today) g.today++;
    if (r.triage_flag === "Needs follow-up") g.followups++;
    if (r.synced_at > g.last) g.last = r.synced_at;
  });
  // include known users even with 0 captures
  users_().forEach(function (u) {
    if (u.role === "field-worker" && !byUser[u.username])
      byUser[u.username] = { username: u.username, total: 0, today: 0, followups: 0, last: "" };
  });
  var names = nameMap_();
  var list = Object.keys(byUser).map(function (k) { byUser[k].display_name = names[k] || k; return byUser[k]; });
  list.sort(function (a, b) { return b.today - a.today || b.total - a.total; });
  return { ok: true, day_key: today, total: rows.length, workers: list };
}

function analytics_(token) {
  requireRole_(token, ["admin"]);
  var rows = respRows_();
  var yn = function (key) { var y = 0, n = 0; rows.forEach(function (r) { if (r[key] === "Yes") y++; else if (r[key] === "No") n++; }); return { yes: y, no: n }; };
  var symptoms = {};
  var reactions = { reaction_q1: {}, reaction_q2: {}, reaction_q3: {}, reaction_q4: {} };
  var unease = 0, follow = 0;
  rows.forEach(function (r) {
    String(r.q1_symptoms || "").split(";").map(function (s) { return s.trim(); }).filter(String).forEach(function (s) { symptoms[s] = (symptoms[s] || 0) + 1; });
    ["reaction_q1", "reaction_q2", "reaction_q3", "reaction_q4"].forEach(function (k) { if (r[k]) reactions[k][r[k]] = (reactions[k][r[k]] || 0) + 1; });
    ["unease_note_q1", "unease_note_q2", "unease_note_q3", "unease_note_q4"].forEach(function (k) { if (r[k]) unease++; });
    if (r.triage_flag === "Needs follow-up") follow++;
  });
  return {
    ok: true, total: rows.length,
    questions: { fever: yn("q1_fever"), bleeding: yn("q2_bleeding"), travel: yn("q3_travel"), sudden_death: yn("q4_sudden_death") },
    symptoms: symptoms, reactions: reactions, unease_notes: unease,
    followups: follow, routine: rows.length - follow
  };
}

/* ============================== ADMIN: USERS ============================== */
function listUsers_(token) {
  requireRole_(token, ["admin"]);
  return { ok: true, users: users_().map(function (u) {
    return { username: u.username, display_name: u.display_name, role: u.role, active: String(u.active).toUpperCase() === "TRUE" };
  }) };
}

function createUser_(token, b) {
  var t = requireRole_(token, ["admin"]);
  var username = String(b.username || "").toLowerCase().trim();
  if (!/^[a-z0-9._-]{3,20}$/.test(username)) return { ok: false, error: "bad_username" };
  if (ROLES.indexOf(b.role) < 0) return { ok: false, error: "bad_role" };
  if (!/^\d{4,8}$/.test(String(b.pin || ""))) return { ok: false, error: "bad_pin" };
  var sh = sheet_(USER_SHEET, USER_HEADERS);
  var salt = Utilities.getUuid();
  var row = { username: username, display_name: b.display_name || username, role: b.role,
              salt: salt, pin_hash: hashPin_(b.pin, salt), active: "TRUE",
              created_at: new Date().toISOString(), created_by: t.username };
  var existing = findRowIndex_(sh, "username", username);
  var values = USER_HEADERS.map(function (h) { return row[h]; });
  if (existing > 0) sh.getRange(existing, 1, 1, USER_HEADERS.length).setValues([values]);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, USER_HEADERS.length).setValues([values]);
  audit_(t.username, existing > 0 ? "user_update" : "user_create", username + " (" + b.role + ")");
  return { ok: true, username: username };
}

function setUserActive_(token, username, active) {
  var t = requireRole_(token, ["admin"]);
  username = String(username || "").toLowerCase();
  var sh = sheet_(USER_SHEET, USER_HEADERS);
  var i = findRowIndex_(sh, "username", username);
  if (i < 1) return { ok: false, error: "not_found" };
  sh.getRange(i, USER_HEADERS.indexOf("active") + 1).setValue(active ? "TRUE" : "FALSE");
  audit_(t.username, "user_active", username + "=" + (active ? "on" : "off"));
  return { ok: true };
}

/* ============================== ADMIN: DAY CONTROLS ============================== */
function setLock_(token, locked, message) {
  var t = requireRole_(token, ["admin"]);
  setControl_("locked", locked ? "TRUE" : "FALSE");
  setControl_("lock_message", message || (locked ? "Data collection is paused." : ""));
  audit_(t.username, "lock", locked ? "ON" : "OFF");
  return { ok: true, locked: !!locked };
}

function clearDevices_(token) {
  var t = requireRole_(token, ["admin"]);
  var epoch = (parseInt(getControl_().data_epoch, 10) || 0) + 1;
  setControl_("data_epoch", String(epoch));
  audit_(t.username, "clear_devices", "epoch=" + epoch);
  return { ok: true, data_epoch: epoch };
}

/* ============================== ADMIN: DASHBOARD TAB (the "Sheet" half of Both) ============================== */
function buildDashboard_(token) {
  var t = requireRole_(token, ["admin"]);
  var a = analytics_(makeToken_(t.username, "admin")); // reuse aggregation
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("Dashboard") || ss.insertSheet("Dashboard");
  sh.clear();
  var rows = [
    ["HEAL-SL — Summary", ""],
    ["Generated", new Date().toISOString()],
    ["Total checkups", a.total],
    ["Needs follow-up", a.followups],
    ["Routine", a.routine],
    ["", ""],
    ["Question", "Yes"],
    ["Sudden high fever (21d)", a.questions.fever.yes],
    ["Unstoppable bleeding (21d)", a.questions.bleeding.yes],
    ["Recent travel (21d)", a.questions.travel.yes],
    ["Sudden death (4w)", a.questions.sudden_death.yes],
    ["", ""],
    ["Symptom", "Count"]
  ];
  Object.keys(a.symptoms).sort(function (x, y) { return a.symptoms[y] - a.symptoms[x]; })
    .forEach(function (s) { rows.push([s, a.symptoms[s]]); });
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  sh.getRange(1, 1, 1, 2).merge().setFontWeight("bold").setFontSize(14);
  sh.getRange(7, 1, 1, 2).setFontWeight("bold");
  sh.setColumnWidth(1, 280);
  try {
    var chart = sh.newChart().asColumnChart()
      .addRange(sh.getRange(7, 1, 5, 2)).setPosition(2, 4, 0, 0)
      .setOption("title", "Yes responses by question").build();
    sh.insertChart(chart);
  } catch (e) {}
  audit_(t.username, "build_dashboard", "rows=" + rows.length);
  return { ok: true, total: a.total };
}

/* ============================== TOKENS ============================== */
function makeToken_(username, role) {
  var payload = [username, role, dayKey_()].join("|");
  return Utilities.base64EncodeWebSafe(payload) + "." + hmac_(payload);
}
function parseToken_(token) {
  if (!token || token.indexOf(".") < 0) return null;
  var parts = token.split(".");
  var payload;
  try { payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString(); } catch (e) { return null; }
  if (hmac_(payload) !== parts[1]) return null;
  var f = payload.split("|");
  return { username: f[0], role: f[1], day_key: f[2] };
}
function requireRole_(token, roles, allowLocked) {
  var t = parseToken_(token);
  if (!t) throw new Error("unauthorized");
  if (t.day_key !== dayKey_()) throw new Error("session_expired");
  if (roles.indexOf(t.role) < 0) throw new Error("forbidden");
  if (!allowLocked && t.role !== "admin" && getControl_().locked) throw new Error("locked");
  return t;
}
function hmac_(str) {
  var sig = Utilities.computeHmacSha256Signature(str, secret_());
  return Utilities.base64EncodeWebSafe(sig);
}
function secret_() {
  var p = PropertiesService.getScriptProperties();
  var s = p.getProperty("HMAC_SECRET");
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty("HMAC_SECRET", s); }
  return s;
}
function hashPin_(pin, salt) {
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + "|" + String(pin));
  return b.map(function (x) { return ((x & 0xff) + 0x100).toString(16).slice(1); }).join("");
}
function dayKey_(d) { return Utilities.formatDate(d || new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd"); }

/* ============================== SHEET HELPERS ============================== */
function sheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) { sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold"); sh.setFrozenRows(1); }
  return sh;
}
function headerIndex_(sh) { var h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]; var m = {}; h.forEach(function (x, i) { m[x] = i; }); return m; }
function idSet_(sh, col) {
  var set = new Set(); var last = sh.getLastRow(); if (last < 2) return set;
  var c = headerIndex_(sh)[col] + 1;
  sh.getRange(2, c, last - 1, 1).getValues().forEach(function (v) { if (v[0]) set.add(String(v[0])); });
  return set;
}
function findRowIndex_(sh, col, val) {
  var last = sh.getLastRow(); if (last < 2) return -1;
  var c = headerIndex_(sh)[col] + 1;
  var vals = sh.getRange(2, c, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).toLowerCase() === String(val).toLowerCase()) return i + 2;
  return -1;
}
function respRows_() {
  var sh = sheet_(RESP_SHEET, RESP_HEADERS); var last = sh.getLastRow(); if (last < 2) return [];
  var data = sh.getRange(1, 1, last, RESP_HEADERS.length).getValues();
  var head = data.shift(); return data.map(function (r) { var o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o; });
}
function respCount_() { var sh = sheet_(RESP_SHEET, RESP_HEADERS); return Math.max(0, sh.getLastRow() - 1); }
function users_() {
  var sh = sheet_(USER_SHEET, USER_HEADERS); var last = sh.getLastRow(); if (last < 2) return [];
  var data = sh.getRange(2, 1, last - 1, USER_HEADERS.length).getValues();
  return data.map(function (r) { var o = {}; USER_HEADERS.forEach(function (h, i) { o[h] = r[i]; }); return o; });
}
function findUser_(username) { var list = users_(); for (var i = 0; i < list.length; i++) if (String(list[i].username).toLowerCase() === username) return list[i]; return null; }
function nameMap_() { var m = {}; users_().forEach(function (u) { m[u.username] = u.display_name; }); return m; }

function getControl_() {
  var sh = sheet_(CTRL_SHEET, ["key", "value"]);
  var last = sh.getLastRow(); var o = { locked: false, lock_message: "", data_epoch: 0 };
  if (last >= 2) sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
    if (r[0] === "locked") o.locked = String(r[1]).toUpperCase() === "TRUE";
    else if (r[0] === "lock_message") o.lock_message = r[1];
    else if (r[0] === "data_epoch") o.data_epoch = parseInt(r[1], 10) || 0;
  });
  return o;
}
function setControl_(key, value) {
  var sh = sheet_(CTRL_SHEET, ["key", "value"]);
  var i = findRowIndex_(sh, "key", key);
  if (i > 0) sh.getRange(i, 2).setValue(value);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, 2).setValues([[key, value]]);
}
function audit_(actor, action, detail) {
  try { var sh = sheet_(AUDIT_SHEET, ["at", "actor", "action", "detail"]);
    sh.getRange(sh.getLastRow() + 1, 1, 1, 4).setValues([[new Date().toISOString(), actor || "", action || "", detail || ""]]);
  } catch (e) {}
}

/* ============================== UTIL ============================== */
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function jsonp_(cb, o) { return ContentService.createTextOutput(cb + "(" + JSON.stringify(o) + ")").setMimeType(ContentService.MimeType.JAVASCRIPT); }
function safeParse_(s) { try { return JSON.parse(s); } catch (e) { return {}; } }

/* ============================== ONE-TIME SETUP ============================== */
function setup() {
  sheet_(RESP_SHEET, RESP_HEADERS);
  sheet_(USER_SHEET, USER_HEADERS);
  sheet_(CTRL_SHEET, ["key", "value"]);
  sheet_(AUDIT_SHEET, ["at", "actor", "action", "detail"]);
  if (getControl_().data_epoch === 0) { setControl_("locked", "FALSE"); setControl_("lock_message", ""); setControl_("data_epoch", "0"); }
  var sh = sheet_(USER_SHEET, USER_HEADERS);
  if (findRowIndex_(sh, "username", BOOTSTRAP_ADMIN.username) < 1) {
    var salt = Utilities.getUuid();
    sh.getRange(sh.getLastRow() + 1, 1, 1, USER_HEADERS.length).setValues([[
      BOOTSTRAP_ADMIN.username, BOOTSTRAP_ADMIN.display_name, "admin", salt,
      hashPin_(BOOTSTRAP_ADMIN.pin, salt), "TRUE", new Date().toISOString(), "setup"
    ]]);
  }
  audit_("setup", "init", "sheets + admin ready");
  return "Setup complete. Admin user: " + BOOTSTRAP_ADMIN.username;
}
