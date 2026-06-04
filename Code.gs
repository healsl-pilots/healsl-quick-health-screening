/** @OnlyCurrentDoc */
// ^ Restricts this script to ONLY this spreadsheet (scope: spreadsheets.currentonly).
//   This narrow scope is what lets it work under Google's Advanced Protection Program.
/**
 * HEAL-SL Health Quick Checkup — role-based backend (Google Apps Script)
 * ---------------------------------------------------------------------------
 * One Google Sheet is the whole backend. Roles: field-worker, supervisor, admin.
 * Only the ADMIN sets this up once; everyone else just logs in and uses it.
 *
 * - Login = username + PIN (PINs stored only as salted SHA-256 hashes).
 * - Login returns a day-keyed HMAC token that expires at end of day (even offline).
 * - Responses is an APPEND-ONLY, immutable log: the server only ever ADDS new
 *   record_ids and never edits/deletes a row — so data can't be overwritten or lost.
 *   Ownership (username) is stamped from the token, not the device.
 * - Admin manages users + the area list, can pause access, and bump a data epoch
 *   to clean devices (the app uploads first, then erases ONLY synced records).
 *
 * SETUP (admin, once):
 *  1. New Sheet → File ▸ Settings ▸ set your time zone (e.g. Africa/Freetown).
 *  2. Extensions ▸ Apps Script → paste this file → Save.
 *  3. Edit BOOTSTRAP_ADMIN below, then Run ▸ setup (authorise — only this sheet).
 *  4. Deploy ▸ New deployment ▸ Web app: Execute as = Me, Access = Anyone. Copy /exec.
 */

var BOOTSTRAP_ADMIN = { username: "admin", display_name: "Administrator", code: "100", pin: "4729" };

var RESP_SHEET = "Responses", USER_SHEET = "Users", CTRL_SHEET = "Control", AUDIT_SHEET = "Audit";

var RESP_HEADERS = [
  "synced_at", "submitted_at", "record_id", "username", "device_id", "app_version",
  "area", "household_id",
  "q1_fever", "q1_fever_count", "q1_symptoms",
  "q2_bleeding", "q2_bleeding_count",
  "q3_travel", "q3_travel_count", "q3_travel_country", "q3_travel_date",
  "q4_sudden_death", "q4_death_count",
  "reaction_q1", "unease_note_q1", "reaction_q2", "unease_note_q2",
  "reaction_q3", "unease_note_q3", "reaction_q4", "unease_note_q4",
  "gps_lat", "gps_lng", "notes"
];
var USER_HEADERS = ["username", "display_name", "role", "code", "salt", "pin_hash", "active", "created_at", "created_by"];
var ROLES = ["field-worker", "supervisor", "admin"];

/* ============================== ROUTING ============================== */
function doPost(e) {
  e = e || {};
  if (!e.parameter && !e.postData) return json_({ ok: true, note: "Web app live. Call it from the app; run setup() once in the editor to initialise." });
  return handle_(e, (e.parameter && e.parameter.action) || safeParse_(e.postData && e.postData.contents).action);
}
function doGet(e) { e = e || {}; return handle_(e, (e.parameter && e.parameter.action) || "ping"); }

function handle_(e, action) {
  var p = e.parameter || {}, body = (e.postData && e.postData.contents) ? safeParse_(e.postData.contents) : {};
  var cb = p.callback || body.callback, out;
  try {
    switch (action) {
      case "ping":          out = { ok: true, service: "heal-sl", count: respCount_() }; break;
      case "login":         out = login_(body.username || p.username, body.pin || p.pin); break;
      case "status":        out = status_(tok_(p, body)); break;
      case "submit":        out = submit_(tok_(p, body), body.records || []); break;
      case "check":         out = check_(tok_(p, body), (p.ids || body.ids || "").split(",").filter(String)); break;
      case "progress":      out = progress_(tok_(p, body)); break;
      case "analytics":     out = analytics_(tok_(p, body)); break;
      case "listUsers":     out = listUsers_(tok_(p, body)); break;
      case "createUser":    out = createUser_(tok_(p, body), body); break;
      case "setUserActive": out = setUserActive_(tok_(p, body), body.username, body.active); break;
      case "resetPin":      out = resetPin_(tok_(p, body), body.username, body.pin); break;
      case "setAreas":      out = setAreas_(tok_(p, body), body.areas); break;
      case "setLock":       out = setLock_(tok_(p, body), body.locked, body.message); break;
      case "clearDevices":  out = clearDevices_(tok_(p, body)); break;
      case "buildDashboard":out = buildDashboard_(tok_(p, body)); break;
      default:              out = { ok: false, error: "unknown_action" };
    }
  } catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  return cb ? jsonp_(cb, out) : json_(out);
}
function tok_(p, body) { return p.token || body.token || ""; }

/* ============================== AUTH ============================== */
function login_(username, pin) {
  username = String(username || "").toLowerCase().trim();
  if (!username || !pin) return { ok: false, error: "missing_credentials" };
  var u = findUser_(username);
  if (!u || String(u.active).toUpperCase() !== "TRUE") { audit_(username, "login_fail", "no/inactive"); return { ok: false, error: "invalid_login" }; }
  if (hashPin_(pin, u.salt) !== u.pin_hash) { audit_(username, "login_fail", "bad pin"); return { ok: false, error: "invalid_login" }; }
  var c = getControl_();
  audit_(username, "login_ok", u.role);
  return { ok: true, role: u.role, username: u.username, display_name: u.display_name, code: u.code || u.username,
           token: makeToken_(u.username, u.role), day_key: dayKey_(),
           locked: c.locked, lock_message: c.lock_message, data_epoch: c.data_epoch, areas: c.areas };
}
function status_(token) {
  var t = requireRole_(token, ROLES, true), c = getControl_();
  return { ok: true, role: t.role, username: t.username, day_key: dayKey_(),
           locked: c.locked, lock_message: c.lock_message, data_epoch: c.data_epoch, areas: c.areas };
}

/* ============================== SUBMIT (append-only) ============================== */
function submit_(token, records) {
  var t = requireRole_(token, ["field-worker", "admin"]);
  if (getControl_().locked) return { ok: false, locked: true, error: "locked" };
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var sh = sheet_(RESP_SHEET, RESP_HEADERS), ids = idSet_(sh, "record_id"), now = new Date().toISOString();
    var rows = [], written = 0;
    (records || []).forEach(function (r) {
      if (!r || !r.record_id || ids.has(r.record_id)) return;
      r.username = t.username; r.synced_at = now;
      rows.push(RESP_HEADERS.map(function (h) { var v = r[h]; return Array.isArray(v) ? v.join("; ") : ((v === undefined || v === null) ? "" : v); }));
      ids.add(r.record_id); written++;
    });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, RESP_HEADERS.length).setValues(rows);
    return { ok: true, written: written };
  } finally { lock.releaseLock(); }
}
function check_(token, ids) {
  requireRole_(token, ["field-worker", "admin"], true);
  var set = idSet_(sheet_(RESP_SHEET, RESP_HEADERS), "record_id");
  return { ok: true, present: ids.filter(function (id) { return set.has(id); }) };
}

/* ============================== READS ============================== */
function progress_(token) {
  requireRole_(token, ["supervisor", "admin"]);
  var rows = respRows_(), today = dayKey_(), byUser = {};
  rows.forEach(function (r) {
    var u = r.username || "(unknown)", g = byUser[u] || (byUser[u] = { username: u, total: 0, today: 0, last: "" });
    g.total++; if (String(r.submitted_at).slice(0, 10) === today) g.today++; if (r.synced_at > g.last) g.last = r.synced_at;
  });
  users_().forEach(function (u) { if (u.role === "field-worker" && !byUser[u.username]) byUser[u.username] = { username: u.username, total: 0, today: 0, last: "" }; });
  var names = nameMap_();
  var list = Object.keys(byUser).map(function (k) { byUser[k].display_name = names[k] || k; return byUser[k]; });
  list.sort(function (a, b) { return b.today - a.today || b.total - a.total; });
  return { ok: true, day_key: today, total: rows.length, workers: list };
}
function analytics_(token) {
  requireRole_(token, ["admin"]);
  var rows = respRows_(), today = dayKey_(), names = nameMap_();
  var yn = function (k) { var y = 0, n = 0; rows.forEach(function (r) { if (r[k] === "Yes") y++; else if (r[k] === "No") n++; }); return { yes: y, no: n }; };
  var symptoms = {}, reactions = { reaction_q1: {}, reaction_q2: {}, reaction_q3: {}, reaction_q4: {} };
  var countries = {}, byArea = {}, byWorker = {}, unease = 0, todayN = 0;
  var uneaseReasons = [];
  var travel = { total: 0, fever: 0, bleeding: 0, death: 0, symptoms: {} };
  var NOTE_Q = { unease_note_q1: "Q1 fever", unease_note_q2: "Q2 bleeding", unease_note_q3: "Q3 travel", unease_note_q4: "Q4 death" };
  var notes = [];
  rows.forEach(function (r) {
    if (String(r.submitted_at).slice(0, 10) === today) todayN++;
    var ar = r.area || "(none)"; byArea[ar] = (byArea[ar] || 0) + 1;
    var w = names[r.username] || r.username || "(unknown)"; byWorker[w] = (byWorker[w] || 0) + 1;
    var syms = String(r.q1_symptoms || "").split(";").map(function (s) { return s.trim(); }).filter(String);
    syms.forEach(function (s) { symptoms[s] = (symptoms[s] || 0) + 1; });
    ["reaction_q1", "reaction_q2", "reaction_q3", "reaction_q4"].forEach(function (k) { if (r[k]) reactions[k][r[k]] = (reactions[k][r[k]] || 0) + 1; });
    Object.keys(NOTE_Q).forEach(function (k) { if (r[k]) { unease++; uneaseReasons.push({ q: NOTE_Q[k], area: r.area || "", note: String(r[k]) }); } });
    if (r.q3_travel === "Yes") {
      String(r.q3_travel_country || "").split(/[,;\/]/).map(function (s) { return s.trim(); }).filter(String).forEach(function (c) { countries[c] = (countries[c] || 0) + 1; });
      travel.total++;
      if (r.q1_fever === "Yes") travel.fever++;
      if (r.q2_bleeding === "Yes") travel.bleeding++;
      if (r.q4_sudden_death === "Yes") travel.death++;
      syms.forEach(function (s) { travel.symptoms[s] = (travel.symptoms[s] || 0) + 1; });
    }
    if (r.notes && String(r.notes).trim()) notes.push({ area: r.area || "", note: String(r.notes).trim() });
  });
  return { ok: true, total: rows.length, today: todayN,
    questions: { fever: yn("q1_fever"), bleeding: yn("q2_bleeding"), travel: yn("q3_travel"), sudden_death: yn("q4_sudden_death") },
    symptoms: symptoms, reactions: reactions, countries: countries, by_area: byArea, by_worker: byWorker,
    unease_notes: unease, unease_reasons: uneaseReasons, travelers: travel,
    notes: notes, note_topics: topicClusters_(notes) };
}

// Group notes by the meaningful words people actually used, so recurring topics
// (e.g. "malaria", "water", "money") surface with a count + example notes.
// The full note text is always shown too — nothing is summarised away.
var NOTE_STOP = (function () { var s = {}; ("the a an and or but to of in on at for with from by is are was were be been being am i we you he she it they them us our your my me his her their this that these those have has had do does did not no yes will would can could should may might must as so if then else than too very just also more most some any all one two three there here what when where who why how about into out up down over under again only own same other none also said say says tell told ask asked want need get got go went come came make made take took give gave see saw know knew think people person household respondent thing things lot really still even much many we're dont don't can't").split(" ").forEach(function (w) { s[w] = 1; }); return s; })();
function topicClusters_(notes) {
  var df = {}, tokNotes = {};
  notes.forEach(function (o, i) {
    var seen = {};
    String(o.note).toLowerCase().split(/[^a-z]+/).forEach(function (w) {
      if (w.length < 3 || NOTE_STOP[w] || seen[w]) return;
      seen[w] = 1; df[w] = (df[w] || 0) + 1; (tokNotes[w] = tokNotes[w] || []).push(i);
    });
  });
  return Object.keys(df).filter(function (w) { return df[w] >= 2; })
    .sort(function (a, b) { return df[b] - df[a]; }).slice(0, 12)
    .map(function (w) { return { topic: w, count: df[w], examples: tokNotes[w].slice(0, 5).map(function (i) { return notes[i].note; }) }; });
}

/* ============================== ADMIN: USERS ============================== */
function listUsers_(token) {
  requireRole_(token, ["admin"]);
  return { ok: true, users: users_().map(function (u) {
    return { username: u.username, display_name: u.display_name, role: u.role, code: u.code || "", active: String(u.active).toUpperCase() === "TRUE" };
  }) };
}
function createUser_(token, b) {
  var t = requireRole_(token, ["admin"]);
  var username = String(b.username || "").toLowerCase().trim();
  if (!/^[a-z0-9._-]{3,20}$/.test(username)) return { ok: false, error: "bad_username" };
  if (ROLES.indexOf(b.role) < 0) return { ok: false, error: "bad_role" };
  if (!/^\d{4,8}$/.test(String(b.pin || ""))) return { ok: false, error: "bad_pin" };
  var code = String(b.code || "").trim();
  if (code && !/^\d{1,6}$/.test(code)) return { ok: false, error: "bad_code" };
  var sh = sheet_(USER_SHEET, USER_HEADERS), salt = Utilities.getUuid();
  var row = { username: username, display_name: b.display_name || username, role: b.role, code: code,
              salt: salt, pin_hash: hashPin_(b.pin, salt), active: "TRUE", created_at: new Date().toISOString(), created_by: t.username };
  var i = findRowIndex_(sh, "username", username), values = USER_HEADERS.map(function (h) { return row[h]; });
  if (i > 0) sh.getRange(i, 1, 1, USER_HEADERS.length).setValues([values]);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, USER_HEADERS.length).setValues([values]);
  audit_(t.username, i > 0 ? "user_update" : "user_create", username + " (" + b.role + ")");
  return { ok: true, username: username };
}
function setUserActive_(token, username, active) {
  var t = requireRole_(token, ["admin"]); username = String(username || "").toLowerCase();
  var sh = sheet_(USER_SHEET, USER_HEADERS), i = findRowIndex_(sh, "username", username);
  if (i < 1) return { ok: false, error: "not_found" };
  sh.getRange(i, USER_HEADERS.indexOf("active") + 1).setValue(active ? "TRUE" : "FALSE");
  audit_(t.username, "user_active", username + "=" + (active ? "on" : "off"));
  return { ok: true };
}
function resetPin_(token, username, pin) {
  var t = requireRole_(token, ["admin"]); username = String(username || "").toLowerCase();
  if (!/^\d{4,8}$/.test(String(pin || ""))) return { ok: false, error: "bad_pin" };
  var sh = sheet_(USER_SHEET, USER_HEADERS), i = findRowIndex_(sh, "username", username);
  if (i < 1) return { ok: false, error: "not_found" };
  var salt = Utilities.getUuid();
  sh.getRange(i, USER_HEADERS.indexOf("salt") + 1).setValue(salt);
  sh.getRange(i, USER_HEADERS.indexOf("pin_hash") + 1).setValue(hashPin_(pin, salt));
  audit_(t.username, "reset_pin", username);
  return { ok: true };
}

/* ============================== ADMIN: AREAS + DAY CONTROLS ============================== */
function setAreas_(token, areas) {
  var t = requireRole_(token, ["admin"]);
  if (!Array.isArray(areas)) areas = String(areas || "").split(/[\n,]/);
  areas = areas.map(function (a) { return String(a).trim(); }).filter(String);
  setControl_("areas", JSON.stringify(areas));
  audit_(t.username, "set_areas", areas.length + " areas");
  return { ok: true, areas: areas };
}
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

/* ============================== ADMIN: DASHBOARD TAB ============================== */
function buildDashboard_(token) {
  var t = requireRole_(token, ["admin"]);
  var a = analytics_(makeToken_(t.username, "admin"));
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName("Dashboard") || ss.insertSheet("Dashboard");
  sh.clear();
  var R = [], bold = [];
  function head(s) { bold.push(R.length + 1); R.push([s, ""]); }
  function sorted(o) { return Object.keys(o).sort(function (x, y) { return o[y] - o[x]; }); }
  head("HEAL-SL — Summary");
  R.push(["Generated", new Date().toISOString()]); R.push(["Total checkups", a.total]); R.push(["Captured today", a.today]); R.push(["", ""]);
  head("By area"); sorted(a.by_area).forEach(function (k) { R.push([k, a.by_area[k]]); }); if (!Object.keys(a.by_area).length) R.push(["(none)", 0]); R.push(["", ""]);
  head("By worker"); sorted(a.by_worker).forEach(function (k) { R.push([k, a.by_worker[k]]); }); if (!Object.keys(a.by_worker).length) R.push(["(none)", 0]); R.push(["", ""]);
  head("Questions — Yes (No)"); var qStart = R.length + 1;
  R.push(["Sudden high fever (21d)", a.questions.fever.yes]); R.push(["Unstoppable bleeding (21d)", a.questions.bleeding.yes]);
  R.push(["Recent travel (21d)", a.questions.travel.yes]); R.push(["Sudden death (4w)", a.questions.sudden_death.yes]);
  var qEnd = R.length; R.push(["", ""]);
  head("Symptoms"); var syms = sorted(a.symptoms);
  if (syms.length) syms.forEach(function (s) { R.push([s, a.symptoms[s]]); }); else R.push(["(none)", 0]); R.push(["", ""]);
  head("Reactions (At ease / Neutral / Uneasy)");
  var qn = { reaction_q1: "Q1 fever", reaction_q2: "Q2 bleeding", reaction_q3: "Q3 travel", reaction_q4: "Q4 death" };
  Object.keys(qn).forEach(function (k) { var d = a.reactions[k] || {}; R.push([qn[k], (d["At ease"] || 0) + " / " + (d["Neutral"] || 0) + " / " + (d["Uneasy"] || 0)]); });
  R.push(["Uneasy notes captured", a.unease_notes]); R.push(["", ""]);
  head("Countries travelled (frequency)"); var ctr = sorted(a.countries);
  if (ctr.length) ctr.forEach(function (c) { R.push([c, a.countries[c]]); }); else R.push(["(none)", 0]);
  R.push(["", ""]);
  head("Travellers (answered Yes) — what else they reported");
  R.push(["Travelled (Yes)", a.travelers.total]);
  R.push(["… also had fever", a.travelers.fever]);
  R.push(["… also had bleeding", a.travelers.bleeding]);
  R.push(["… had a sudden death", a.travelers.death]);
  sorted(a.travelers.symptoms).forEach(function (s) { R.push(["… symptom: " + s, a.travelers.symptoms[s]]); });
  R.push(["", ""]);
  head("Uneasy — reasons given");
  if (a.unease_reasons.length) a.unease_reasons.forEach(function (u) { R.push([u.q + (u.area ? " (" + u.area + ")" : ""), u.note]); });
  else R.push(["(none)", ""]);
  R.push(["", ""]);
  head("Respondent notes — main topics (" + a.notes.length + " notes)");
  if (a.note_topics.length) a.note_topics.forEach(function (tp) { R.push([tp.topic, tp.count + " notes"]); });
  else R.push(["(no repeated topics yet)", ""]);
  R.push(["", ""]);
  head("Respondent notes — full text");
  if (a.notes.length) a.notes.forEach(function (x) { R.push([x.area || "", x.note]); });
  else R.push(["(none)", ""]);
  sh.getRange(1, 1, R.length, 2).setValues(R);
  bold.forEach(function (rn) { sh.getRange(rn, 1, 1, 2).setFontWeight("bold"); });
  sh.getRange(1, 1, 1, 1).setFontSize(14);
  sh.setColumnWidth(1, 300); sh.setColumnWidth(2, 170);
  try { sh.insertChart(sh.newChart().asColumnChart().addRange(sh.getRange(qStart, 1, qEnd - qStart + 1, 2)).setPosition(2, 4, 0, 0).setOption("title", "Yes responses by question").build()); } catch (e) {}
  audit_(t.username, "build_dashboard", "rows=" + R.length);
  return { ok: true, total: a.total };
}

/* ============================== TOKENS ============================== */
function makeToken_(username, role) { var p = [username, role, dayKey_()].join("|"); return Utilities.base64EncodeWebSafe(p) + "." + hmac_(p); }
function parseToken_(token) {
  if (!token || token.indexOf(".") < 0) return null;
  var parts = token.split("."), payload;
  try { payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString(); } catch (e) { return null; }
  if (hmac_(payload) !== parts[1]) return null;
  var f = payload.split("|"); return { username: f[0], role: f[1], day_key: f[2] };
}
function requireRole_(token, roles, allowLocked) {
  var t = parseToken_(token);
  if (!t) throw new Error("unauthorized");
  if (t.day_key !== dayKey_()) throw new Error("session_expired");
  if (roles.indexOf(t.role) < 0) throw new Error("forbidden");
  if (!allowLocked && t.role !== "admin" && getControl_().locked) throw new Error("locked");
  return t;
}
function hmac_(str) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(str, secret_())); }
function secret_() { var p = PropertiesService.getScriptProperties(), s = p.getProperty("HMAC_SECRET"); if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty("HMAC_SECRET", s); } return s; }
function hashPin_(pin, salt) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + "|" + String(pin)).map(function (x) { return ((x & 0xff) + 0x100).toString(16).slice(1); }).join(""); }
function dayKey_(d) { return Utilities.formatDate(d || new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd"); }

/* ============================== SHEET HELPERS ============================== */
function sheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) { sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold"); sh.setFrozenRows(1); }
  return sh;
}
function headerIndex_(sh) { var h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0], m = {}; h.forEach(function (x, i) { m[x] = i; }); return m; }
function idSet_(sh, col) { var set = new Set(), last = sh.getLastRow(); if (last < 2) return set; var c = headerIndex_(sh)[col] + 1; sh.getRange(2, c, last - 1, 1).getValues().forEach(function (v) { if (v[0]) set.add(String(v[0])); }); return set; }
function findRowIndex_(sh, col, val) { var last = sh.getLastRow(); if (last < 2) return -1; var c = headerIndex_(sh)[col] + 1, vals = sh.getRange(2, c, last - 1, 1).getValues(); for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).toLowerCase() === String(val).toLowerCase()) return i + 2; return -1; }
function respRows_() { var sh = sheet_(RESP_SHEET, RESP_HEADERS), last = sh.getLastRow(); if (last < 2) return []; var data = sh.getRange(1, 1, last, RESP_HEADERS.length).getValues(), head = data.shift(); return data.map(function (r) { var o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o; }); }
function respCount_() { return Math.max(0, sheet_(RESP_SHEET, RESP_HEADERS).getLastRow() - 1); }
function users_() { var sh = sheet_(USER_SHEET, USER_HEADERS), last = sh.getLastRow(); if (last < 2) return []; return sh.getRange(2, 1, last - 1, USER_HEADERS.length).getValues().map(function (r) { var o = {}; USER_HEADERS.forEach(function (h, i) { o[h] = r[i]; }); return o; }); }
function findUser_(username) { var l = users_(); for (var i = 0; i < l.length; i++) if (String(l[i].username).toLowerCase() === username) return l[i]; return null; }
function nameMap_() { var m = {}; users_().forEach(function (u) { m[u.username] = u.display_name; }); return m; }
function getControl_() {
  var sh = sheet_(CTRL_SHEET, ["key", "value"]), last = sh.getLastRow(), o = { locked: false, lock_message: "", data_epoch: 0, areas: [] };
  if (last >= 2) sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
    if (r[0] === "locked") o.locked = String(r[1]).toUpperCase() === "TRUE";
    else if (r[0] === "lock_message") o.lock_message = r[1];
    else if (r[0] === "data_epoch") o.data_epoch = parseInt(r[1], 10) || 0;
    else if (r[0] === "areas") { try { o.areas = JSON.parse(r[1]) || []; } catch (e) { o.areas = []; } }
  });
  return o;
}
function setControl_(key, value) {
  var sh = sheet_(CTRL_SHEET, ["key", "value"]), i = findRowIndex_(sh, "key", key);
  if (i > 0) sh.getRange(i, 2).setValue(value); else sh.getRange(sh.getLastRow() + 1, 1, 1, 2).setValues([[key, value]]);
}
function audit_(actor, action, detail) { try { var sh = sheet_(AUDIT_SHEET, ["at", "actor", "action", "detail"]); sh.getRange(sh.getLastRow() + 1, 1, 1, 4).setValues([[new Date().toISOString(), actor || "", action || "", detail || ""]]); } catch (e) {} }

/* ============================== UTIL ============================== */
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function jsonp_(cb, o) { return ContentService.createTextOutput(cb + "(" + JSON.stringify(o) + ")").setMimeType(ContentService.MimeType.JAVASCRIPT); }
function safeParse_(s) { try { return JSON.parse(s); } catch (e) { return {}; } }

/* ============================== ONE-TIME SETUP ============================== */
function setup() {
  sheet_(RESP_SHEET, RESP_HEADERS); sheet_(USER_SHEET, USER_HEADERS);
  sheet_(CTRL_SHEET, ["key", "value"]); sheet_(AUDIT_SHEET, ["at", "actor", "action", "detail"]);
  var c = getControl_();
  if (c.data_epoch === 0) { setControl_("locked", "FALSE"); setControl_("lock_message", ""); setControl_("data_epoch", "0"); }
  if (!c.areas || !c.areas.length) setControl_("areas", JSON.stringify(["Area 1", "Area 2"]));
  var sh = sheet_(USER_SHEET, USER_HEADERS);
  if (findRowIndex_(sh, "username", BOOTSTRAP_ADMIN.username) < 1) {
    var salt = Utilities.getUuid();
    sh.getRange(sh.getLastRow() + 1, 1, 1, USER_HEADERS.length).setValues([[
      BOOTSTRAP_ADMIN.username, BOOTSTRAP_ADMIN.display_name, "admin", BOOTSTRAP_ADMIN.code || "",
      salt, hashPin_(BOOTSTRAP_ADMIN.pin, salt), "TRUE", new Date().toISOString(), "setup"]]);
  }
  audit_("setup", "init", "ready");
  return "Setup complete. Admin user: " + BOOTSTRAP_ADMIN.username;
}

// RESCUE: run this in the editor if the admin is locked out (forgot the admin PIN).
// It resets the admin's PIN to whatever BOOTSTRAP_ADMIN.pin currently is.
function resetAdminPin() {
  var sh = sheet_(USER_SHEET, USER_HEADERS), i = findRowIndex_(sh, "username", BOOTSTRAP_ADMIN.username);
  if (i < 1) { setup(); return "Admin created with PIN from BOOTSTRAP_ADMIN."; }
  var salt = Utilities.getUuid();
  sh.getRange(i, USER_HEADERS.indexOf("salt") + 1).setValue(salt);
  sh.getRange(i, USER_HEADERS.indexOf("pin_hash") + 1).setValue(hashPin_(BOOTSTRAP_ADMIN.pin, salt));
  sh.getRange(i, USER_HEADERS.indexOf("active") + 1).setValue("TRUE");
  audit_("editor", "reset_admin_pin", BOOTSTRAP_ADMIN.username);
  return "Admin PIN reset to BOOTSTRAP_ADMIN.pin for " + BOOTSTRAP_ADMIN.username;
}
