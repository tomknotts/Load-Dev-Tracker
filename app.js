'use strict';
const APP_VERSION = 'v24'; // keep in step with CACHE in sw.js (shown in Settings > About so you can tell which copy a browser is running)
/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.').replace('−', '-'));
  return Number.isFinite(n) ? n : null;
};
const fin = Number.isFinite;
const fmt = (n, d = 3) => (fin(n) ? n.toFixed(d) : '—');
const sfmt = (n, d = 2) => (fin(n) ? (n < 0 ? '−' : '+') + Math.abs(n).toFixed(d) : '—');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2600); };

/* ---------- theme: light / dark / auto (follows the phone). Per-device, kept in localStorage so it applies before first paint ---------- */
const themePref = () => { try { return localStorage.getItem('theme') || 'auto'; } catch (e) { return 'auto'; } };
const accentPref = () => { try { const a = localStorage.getItem('accent'); return a === 'blue' || a === 'orange' ? a : 'green'; } catch (e) { return 'green'; } };
function applyTheme(p = themePref(), a = accentPref()) {
  const root = document.documentElement;
  if (p === 'light' || p === 'dark') root.setAttribute('data-theme', p); else root.removeAttribute('data-theme');
  if (a === 'blue' || a === 'orange') root.setAttribute('data-accent', a); else root.removeAttribute('data-accent');
  const m = document.querySelector('meta[name=theme-color]'); // browser / status bar color follows the accent
  if (m) m.setAttribute('content', getComputedStyle(root).getPropertyValue('--accent').trim() || '#3f5b2e');
}
applyTheme();
if (matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());

/* ---------- IndexedDB (all data stays on this device) ---------- */
const STORES = ['rifles', 'calibers', 'bullets', 'powders', 'primers', 'cases', 'sessions', 'groups', 'hist', 'prefs', 'ledger', 'batches']; // exported / imported
const ALL_STORES = [...STORES, 'meta']; // meta = per-device settings (backup reminder), never exported
let db;
const S = {};
const rp = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const store = (s, m) => db.transaction(s, m).objectStore(s);
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('loadtracker', 5);
    r.onupgradeneeded = () => { for (const s of ALL_STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function loadAll() {
  for (const s of ALL_STORES) S[s] = await rp(store(s, 'readonly').getAll());
  S.cfg = S.meta.find((m) => m.id === 'cfg') || { id: 'cfg', lastBackup: null, days: 7, groups: 10, snooze: 0, libMig: 0 };
}
const saveCfg = () => rp(store('meta', 'readwrite').put(S.cfg));

/* One-time / idempotent upgrades: older data (v1) had no Session entity. */
async function migrate() {
  // groups logged before distance existed are assumed to be 100 yd (edit the group to correct one)
  for (const g of S.groups) if (!fin(g.distance)) await put('groups', { ...g, distance: 100 });
  const orphans = S.groups.filter((g) => !g.sessionId);
  if (orphans.length) {
    // one session per rifle + distinct date, using the fouling count the old logic was inferring (first group that had one)
    const buckets = new Map();
    for (const g of orphans.slice().sort((a, b) => a.ts - b.ts)) {
      const k = g.rifleId + '|' + g.date;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(g);
    }
    for (const arr of buckets.values()) {
      const f = arr.find((g) => fin(g.fouling)), w = arr.find((g) => g.wind), t = arr.find((g) => fin(g.temp));
      const s = { id: uid(), rifleId: arr[0].rifleId, date: arr[0].date, wind: w ? w.wind : '', temp: t ? t.temp : null, fouling: f ? f.fouling : 0, ts: arr[0].ts };
      await put('sessions', s);
      for (const g of arr) {
        const ng = { ...g, sessionId: s.id };
        const extra = [];
        if (g.wind && g.wind !== s.wind) extra.push('wind: ' + g.wind);
        if (fin(g.temp) && g.temp !== s.temp) extra.push('temp: ' + g.temp + ' F');
        if (extra.length) ng.notes = (g.notes ? g.notes + ' ' : '') + '[' + extra.join(', ') + ']';
        delete ng.date; delete ng.wind; delete ng.temp; delete ng.fouling;
        await put('groups', ng);
      }
    }
  }
  if (!(S.cfg.libMig >= 2)) {
    for (const b of S.bullets) if (!b.style && /a-?max|sierra|matchking/i.test(b.name)) await put('bullets', { ...b, style: 'BTHP' });
    for (const p of S.primers) if (!p.type && /federal/i.test(p.name) && /215/.test(p.name)) await put('primers', { ...p, type: 'Large Rifle Magnum' });
    S.cfg.libMig = 2;
    await saveCfg();
  }
  if (!(S.cfg.libMig >= 3)) { // fill bullet caliber from its diameter so existing bullets sort into the right rifles
    const byDia = { 0.224: '.223', 0.243: '6mm', 0.264: '6.5mm', 0.277: '.270', 0.284: '7mm', 0.308: '.308', 0.311: '.303', 0.338: '.338', 0.451: '.45', 0.452: '.45' };
    for (const b of S.bullets) if (!b.caliber && fin(b.diameter) && byDia[b.diameter]) await put('bullets', { ...b, caliber: byDia[b.diameter] });
    S.cfg.libMig = 3;
    await saveCfg();
  }
  // Calibers are now a library shared by rifles and bullets (v3 stored free text). Rifle names win, so ".308" bullets join a ".308 Win" rifle's caliber.
  const addCal = async (name) => { const c = { id: uid(), name: name.trim() }; await put('calibers', c); return c; };
  for (const r of S.rifles) {
    if (!r.caliber) continue;
    const c = S.calibers.find((x) => calNorm(x.name) === calNorm(r.caliber)) || await addCal(r.caliber);
    const nr = { ...r, caliberId: r.caliberId || c.id };
    delete nr.caliber;
    await put('rifles', nr);
  }
  for (const b of S.bullets) {
    if (!b.caliber) continue;
    const c = S.calibers.find((x) => calMatch(x.name, b.caliber)) || await addCal(b.caliber);
    const nb = { ...b, caliberId: b.caliberId || c.id };
    delete nb.caliber;
    await put('bullets', nb);
  }
}
async function put(s, o) {
  await rp(store(s, 'readwrite').put(o));
  const i = S[s].findIndex((x) => x.id === o.id);
  if (i >= 0) S[s][i] = o; else S[s].push(o);
}
async function del(s, id) { await rp(store(s, 'readwrite').delete(id)); S[s] = S[s].filter((x) => x.id !== id); }
const byId = (s, id) => S[s].find((x) => x.id === id);
// Archived library items (bullets, powders, primers, cases; `archived` is true only when set, so old data and old exports read as active) are left out of every
// pick-list. keepId keeps the item already chosen on a record being edited, so editing never silently swaps it.
const act = (list, keepId) => list.filter((x) => !x.archived || x.id === keepId);

function buildExport() { // the one backup file, used by both Export (download) and Share backup
  const data = {};
  for (const s of STORES) data[s] = S[s];
  return { json: JSON.stringify({ app: '308-load-dev-tracker', version: 10, exported: new Date().toISOString(), data }, null, 2), name: `load-dev-backup-${today()}.json` };
}
function shareSupport(file) { // '' when this browser can share the file, otherwise the reason it cannot
  if (!navigator.share) return 'no share function' + (window.isSecureContext ? '' : ', page not secure');
  if (!navigator.canShare) return 'no canShare';
  try { return navigator.canShare({ files: [file] }) ? '' : 'browser refuses JSON files'; } catch (e) { return 'canShare error: ' + (e && e.name); }
}
async function markBackedUp() { S.cfg.lastBackup = Date.now(); S.cfg.snooze = 0; await saveCfg(); renderBanners(); }
/* Share backup: the same file, handed to the phone's share sheet. The file is built synchronously inside the tap (no await before navigator.share),
   so the share call stays inside the user gesture. Only a completed share counts as a backup for the reminder; cancelling does not. */
async function shareBackup() {
  const { json, name } = buildExport();
  const file = new File([json], name, { type: 'application/json' });
  const why = shareSupport(file);
  if (why) { await exportData(); toast(`Sharing files is not supported here (${why}), so the backup was downloaded instead`); return; }
  try { await navigator.share({ files: [file] }); }
  catch (e) { toast(e && e.name === 'AbortError' ? 'Share cancelled. Backup not recorded.' : `Share failed (${(e && e.name) || 'error'}${e && e.message ? ': ' + e.message.slice(0, 80) : ''}). Use Export data instead.`); return; }
  await markBackedUp();
  toast('Share completed. Backup recorded.');
}
async function exportData() {
  const { json, name } = buildExport();
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  S.cfg.lastBackup = Date.now(); S.cfg.snooze = 0;
  await saveCfg();
  renderBanners();
  toast('Backup downloaded');
}
async function importData(file) {
  let j;
  try { j = JSON.parse(await file.text()); } catch { toast('Not a valid JSON file'); return; }
  if (!j || j.app !== '308-load-dev-tracker' || !j.data) { toast('Not a Load Dev Tracker backup'); return; }
  if (!confirm('Import REPLACES all data currently on this device. Continue?')) return;
  const t = db.transaction(STORES, 'readwrite');
  for (const s of STORES) {
    const os = t.objectStore(s);
    os.clear();
    for (const o of (Array.isArray(j.data[s]) ? j.data[s] : [])) if (o && o.id) os.put(o);
  }
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  await loadAll();
  await migrate(); // accepts v1 backups (no sessions) too
  S.cfg.lastBackup = Date.now();
  await saveCfg();
  toast('Import complete');
  render();
}

/* ---------- calculations ---------- */
function gstats(g) {
  const b = byId('bullets', g.bulletId);
  const pts = g.shots.filter((s) => fin(s.x) && fin(s.y));
  const n = pts.length;
  const r = { n, total: g.shots.length, cx: null, cy: null, mr: null, es: null, esOO: null, poa: null, dia: b && fin(b.diameter) ? b.diameter : null };
  if (n >= 1) {
    r.cx = pts.reduce((a, p) => a + p.x, 0) / n;
    r.cy = pts.reduce((a, p) => a + p.y, 0) / n;
    r.poa = Math.hypot(r.cx, r.cy);
  }
  if (n >= 2) {
    r.mr = pts.reduce((a, p) => a + Math.hypot(p.x - r.cx, p.y - r.cy), 0) / n;
    let m = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) m = Math.max(m, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    r.es = m;
    if (r.dia !== null) r.esOO = m + r.dia;
  }
  const v = g.shots.map((s) => s.v).filter(fin);
  r.vn = v.length;
  r.vavg = v.length ? v.reduce((a, b2) => a + b2, 0) / v.length : null;
  r.vsd = v.length >= 2 ? Math.sqrt(v.reduce((a, x) => a + (x - r.vavg) ** 2, 0) / (v.length - 1)) : null;
  r.ves = v.length >= 2 ? Math.max(...v) - Math.min(...v) : null;
  return r;
}
// MOA = inches / (1.047" per 100 yd x distance/100). Blank when there is no usable distance.
const moa = (inches, yd) => (fin(inches) && fin(yd) && yd > 0 ? inches / (1.047 * yd / 100) : null);
const bestDist = () => (fin(S.cfg.bestDist) && S.cfg.bestDist > 0 ? S.cfg.bestDist : 100);
// A combo = Bullet + Powder + Charge + Primer + Jump + Distance. Distance is part of it because the best load at 100 yd may not be best at 300.
// Firearm type: 'rifle' or 'pistol'. A record with no type is a rifle (nothing is rewritten, the default is applied when reading).
const isPistol = (rid) => { const r = byId('rifles', rid); return !!r && r.type === 'pistol'; };
// Archived firearms (`archived` is true only when set, so old data and old exports read as active) are hidden from the main page and every firearm
// pick-list, skipped by the low-stock check, and open view-only. Nothing about their groups, sessions, batches or ledger is ever touched.
const isArch = (rid) => { const r = byId('rifles', rid); return !!r && !!r.archived; };
const liveRifles = () => S.rifles.filter((r) => !r.archived);
const archBanner = (rid) => (isArch(rid) ? `<div class="card excl"><div class="row sb"><b><span class="tag">Archived</span> View only</b><button class="btn sm" data-act="rifle-restore" data-id="${rid}">Restore</button></div><div class="muted">Adding and editing are off until you restore this firearm. Its data is unchanged.</div></div>` : '');
const viewOnly = (rid) => { if (!isArch(rid)) return false; toast('Archived firearm: restore it to add or edit'); return true; };
// Rifle key uses Jump; pistol key uses COAL instead (no jump on a pistol). Everything else, including this pooling function, is shared.
const ckey = (g) => (isPistol(g.rifleId)
  ? [g.bulletId, g.powderId, Number(g.charge), g.primerId, Number(g.coal), Number(g.distance)]
  : [g.bulletId, g.powderId, Number(g.charge), g.primerId, Number(g.jump), Number(g.distance)]).join('|');
function combos(groups) {
  const m = new Map();
  for (const g of groups) {
    if (g.include === false) continue;
    if (!m.has(ckey(g))) m.set(ckey(g), { key: ckey(g), bulletId: g.bulletId, powderId: g.powderId, charge: g.charge, primerId: g.primerId, jump: g.jump, coal: g.coal, pistol: isPistol(g.rifleId), distance: g.distance, groups: [] });
    m.get(ckey(g)).groups.push(g);
  }
  return [...m.values()].map((c) => {
    const st = c.groups.map(gstats);
    const mrs = st.filter((s) => s.mr !== null);
    const wn = mrs.reduce((a, s) => a + s.n, 0);
    const ess = st.filter((s) => s.es !== null);
    const vs = st.filter((s) => s.vavg !== null);
    const vn = vs.reduce((a, s) => a + s.vn, 0);
    const mr = wn ? mrs.reduce((a, s) => a + s.mr * s.n, 0) / wn : null;
    const es = ess.length ? ess.reduce((a, s) => a + s.es, 0) / ess.length : null;
    return {
      ...c,
      nGroups: c.groups.length,
      nShots: c.groups.reduce((a, g) => a + g.shots.length, 0),
      mr, es, mrMoa: moa(mr, c.distance), esMoa: moa(es, c.distance),
      vel: vn ? vs.reduce((a, s) => a + s.vavg * s.vn, 0) / vn : null,
      // pistol only: manually entered group sizes, simple average (not a precision metric) and how many groups had one
      gsN: c.groups.filter((g) => fin(g.groupSize)).length,
      gsAvg: c.groups.some((g) => fin(g.groupSize)) ? c.groups.filter((g) => fin(g.groupSize)).reduce((a, g) => a + g.groupSize, 0) / c.groups.filter((g) => fin(g.groupSize)).length : null
    };
  }).sort((a, b) => (a.distance - b.distance) || (a.mr ?? 9e9) - (b.mr ?? 9e9)); // by distance, then best (smallest) mean radius
}
/* Sessions are explicit: several can share a date (barrel cleaned in between). Groups keep their logged order (ts). */
const sessOf = (g) => byId('sessions', g.sessionId);
const gdate = (g) => (sessOf(g) || {}).date || '—';
const groupsOf = (sid) => S.groups.filter((g) => g.sessionId === sid).sort((a, b) => a.ts - b.ts);
const sessionsOf = (rid) => S.sessions.filter((s) => s.rifleId === rid).sort((a, b) => a.ts - b.ts);
const latestSession = (rid) => sessionsOf(rid).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts)[0] || null;
function sessionLabel(s) {
  const same = sessionsOf(s.rifleId).filter((x) => x.date === s.date);
  return s.date + (same.length > 1 ? ` (session ${same.findIndex((x) => x.id === s.id) + 1})` : '');
}
// Rounds since clean = session fouling + every shot in earlier groups of the SAME session (Include flag does not matter: those rounds were fired).
function roundsSinceClean(g) {
  const s = sessOf(g);
  if (!s) return null;
  let acc = fin(s.fouling) ? s.fouling : 0;
  for (const x of groupsOf(s.id)) { if (x.id === g.id) return acc; acc += x.shots.length; }
  return null;
}
function rifleTotals(rid) {
  const gs = S.groups.filter((g) => g.rifleId === rid);
  const shots = gs.reduce((a, g) => a + g.shots.length, 0);
  const fouling = sessionsOf(rid).reduce((a, s) => a + (fin(s.fouling) ? s.fouling : 0), 0);
  const r = byId('rifles', rid);
  const start = r && fin(r.startRounds) ? r.startRounds : 0;
  return { shots, fouling, start, barrel: start + shots + fouling };
}

/* ---------- labels ---------- */
const bl = (id) => { const b = byId('bullets', id); return b ? b.name + (fin(b.weight) ? ' ' + b.weight + ' gn' : '') : '?'; };
const nm = (s, id) => (byId(s, id) || {}).name || '?';
// takes a pooled combo (has .pistol) or a single group (has .rifleId): a pistol shows COAL where a rifle shows jump
const comboLabel = (c) => `${bl(c.bulletId)} · ${nm('powders', c.powderId)} ${c.charge} gn · ${nm('primers', c.primerId)} · ${(c.pistol ?? isPistol(c.rifleId)) ? 'COAL ' + c.coal + '"' : c.jump + ' thou'} · ${c.distance} yd`;

/* ---------- Issue flags ----------
   A flagged group (issue = true) is always Include = N, so it never enters pooled stats. The flag also marks the LOAD:
   scope 'exact'  = same bullet + powder + charge + primer + jump (rifle) / COAL (pistol), any distance;
   scope 'higher' = same bullet + powder, charge at or above the flagged charge;
   scope 'lower'  = same bullet + powder, charge at or below it. Flags never cross firearms. Blank fields in a query match anything (cautious). */
const ISSUE_CATS = ['Short stroke', 'Failure to feed-eject', 'Pressure signs', 'Squib-weak', 'Accuracy', 'Other'];
const SCOPE_TEXT = { exact: 'this load only', higher: 'this charge and higher', lower: 'this charge and lower' };
const blank = (v) => v === undefined || v === null || v === '' || Number.isNaN(v);
function flagsFor(l, exceptId) {
  const pistol = isPistol(l.rifleId);
  const same = (a, b) => blank(a) || blank(b) || Number(a) === Number(b);
  return S.groups.filter((f) => {
    if (f.issue !== true || f.rifleId !== l.rifleId || f.id === exceptId) return false;
    if (f.bulletId !== l.bulletId || f.powderId !== l.powderId || blank(l.charge)) return false;
    const c = Number(l.charge), fc = Number(f.charge), sc = f.issueScope || 'exact';
    if (sc === 'higher') return c >= fc;
    if (sc === 'lower') return c <= fc;
    return c === fc && (blank(l.primerId) || l.primerId === f.primerId) && (pistol ? same(l.coal, f.coal) : same(l.jump, f.jump));
  });
}
const comboFlags = (c) => flagsFor({ rifleId: c.groups[0].rifleId, bulletId: c.bulletId, powderId: c.powderId, charge: c.charge, primerId: c.primerId, jump: c.jump, coal: c.coal });
const comboFlagged = (c) => comboFlags(c).length > 0;
const flagBadge = (c) => (comboFlagged(c) ? '<span class="tag r">Issue on this load</span>' : '');
const flagLine = (f) => `<a href="#/group/${f.id}" style="display:block;color:inherit"><b>${f.charge} gn · ${esc(f.issueCategory || 'Issue')}</b> — applies to ${SCOPE_TEXT[f.issueScope || 'exact']}${f.issueNote ? `<div class="muted" style="color:inherit">${esc(f.issueNote)}</div>` : ''}<div class="muted" style="color:inherit">${esc(gdate(f))} · ${esc(bl(f.bulletId))} · ${esc(nm('powders', f.powderId))} · ${esc(nm('primers', f.primerId))} · ${isPistol(f.rifleId) ? 'COAL ' + f.coal + '"' : f.jump + ' thou'}</div></a>`;
const issueBox = (g) => (g.issue === true ? `<div class="card flagbox"><div class="lbl" style="color:inherit">Issue logged on this group</div><b>${esc(g.issueCategory || 'No category')}</b><div>Applies to ${SCOPE_TEXT[g.issueScope || 'exact']}</div>${g.issueNote ? `<div>${esc(g.issueNote)}</div>` : ''}</div>` : '');

/* ---------- Cost (display only: never feeds pooling, ranking, best load, issue flags or any statistic) ----------
   Prices are entered before tax. Per unit: (price + shipping and fees) x (1 + tax) / quantity.
   Powder is cost per grain (7000 gr/lb, 15432.36 gr/kg) x the charge; a case is cost per firing (/ quantity / loads per case, default 10).
   A price of 0 is valid (free brass). Anything blank is "missing" and is never treated as zero. No price history is stored. */
const GR_PER_LB = 7000, GR_PER_KG = 15432.36;
const costPrefs = () => S.prefs.find((p) => p.id === 'cost') || { id: 'cost', tax: 12, currency: 'CAD' };
const taxPct = () => (fin(costPrefs().tax) && costPrefs().tax >= 0 ? costPrefs().tax : 12);
const curLabel = () => costPrefs().currency || 'CAD';
const money = (n, d = 3) => (fin(n) ? '$' + n.toFixed(d) : '—');
const hasNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
function unitPre(kind, it, charge) { // before-tax cost of one bullet / one primer / one firing of a case / `charge` grains of powder; null = missing
  if (!it || !hasNum(it.price)) return null;
  const total = Number(it.price) + (hasNum(it.ship) ? Number(it.ship) : 0);
  if (kind === 'powder') {
    const pkg = Number(it.pkg);
    if (!(pkg > 0) || !hasNum(charge)) return null;
    return total / (pkg * (it.unit === 'kg' ? GR_PER_KG : GR_PER_LB)) * Number(charge);
  }
  const qty = Number(it.qty);
  if (!(qty > 0)) return null;
  if (kind === 'case') return total / qty / (hasNum(it.loads) && Number(it.loads) > 0 ? Number(it.loads) : 10);
  return total / qty;
}
function loadCost(parts) { // parts: { bullet, powder, primer, brass, charge }
  const rate = taxPct() / 100;
  const pre = { bullet: unitPre('bullet', parts.bullet), powder: unitPre('powder', parts.powder, parts.charge), primer: unitPre('primer', parts.primer), brass: unitPre('case', parts.brass) };
  const missing = Object.keys(pre).filter((k) => pre[k] === null);
  const sumPre = Object.keys(pre).reduce((a, k) => a + (pre[k] ?? 0), 0);
  return { pre, missing, incomplete: missing.length > 0, none: missing.length === 4, sumPre, tax: sumPre * rate, total: sumPre * (1 + rate) };
}
const COST_NAMES = { bullet: 'Bullet', powder: 'Powder', primer: 'Primer', brass: 'Brass' };
function costLines(L, why = {}) {
  return ['bullet', 'powder', 'primer', 'brass'].map((k) => `<div class="kv"><span>${COST_NAMES[k]}${L.pre[k] === null && why[k] ? ' <small style="display:inline">(' + esc(why[k]) + ')</small>' : ''}</span><b>${L.pre[k] === null ? '<span style="color:var(--amber)">missing</span>' : money(L.pre[k])}</b></div>`).join('')
    + `<div class="kv"><span>Tax (${taxPct()}%)</span><b>${L.none ? '—' : money(L.tax)}</b></div>`;
}
// small cost block for a group page
function costCard(g) {
  const L = loadCost({ bullet: byId('bullets', g.bulletId), powder: byId('powders', g.powderId), primer: byId('primers', g.primerId), brass: g.caseId ? byId('cases', g.caseId) : null, charge: g.charge });
  const why = { brass: g.caseId ? 'no price' : 'no case set' };
  return `<div class="card"><div class="row sb"><div class="lbl">Cost per round</div><b class="mono">${L.none ? '—' : money(L.total)}${L.incomplete ? ' · incomplete' : ''}</b></div>
    ${costLines(L, why)}
    <div class="muted">Before tax, then tax. Informational only. ${L.incomplete ? 'Missing lines are left out of the total, not counted as zero.' : ''} ${esc(curLabel())}</div></div>`;
}
function costLive(kind, v) { // sanity-check line shown inside the library edit dialog
  const rate = 1 + taxPct() / 100;
  if (kind === 'powders') {
    const p = unitPre('powder', v, 1);
    return p === null ? 'Cost per grain: missing price or package size' : `With tax: $${(p * rate).toFixed(5)} per grain · $${(p * rate * 10).toFixed(4)} per 10 gr`;
  }
  const k = { bullets: 'bullet', primers: 'primer', cases: 'case' }[kind], lab = { bullet: 'per bullet', primer: 'per primer', case: 'per firing' }[k];
  const p = unitPre(k, v);
  return p === null ? `Cost ${lab}: missing price or quantity` : `With tax (${taxPct()}%): $${(p * rate).toFixed(4)} ${lab}`;
}

/* ---------- UI plumbing ---------- */
// With rid, the middle of the bar shows the rifle name (tap = that rifle's main page) and the page name underneath.
const bar = (left, title, right = '', rid = null) => {
  const r = rid && byId('rifles', rid);
  const mid = r ? `<a class="t" href="#/rifle/${rid}" data-up><span class="n">${esc(r.name)}</span><small>${esc(title)}</small></a>` : `<div class="t">${esc(title)}</div>`;
  $('#bar').innerHTML = `${left || '<span style="min-width:64px"></span>'}${mid}${right || '<span style="min-width:64px"></span>'}`;
};
const main = (h) => { $('#main').innerHTML = h; window.scrollTo(0, 0); };
/* In-app navigation depth, so Back retraces your steps (group -> session -> group ...). navIdx is kept in history.state, which survives reloads.
   With no in-app history (opened on a deep link) Back falls back to the page's parent. */
let navIdx = 0, pendingReplace = false, navHashes = []; // navHashes[i] = the page at history depth i (kept in sessionStorage)
const saveNav = () => { try { sessionStorage.setItem('navstack', JSON.stringify(navHashes)); } catch (e) { /* fine without it */ } };
function initNav() {
  const st = history.state;
  try { navHashes = JSON.parse(sessionStorage.getItem('navstack') || '[]'); } catch (e) { navHashes = []; }
  if (st && typeof st.i === 'number') navIdx = st.i; else { navIdx = 0; navHashes = []; history.replaceState({ i: 0 }, ''); }
  navHashes.length = navIdx + 1; navHashes[navIdx] = location.hash || '#/'; saveNav();
}
function trackNav() {
  const st = history.state;
  if (st && typeof st.i === 'number') { navIdx = st.i; navHashes[navIdx] = location.hash || '#/'; } // back / forward
  else { // a new page, or a replacement of the current one
    if (!pendingReplace) navIdx += 1;
    history.replaceState({ i: navIdx }, '');
    navHashes.length = navIdx; navHashes[navIdx] = location.hash || '#/';
  }
  pendingReplace = false; saveNav();
}
/* "Up" links (top-level pages: rifle -> home, lists -> rifle, and the rifle name in the bar): if the target page is already earlier in this
   history, jump back to it instead of stacking a new copy. That is what stops Back from ping-ponging between the same pages. */
function goUp(href) {
  const target = href.split('?')[0];
  if (target === (location.hash || '#/').split('?')[0]) { window.scrollTo(0, 0); return; }
  for (let k = navIdx - 1; k >= 0; k--) if (navHashes[k] && navHashes[k].split('?')[0] === target) { history.go(k - navIdx); return; }
  navTo(href, true);
}
// replace = swap the current history entry (used after saving a form, so Back skips the form)
function navTo(hash, replace) {
  if (location.hash === hash) { pendingReplace = false; render(); return; }
  if (replace) { pendingReplace = true; location.replace(hash); } else location.hash = hash;
}
// up = a top-level page: always goes to its parent. Otherwise Back retraces your steps (falls back to the parent with no history).
const back = (href, label, up) => (up ? `<a href="${href}" data-up>← ${esc(label)}</a>` : `<a href="${href}" data-back>← ${navIdx > 0 ? 'Back' : esc(label)}</a>`);
const opts = (list, sel, lab, blank) => (blank ? `<option value="">${esc(blank)}</option>` : '') + list.map((x) => `<option value="${esc(x.id)}"${x.id === sel ? ' selected' : ''}>${esc(lab(x))}</option>`).join('');
let F = { rid: null, powder: '', bullet: '', primer: '', charge: '', jump: '' };

// a pick-any list of checkboxes (stored as an array of ids)
const multiField = (f, vals) => `<div class="f" id="d-${f.k}"><span class="lbl">${esc(f.label)}</span>${f.opts.length
  ? f.opts.map((o) => `<label class="row" style="min-height:44px"><input type="checkbox" name="m-${f.k}" value="${esc(o[0])}"${(vals[f.k] || []).includes(o[0]) ? ' checked' : ''} style="width:24px;height:24px"> ${esc(o[1])}</label>`).join('')
  : `<div class="muted">${esc(f.empty || 'Nothing to pick yet.')}</div>`}</div>`;
function formDialog(title, fields, vals, onSave, onDelete, live) {
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog"><h1 style="font-size:22px">${esc(title)}</h1>
    ${fields.map((f) => f.type === 'multi' ? multiField(f, vals) : `<div class="f"><label class="lbl" for="d-${f.k}">${esc(f.label)}</label>${
      f.type === 'select'
        ? `<select class="in" id="d-${f.k}"${f.disabled ? ' disabled' : ''}>${f.opts.map((o) => `<option value="${esc(o[0])}"${o[0] === vals[f.k] ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`
        : `<input class="in ${f.type === 'num' ? 'm' : ''}" id="d-${f.k}" type="text" ${f.type === 'num' ? 'inputmode="decimal"' : ''} ${f.list ? `list="dl-${f.k}"` : ''} value="${esc(vals[f.k] ?? '')}" autocomplete="off">${f.list ? `<datalist id="dl-${f.k}">${f.list.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>` : ''}`}</div>`).join('')}
    ${live ? '<div id="d-live" class="card muted"></div>' : ''}
    <div class="grid2"><button class="btn pri" value="ok">Save</button><button class="btn" value="cancel" type="button" id="d-x">Cancel</button></div>
    ${onDelete ? '<button class="btn danger sm" type="button" id="d-del">Delete</button>' : ''}</form>`;
  document.body.appendChild(d);
  if (live) { // a line that recalculates as you type (used for the cost sanity check)
    const readNow = () => { const o = {}; for (const f of fields) { if (f.type === 'multi') continue; const el = $('#d-' + f.k, d); const raw = el ? el.value.trim() : ''; o[f.k] = f.type === 'num' ? num(raw) : raw; } return o; };
    const upd = () => { $('#d-live', d).textContent = live(readNow()); };
    $('form', d).addEventListener('input', upd); $('form', d).addEventListener('change', upd); upd();
  }
  const close = () => { d.close(); d.remove(); };
  $('#d-x', d).onclick = close;
  d.addEventListener('cancel', () => setTimeout(() => d.remove(), 0));
  if (onDelete) $('#d-del', d).onclick = async () => { if (await onDelete()) { close(); render(); } };
  $('form', d).onsubmit = async (e) => {
    e.preventDefault();
    const out = {};
    for (const f of fields) {
      if (f.type === 'multi') { out[f.k] = $$(`input[name="m-${f.k}"]:checked`, d).map((i) => i.value); continue; }
      const raw = $('#d-' + f.k, d).value.trim();
      out[f.k] = f.type === 'num' ? num(raw) : raw;
      if (f.req && (out[f.k] === null || out[f.k] === '')) { toast(`${f.label} is required`); return; }
    }
    try { await onSave(out); } catch (err) { return; } // onSave already told the user why
    close();
    render();
  };
  d.showModal();
}

/* ---------- views ---------- */
function viewHome() {
  bar('', 'Load Dev Tracker', '<button class="r" data-act="menu" aria-label="Menu" aria-haspopup="true" aria-expanded="false" aria-controls="menu"><svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>');
  const rows = liveRifles().sort((a, b) => a.name.localeCompare(b.name)).map((r) => {
    const t = rifleTotals(r.id);
    return `<a class="item" href="#/rifle/${r.id}"><div><b style="font-size:20px">${esc(r.name)}</b><small>${r.type === 'pistol' ? 'Pistol · ' : 'Rifle · '}${esc(calName(r.caliberId))}${r.barrel ? ' · ' + r.barrel + ' in' : ''}</small></div><div style="text-align:right"><div class="mono v">${t.barrel}</div><small>barrel rounds</small></div></a>`;
  }).join('');
  main(`<h1>Firearms</h1>${rows || `<div class="card muted">${S.rifles.length ? 'Every firearm is archived. Restore one from Archive in the menu.' : 'No firearms yet. Add one to start logging.'}</div>`}
    <button class="btn pri" data-act="new-rifle">+ Add New Firearm</button>
    <div class="muted">Stored on this device only. Use Export in Settings to back up.</div>`);
}

function rifleBlock(r) { // why a firearm cannot be deleted; '' = free to delete (no groups, no historical entries, no batches)
  const nG = S.groups.filter((g) => g.rifleId === r.id).length, nH = S.hist.filter((h) => h.rifleId === r.id).length, nB = S.batches.filter((b) => b.rifleId === r.id).length, bits = [];
  if (nG) bits.push(`${nG} group${nG === 1 ? '' : 's'}`);
  if (nH) bits.push(`${nH} historical entr${nH === 1 ? 'y' : 'ies'}`);
  if (nB) bits.push(`${nB} batch${nB === 1 ? '' : 'es'}`);
  return bits.length ? `Has data (${bits.join(', ')}). Archive it instead (menu > Archive).` : '';
}
async function setRifleArchived(rid, on) {
  const r = byId('rifles', rid); if (!r) return;
  if (on && !confirm(`Archive "${r.name}"? It leaves the main page, every firearm pick-list and the low-stock warnings, and opens view-only. Nothing is deleted. You can restore it any time.`)) return;
  await put('rifles', { ...r, archived: on }); toast(on ? 'Archived' : 'Restored'); render();
}
function viewArchive() {
  bar(back('#/', 'Firearms', true), 'Archive');
  const sorted = S.rifles.slice().sort((a, b) => a.name.localeCompare(b.name));
  const row = (r) => `<div class="card"><div class="row sb"><a href="#/rifle/${r.id}" style="color:inherit;flex:1"><b style="font-size:18px">${esc(r.name)}</b><div class="muted">${r.type === 'pistol' ? 'Pistol · ' : 'Rifle · '}${esc(calName(r.caliberId))} · ${S.groups.filter((g) => g.rifleId === r.id).length} groups</div></a>
    <button class="btn sm" data-act="${r.archived ? 'rifle-restore' : 'rifle-archive'}" data-id="${r.id}">${r.archived ? 'Restore' : 'Archive'}</button></div></div>`;
  const act1 = sorted.filter((r) => !r.archived), arc = sorted.filter((r) => r.archived);
  main(`<h1>Archive</h1>
    <div class="muted">Archiving hides a firearm from the main page, every firearm pick-list and the low-stock warnings. Its groups, sessions, batches and inventory history are never changed. An archived firearm opens view-only until you restore it.</div>
    <h2>Active</h2>${act1.length ? act1.map(row).join('') : '<div class="card muted">No active firearms.</div>'}
    <h2>Archived</h2>${arc.length ? arc.map(row).join('') : '<div class="card muted">Nothing archived.</div>'}`);
}
function rifleForm(r) {
  const hasGroups = !!r && S.groups.some((g) => g.rifleId === r.id);
  formDialog(r ? 'Edit firearm' : 'New firearm', [
    { k: 'name', label: 'Name / label', req: true },
    // required; can only be changed while the firearm has no logged groups (a legacy record with no type is a rifle)
    { k: 'type', label: hasGroups ? 'Type (locked: this firearm has logged groups)' : 'Type', type: 'select', opts: [['rifle', 'Rifle'], ['pistol', 'Pistol']], disabled: hasGroups },
    { k: 'caliberId', label: 'Caliber (add calibers in Settings)', type: 'select', opts: calOpts() },
    { k: 'barrel', label: 'Barrel length (in)', type: 'num' },
    { k: 'startRounds', label: 'Rounds already through barrel', type: 'num' }
  ], r ? { ...r, type: r.type === 'pistol' ? 'pistol' : 'rifle' } : { type: 'rifle' }, async (v) => {
    await put('rifles', { ...(r || { id: uid() }), name: v.name, type: hasGroups ? (r.type === 'pistol' ? 'pistol' : 'rifle') : (v.type === 'pistol' ? 'pistol' : 'rifle'), caliberId: v.caliberId, barrel: v.barrel, startRounds: v.startRounds ?? 0 });
  }, r ? async () => {
    const why = rifleBlock(r);
    if (why) { toast(why); return false; }
    if (!confirm(`Delete "${r.name}"? It has no groups. This cannot be undone.`)) return false;
    for (const s of sessionsOf(r.id)) await del('sessions', s.id); // only empty sessions can remain here
    await del('rifles', r.id);
    location.hash = '#/';
    return true;
  } : null);
}

const comboHref = (c) => `#/combo/${c.groups[0].rifleId}/${encodeURIComponent(c.key)}`;
// Pistol groups have no X/Y, so their card shows the manual group size (and its MOA) plus velocity stats instead of mean radius / ES.
function groupCardPistol(g, s, showSess, hl) {
  return `<a class="card ${g.issue === true ? 'flag' : g.include === false ? 'excl' : ''}${hl ? ' hl' : ''}" href="#/group/${g.id}">
    <div class="row sb"><b>${esc(nm('powders', g.powderId))} ${g.charge} gn</b><span class="row" style="gap:6px">${hl ? '<span class="tag g">from here</span>' : ''}${g.issue === true ? '<span class="tag r">Issue</span>' : g.include === false ? '<span class="tag a">Excluded</span>' : ''}${g.reference ? '<span class="tag g">Ref</span>' : ''}</span></div>
    <div class="muted">${showSess && sessOf(g) ? esc(sessionLabel(sessOf(g))) + ' · ' : ''}${esc(bl(g.bulletId))} · ${esc(nm('primers', g.primerId))} · COAL ${fin(g.coal) ? g.coal + '"' : '—'} · ${fin(g.distance) ? g.distance + ' yd' : 'no distance'} · RSC ${roundsSinceClean(g) ?? '—'}</div>
    <div style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px"><div><div class="lbl">Size</div><span class="mono v">${fmt(g.groupSize, 2)}</span></div><div><div class="lbl">MOA</div><span class="mono v">${fmt(moa(g.groupSize, g.distance), 2)}</span></div><div><div class="lbl">Vel</div><span class="mono v">${fin(s.vavg) ? Math.round(s.vavg) : '—'}</span></div><div><div class="lbl">SD</div><span class="mono v">${fmt(s.vsd, 1)}</span></div><div><div class="lbl">Shots</div><span class="mono v">${s.total}</span></div></div></a>`;
}
function groupCard(g, showSess, hl) {
  const s = gstats(g);
  if (isPistol(g.rifleId)) return groupCardPistol(g, s, showSess, hl);
  return `<a class="card ${g.issue === true ? 'flag' : g.include === false ? 'excl' : ''}${hl ? ' hl' : ''}" href="#/group/${g.id}">
    <div class="row sb"><b>${esc(nm('powders', g.powderId))} ${g.charge} gn</b><span class="row" style="gap:6px">${hl ? '<span class="tag g">from here</span>' : ''}${g.issue === true ? '<span class="tag r">Issue</span>' : g.include === false ? '<span class="tag a">Excluded</span>' : ''}${g.reference ? '<span class="tag g">Ref</span>' : ''}</span></div>
    <div class="muted">${showSess && sessOf(g) ? esc(sessionLabel(sessOf(g))) + ' · ' : ''}${esc(bl(g.bulletId))} · ${esc(nm('primers', g.primerId))} · ${g.jump} thou · ${fin(g.distance) ? g.distance + ' yd' : 'no distance'} · RSC ${roundsSinceClean(g) ?? '—'}</div>
    <div class="grid4"><div><div class="lbl">MR</div><span class="mono v">${fmt(s.mr)}</span></div><div><div class="lbl">MR MOA</div><span class="mono v">${fmt(moa(s.mr, g.distance), 2)}</span></div><div><div class="lbl">ES</div><span class="mono v">${fmt(s.es)}</span></div><div><div class="lbl">Shots</div><span class="mono v">${s.total}</span></div></div></a>`;
}
// Pistol load card: pooled velocity SD is the headline; group size is a simple average of the manual sizes (not a precision metric).
function comboRowPistol(c, best, rank) {
  const vp = velPool(c);
  return `<a class="card" href="${comboHref(c)}" ${best ? 'style="border:2px solid var(--accent-text)"' : ''}>
    <div class="row sb"><b>${esc(comboLabel(c))}</b><span class="row" style="gap:6px">${flagBadge(c)}</span>${rank ? `<span class="tag ${rank === 1 ? 'g' : ''}">${rank === 1 ? '#1 best' : '#' + rank}</span>` : ''}</div>
    <div class="grid4"><div><div class="lbl">Grp</div><span class="mono v">${c.nGroups}</span></div><div><div class="lbl">Shots</div><span class="mono v">${c.nShots}</span></div>
    <div><div class="lbl">Vel SD</div><span class="mono v">${fmt(vp.sd, 1)}</span></div><div><div class="lbl">Vel</div><span class="mono v">${fin(c.vel) ? Math.round(c.vel) : '—'}</span></div></div>
    <div class="muted">ES ${fmt(vp.es, 0)} fps (n=${vp.n} readings) · group size avg ${fmt(c.gsAvg, 2)}" / ${fmt(moa(c.gsAvg, c.distance), 2)} MOA (${c.gsN} of ${c.nGroups} groups)</div>
    ${c.nGroups >= 2 ? '' : '<div class="warn">Not enough data yet — needs 2+ groups</div>'}<div class="muted">Tap to see its groups →</div></a>`;
}
function comboRow(c, best, rank) {
  if (c.pistol) return comboRowPistol(c, best, rank);
  const ranked = c.nGroups >= 2;
  return `<a class="card" href="${comboHref(c)}" ${best ? 'style="border:2px solid var(--accent-text)"' : ''}>
    <div class="row sb"><b>${esc(comboLabel(c))}</b><span class="row" style="gap:6px">${flagBadge(c)}</span>${rank ? `<span class="tag ${rank === 1 ? 'g' : ''}">${rank === 1 ? '#1 best' : '#' + rank}</span>` : ''}</div>
    <div class="grid4"><div><div class="lbl">Grp</div><span class="mono v">${c.nGroups}</span></div><div><div class="lbl">Shots</div><span class="mono v">${c.nShots}</span></div>
    <div><div class="lbl">MR</div><span class="mono v">${fmt(c.mr)}</span></div><div><div class="lbl">Vel</div><span class="mono v">${fin(c.vel) ? Math.round(c.vel) : '—'}</span></div></div>
    <div class="muted">MR ${fmt(c.mrMoa, 2)} MOA · ES ${fmt(c.es)}" / ${fmt(c.esMoa, 2)} MOA (average of each group's calculated ES) · MR weighted by shots</div>
    ${ranked ? '' : '<div class="warn">Not enough data yet — needs 2+ groups</div>'}<div class="muted">Tap to see its groups →</div></a>`;
}

/* The Current Best Load pick for a firearm (moved here unchanged so the firearm page and the inventory low-stock check use the same one).
   Rifle: best pooled mean radius at the preferred distance, 2+ groups, never a load with an issue logged.
   Pistol: lowest pooled velocity SD, 2+ groups with readings, never a flagged load. */
function bestInfo(rid) {
  const gs = S.groups.filter((g) => g.rifleId === rid);
  const cs = combos(gs);
  const bd = bestDist();
  const qual = cs.filter((c) => Number(c.distance) === bd && c.nGroups >= 2 && c.mr !== null); // main screen ranks one distance (default 100 yd); other distances live on the Best page
  const best = qual.find((c) => !comboFlagged(c)); // a load with an issue logged is never the current best
  // Pistol: best load = lowest pooled velocity SD (same 2+ group gate; needs velocity readings). Not tied to the rifle distance setting.
  const pistol = isPistol(rid);
  const pcand = pistol ? cs.map((c) => ({ c, vp: velPool(c) })).filter(({ c, vp }) => c.nGroups >= 2 && vp.sd !== null).sort((a, b) => a.vp.sd - b.vp.sd) : [];
  const pb = pcand.find(({ c }) => !comboFlagged(c));
  return { cs, bd, qual, best, pistol, pcand, pb };
}
function viewRifle(rid) {
  const r = byId('rifles', rid);
  if (!r) return viewHome();
  const ar = !!r.archived;
  bar(back(ar ? '#/archive' : '#/', ar ? 'Archive' : 'Firearms', true), r.name, ar ? '' : `<button class="r" data-act="edit-rifle" data-id="${rid}">Edit</button>`);
  const { cs, bd, qual, best, pistol, pcand, pb } = bestInfo(rid); // the Current Best Load pick (shared with the inventory low-stock check)
  const t = rifleTotals(rid);
  const latest = latestSession(rid);
  const pHero = pb
    ? `<a class="hero" href="${comboHref(pb.c)}"><div class="lbl">Current best load · lowest velocity SD</div><div style="font-size:19px;font-weight:600">${esc(bl(pb.c.bulletId))} · ${esc(nm('powders', pb.c.powderId))}</div>
      <div class="mono">${pb.c.charge} gn · ${esc(nm('primers', pb.c.primerId))} · COAL ${pb.c.coal}" · ${pb.c.distance} yd</div>
      <div class="big mono">SD ${fmt(pb.vp.sd, 1)} fps</div><div class="mono">avg ${fin(pb.c.vel) ? Math.round(pb.c.vel) : '—'} fps · ES ${fmt(pb.vp.es, 0)} fps</div>
      ${pb.c.gsAvg !== null ? `<div class="mono">group avg ${fmt(pb.c.gsAvg, 2)}" · ${fmt(moa(pb.c.gsAvg, pb.c.distance), 2)} MOA</div>` : ''}<div style="opacity:.85;font-size:13px">Tap to see its groups →</div></a>`
    : `<div class="hero"><div class="lbl">Current best load · lowest velocity SD</div><div style="font-size:19px;font-weight:600">${pcand.length ? 'No unflagged load qualifies yet' : 'Not enough data yet'}</div><div>${pcand.length ? 'Every load with 2+ groups has an issue logged on it.' : 'Needs 2+ groups with the exact same Bullet + Powder + Charge + Primer + COAL + Distance, with velocity readings.'}</div></div>`;
  main(`${archBanner(rid)}<div class="muted">${pistol ? 'Pistol · ' : ''}${esc(calName(r.caliberId))}${r.barrel ? ' · ' + r.barrel + ' in barrel' : ''}</div>
    ${pistol ? pHero : best ? `<a class="hero" href="${comboHref(best)}"><div class="lbl">Current best load · ${bd} yd</div><div style="font-size:19px;font-weight:600">${esc(bl(best.bulletId))} · ${esc(nm('powders', best.powderId))}</div>
      <div class="mono">${best.charge} gn · ${esc(nm('primers', best.primerId))} · ${best.jump} thou jump</div>
      <div class="big mono">${fmt(best.mr)}"</div><div class="mono">MR ${fmt(best.mrMoa, 2)} MOA · ES ${fmt(best.esMoa, 2)} MOA</div><div style="opacity:.85;font-size:13px">Tap to see its groups →</div></a>`
      : `<div class="hero"><div class="lbl">Current best load · ${bd} yd</div><div style="font-size:19px;font-weight:600">${qual.length ? 'No unflagged load qualifies yet' : 'Not enough data yet'}</div><div>${qual.length ? `Every load with 2+ groups at ${bd} yd has an issue logged on it.` : `Needs 2+ groups at the exact same Bullet + Powder + Charge + Primer + Jump at ${bd} yd. Other distances are on the Best Loads page.`}</div></div>`}
    ${lowLine(rid)}
    <div class="grid2"><div class="card"><div class="lbl">Shots logged</div><div class="mono v" style="font-size:30px">${t.shots}</div></div>
    <div class="card"><div class="lbl">Barrel total</div><div class="mono v" style="font-size:30px">${t.barrel}</div><div class="muted">${t.start} start + ${t.shots} logged + ${t.fouling} fouling</div></div></div>
    ${latest ? `<a class="card" href="#/session/${latest.id}"><div class="lbl">Current session · tap to open</div><div class="row sb"><b>${esc(sessionLabel(latest))}</b><span class="mono">${fin(latest.fouling) ? latest.fouling : 0} fouling · ${groupsOf(latest.id).length} grp</span></div></a>` : ''}
    ${ar ? '' : `${latest ? `<a class="btn dark" href="#/add/${rid}">+ Add New Group</a>` : ''}
    <button class="btn ${latest ? '' : 'dark'}" data-act="new-session" data-id="${rid}">+ Start New Session</button>`}
    ${pistol ? '' : `<a class="btn" href="#/best/${rid}">Best Loads by Distance</a>
    <a class="btn" href="#/load/${rid}">Load Analysis</a>`}
    <a class="btn" href="#/sessions/${rid}">View Session Data</a>
    <a class="btn" href="#/all/${rid}">View All Data</a>
    <a class="btn" href="#/issues/${rid}">Excluded &amp; Flagged</a>
    ${ar ? '' : `<button class="btn sm" data-act="set-case" data-id="${rid}">Set case for groups without one</button>`}`);
}

function viewAll(rid) {
  const r = byId('rifles', rid);
  if (!r) return viewHome();
  if (F.rid !== rid) F = { rid, powder: '', bullet: '', primer: '', charge: '', jump: '', coal: '', distance: '' };
  const pistol = isPistol(rid);
  bar(back('#/rifle/' + rid, 'Firearm', true), 'All Data', '', rid);
  const all = S.groups.filter((g) => g.rifleId === rid);
  const gs = all.filter((g) => (!F.powder || g.powderId === F.powder) && (!F.bullet || g.bulletId === F.bullet) && (!F.primer || g.primerId === F.primer) &&
    (!F.charge || String(Number(g.charge)) === F.charge) && (!F.jump || String(Number(g.jump)) === F.jump) && (!F.coal || String(Number(g.coal)) === F.coal) && (!F.distance || String(Number(g.distance)) === F.distance));
  const used = (k, s) => S[s].filter((x) => all.some((g) => g[k] === x.id));
  const dist = (k) => [...new Set(all.map((g) => String(Number(g[k]))))].sort((a, b) => a - b);
  const sel = (key, label, inner) => `<div class="f"><label class="lbl" for="F-${key}">${label}</label><select class="in" style="min-height:48px;font-size:16px" id="F-${key}" data-filter="${key}">${inner}</select></div>`;
  const filtering = !!(F.powder || F.bullet || F.primer || F.charge || F.jump || F.coal || F.distance);
  const list = sessionsOf(rid).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts).map((se) => {
    const mine = gs.filter((g) => g.sessionId === se.id).sort((a, b) => a.ts - b.ts);
    if (filtering && !mine.length) return '';
    return `<div class="row sb" style="margin-top:6px"><div><b>${esc(sessionLabel(se))}</b><div class="muted">${fin(se.fouling) ? se.fouling : 0} fouling${fin(se.temp) ? ' · ' + se.temp + ' F' : ''}${se.wind ? ' · ' + esc(se.wind) : ''}</div></div>
      ${r.archived ? '' : `<button class="btn sm" data-act="edit-session" data-id="${se.id}">Edit session</button>`}</div>
      ${mine.length ? mine.map((g) => groupCard(g)).join('') : '<div class="card muted">No groups in this session yet.</div>'}`;
  }).join('');
  const cs = combos(gs);
  const hist = S.hist.filter((h) => h.rifleId === rid);
  const hmap = new Map();
  for (const h of hist) { const k = [h.bulletId, h.powderId, h.charge].join('|'); if (!hmap.has(k)) hmap.set(k, []); hmap.get(k).push(h); }
  main(`${archBanner(rid)}<div class="grid2">
    ${sel('powder', 'Powder', opts(used('powderId', 'powders'), F.powder, (x) => x.name, 'All'))}
    ${sel('bullet', 'Bullet', opts(used('bulletId', 'bullets'), F.bullet, (x) => x.name + (fin(x.weight) ? ' ' + x.weight : ''), 'All'))}
    ${sel('primer', 'Primer', opts(used('primerId', 'primers'), F.primer, (x) => x.name, 'All'))}
    ${sel('charge', 'Charge', '<option value="">All</option>' + dist('charge').map((c) => `<option${c === F.charge ? ' selected' : ''}>${c}</option>`).join(''))}
    ${pistol ? sel('coal', 'COAL (in)', '<option value="">All</option>' + dist('coal').map((c) => `<option${c === F.coal ? ' selected' : ''}>${c}</option>`).join(''))
      : sel('jump', 'Jump', '<option value="">All</option>' + dist('jump').map((c) => `<option${c === F.jump ? ' selected' : ''}>${c}</option>`).join(''))}
    ${sel('distance', 'Distance (yd)', '<option value="">All</option>' + dist('distance').map((c) => `<option${c === F.distance ? ' selected' : ''}>${c}</option>`).join(''))}</div>
    <div class="muted">${gs.length} of ${all.length} groups shown · by session, newest first</div>
    ${list || '<div class="card muted">No groups match.</div>'}
    ${cs.length ? `<h2>Pooled combos (filtered)</h2>${cs.map((c) => comboRow(c, false)).join('')}` : ''}
    ${pistol ? '' : `<h2>Historical · manual ES only</h2>
    <div class="muted">Pre-existing data without X/Y. Kept separate — never mixed into mean-radius stats.</div>
    ${[...hmap.values()].map((arr) => { const es = arr.filter((h) => fin(h.es)); const avg = es.length ? es.reduce((a, h) => a + h.es, 0) / es.length : null;
      return `<div class="card"><b>${esc(bl(arr[0].bulletId))} · ${esc(nm('powders', arr[0].powderId))} ${arr[0].charge} gn</b><div class="kv"><span>Reference avg ES (${es.length} entr${es.length === 1 ? 'y' : 'ies'})</span><b>${fmt(avg)}"</b></div>
      ${arr.map((h) => `<div class="row sb muted"><span>${esc(h.note || '—')} · ES ${fmt(h.es)}</span>${r.archived ? '' : `<button class="btn sm" data-act="edit-hist" data-id="${h.id}">Edit</button>`}</div>`).join('')}</div>`; }).join('')}
    ${r.archived ? '' : `<button class="btn" data-act="new-hist" data-id="${rid}">+ Add historical entry</button>`}`}`);
}

const newest = (a, b) => b.date.localeCompare(a.date) || b.ts - a.ts;
const sessMeta = (se) => `${fin(se.fouling) ? se.fouling : 0} fouling${fin(se.temp) ? ' · ' + se.temp + ' F' : ''}${se.wind ? ' · ' + esc(se.wind) : ''}`;

function viewSessions(rid) {
  const r = byId('rifles', rid);
  if (!r) return viewHome();
  bar(back('#/rifle/' + rid, 'Firearm', true), 'Sessions', '', rid);
  const list = sessionsOf(rid).sort(newest).map((se) => {
    const gs = groupsOf(se.id);
    return `<a class="card" href="#/session/${se.id}"><div class="row sb"><b>${esc(sessionLabel(se))}</b><span class="mono">${gs.length} grp · ${gs.reduce((a, g) => a + g.shots.length, 0)} shots</span></div><div class="muted">${sessMeta(se)}</div></a>`;
  }).join('');
  main(`${archBanner(rid)}<h1>Sessions</h1>${list || '<div class="card muted">No sessions yet.</div>'}
    ${r.archived ? '' : `<button class="btn dark" data-act="new-session" data-id="${rid}">+ Start New Session</button>`}`);
}

function viewSession(sid, hlId) {
  const se = byId('sessions', sid);
  if (!se) return viewHome();
  const rid = se.rifleId, gs = groupsOf(sid);
  const shots = gs.reduce((a, g) => a + g.shots.length, 0);
  bar(back('#/sessions/' + rid, 'Sessions'), 'Session · ' + se.date, isArch(rid) ? '' : `<button class="r" data-act="edit-session" data-id="${sid}">Edit</button>`, rid);
  main(`${archBanner(rid)}<div><h1 style="font-size:24px">${esc(sessionLabel(se))}</h1><div class="muted">${sessMeta(se)}</div></div>
    <div class="grid3"><div class="card"><div class="lbl">Groups</div><span class="mono v">${gs.length}</span></div>
    <div class="card"><div class="lbl">Shots</div><span class="mono v">${shots}</span></div>
    <div class="card"><div class="lbl">Since clean</div><span class="mono v">${(fin(se.fouling) ? se.fouling : 0) + shots}</span></div></div>
    <div class="muted" style="margin-top:-6px">Since clean = rounds since clean at the end of this session (fouling shots + every shot fired).</div>
    ${isArch(rid) ? '' : `<a class="btn dark" href="#/add/${sid}">+ Add Group to this session</a>`}
    <h2>Groups · in the order fired</h2>
    ${gs.length ? gs.map((g) => groupCard(g, false, g.id === hlId)).join('') : '<div class="card muted">No groups in this session yet.</div>'}`);
}

function viewCombo(rid, key) {
  const r = byId('rifles', rid);
  const gs = S.groups.filter((g) => g.rifleId === rid && ckey(g) === key)
    .sort((a, b) => (sessOf(b) ? sessOf(b).date : '').localeCompare(sessOf(a) ? sessOf(a).date : '') || b.ts - a.ts);
  if (!r || !gs.length) return viewHome();
  bar(back('#/rifle/' + rid, 'Firearm'), 'Load', '', rid);
  const c = combos(gs)[0];
  const excl = gs.filter((g) => g.include === false).length;
  const pistol = isPistol(rid), vp = c && pistol ? velPool(c) : null;
  const cflags = c ? comboFlags(c) : flagsFor({ rifleId: rid, bulletId: gs[0].bulletId, powderId: gs[0].powderId, charge: gs[0].charge, primerId: gs[0].primerId, jump: gs[0].jump, coal: gs[0].coal });
  main(`<div><h1 style="font-size:22px">${esc(comboLabel(gs[0]))}</h1></div>
    ${cflags.length ? `<div class="card flagbox"><div class="lbl" style="color:inherit">Issue on this load · do not load</div>${cflags.map(flagLine).join('')}</div>` : ''}
    ${pistol && c ? `<div class="hero"><div class="grid2"><div><div class="lbl">Pooled velocity SD</div><div class="big mono">${fmt(vp.sd, 1)}</div><div class="mono">fps · n=${vp.n} readings</div></div>
      <div><div class="lbl">Velocity ES</div><div class="big mono">${fmt(vp.es, 0)}</div><div class="mono">fps · avg ${fin(c.vel) ? Math.round(c.vel) : '—'}</div></div></div>
      <div>${c.nGroups} group${c.nGroups === 1 ? '' : 's'} · ${c.nShots} shots</div>
      <div class="mono">Group size avg ${fmt(c.gsAvg, 2)}" · ${fmt(moa(c.gsAvg, c.distance), 2)} MOA · ${c.gsN} of ${c.nGroups} groups had a size</div>
      ${c.nGroups < 2 ? '<div style="font-weight:600">Not enough data yet — needs 2+ groups to rank</div>' : ''}</div>
      <div class="muted">Velocity SD and ES pool every shot that has a reading across the groups (Include = Y only). Group size is a simple average of the manual sizes at this distance, not a precision metric.${excl ? ` ${excl} excluded group${excl === 1 ? ' is' : 's are'} shown dimmed below.` : ''}</div>`
    : c ? `<div class="hero"><div class="grid2"><div><div class="lbl">Pooled mean radius</div><div class="big mono">${fmt(c.mr)}"</div><div class="mono">${fmt(c.mrMoa, 2)} MOA</div></div>
      <div><div class="lbl">Avg ES</div><div class="big mono">${fmt(c.es)}"</div><div class="mono">${fmt(c.esMoa, 2)} MOA</div></div></div>
      <div>${c.nGroups} group${c.nGroups === 1 ? '' : 's'} · ${c.nShots} shots · avg velocity ${fin(c.vel) ? Math.round(c.vel) : '—'} fps</div>
      ${c.nGroups < 2 ? '<div style="font-weight:600">Not enough data yet — needs 2+ groups to rank</div>' : ''}</div>`
      : '<div class="card warn">Every group of this load is excluded from analysis, so there are no pooled stats.</div>'}
    ${pistol ? '' : `<div class="muted">Pooled mean radius is weighted by shots and counts only groups with Include = Y. ES is the average of each group's calculated ES.${excl ? ` ${excl} excluded group${excl === 1 ? ' is' : 's are'} shown dimmed below.` : ''}</div>`}
    <h2>All groups with this load</h2>
    ${gs.map((g) => groupCard(g, true)).join('')}`);
}

// Best loads, one section per distance. A load needs 2+ groups (same bullet, powder, charge, primer, jump, distance) to be ranked.
let showThin = false; // Best page: off by default, so only ranked loads show
function viewBest(rid) {
  const r = byId('rifles', rid);
  if (!r) return viewHome();
  if (isPistol(rid)) { navTo('#/rifle/' + rid, true); return; } // rifle-only page (ranks by mean radius)
  bar(back('#/rifle/' + rid, 'Firearm', true), 'Best by Distance', '', rid);
  const cs = combos(S.groups.filter((g) => g.rifleId === rid));
  const dists = [...new Set(cs.map((c) => Number(c.distance)))].sort((a, b) => a - b);
  const sections = dists.map((d) => {
    const at = cs.filter((c) => Number(c.distance) === d);
    const ranked = at.filter((c) => c.nGroups >= 2 && c.mr !== null).sort((a, b) => a.mr - b.mr);
    const rest = at.filter((c) => !ranked.includes(c));
    return `<h2>${fin(d) ? d + ' yd' : 'No distance set'}</h2>
      ${(() => { let k = 0; return ranked.map((c) => (comboFlagged(c) ? comboRow(c, false) : comboRow(c, k === 0, ++k))).join(''); })() /* flagged loads are listed with the badge but never ranked or called best */ || `<div class="card muted">No load has 2+ groups at this distance yet.${rest.length && !showThin ? ` (${rest.length} with 1 group — use the toggle above to see ${rest.length === 1 ? 'it' : 'them'}.)` : ''}</div>`}
      ${showThin && rest.length ? `<div class="muted">Not enough data yet (needs 2+ groups):</div>${rest.map((c) => comboRow(c, false)).join('')}` : ''}`;
  }).join('');
  main(`<h1>Best Loads</h1><div class="muted">Ranked by pooled mean radius within each distance, since the best load at 100 yd may not be best at 300. Include = N groups are left out.</div>
    <label class="row" style="min-height:44px;font-weight:600"><input type="checkbox" id="best-thin" style="width:24px;height:24px"${showThin ? ' checked' : ''}> Show loads with only 1 group (not ranked)</label>
    ${sections || '<div class="card muted">No groups logged yet.</div>'}`);
}

/* ---------- Load Analysis: pick a bullet + powder, see the best load at every tested distance ----------
   Pure view on top of combos() (same six-field rule: bullet, powder, charge, primer, jump, distance; Include = N left out; 2+ groups to rank).
   Only new math: velocity SD / ES pooled from the shot-level velocities of a combo (velPool). Selections live in memory only. */
let LA = { rid: null, bullet: '', powder: '', powderB: '', sort: 'mr', thin: false, ladderThin: false, compare: false };
function velPool(c) {
  const v = [];
  for (const g of c.groups) for (const s of g.shots) if (fin(s.v)) v.push(s.v);
  const n = v.length;
  if (n < 2) return { n, sd: null, es: null };
  const mean = v.reduce((a, x) => a + x, 0) / n;
  return { n, sd: Math.sqrt(v.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)), es: Math.max(...v) - Math.min(...v) };
}
const laSorts = { mr: (a, b) => (a.c.mr ?? 9e9) - (b.c.mr ?? 9e9), vsd: (a, b) => (a.vp.sd ?? 9e9) - (b.vp.sd ?? 9e9), ves: (a, b) => (a.vp.es ?? 9e9) - (b.vp.es ?? 9e9) };
const laItems = (cs) => cs.map((c) => ({ c, vp: velPool(c) }));

function laTable(items, bestId) {
  const th = (k, l) => `<th><button type="button" class="thb${LA.sort === k ? ' on' : ''}" data-act="la-sort" data-v="${k}">${l}${LA.sort === k ? ' ▲' : ''}</button></th>`;
  const rows = items.slice().sort(laSorts[LA.sort]).map(({ c, vp }) => `<tr data-act="go" data-href="${comboHref(c)}">
      <td><a href="${comboHref(c)}"><b>${c.charge}</b> gn${c === bestId ? ' <span class="tag g">best MR</span>' : ''}${comboFlagged(c) ? ' <span class="tag r">Issue</span>' : ''}</a><small>${esc(nm('primers', c.primerId))} · ${c.jump} thou</small></td>
      <td>${fmt(c.mr)}<small>n=${c.groups.reduce((a, g) => a + gstats(g).n, 0)} · ${fmt(c.mrMoa, 2)} MOA</small></td>
      <td>${fmt(vp.sd, 1)}<small>n=${vp.n}</small></td>
      <td>${fmt(vp.es, 0)}<small>n=${vp.n}</small></td>
      <td>${c.nGroups}<small>${c.nShots} shots</small></td></tr>`).join('');
  return `<table class="la"><thead><tr><th>Charge</th>${th('mr', 'MR in')}${th('vsd', 'Vel SD')}${th('ves', 'Vel ES')}<th>Grp</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function ladderChart(series, key, title, digits) {
  const pts = series.flatMap((s) => s.pts.filter((p) => fin(p[key])));
  const charges = [...new Set(pts.map((p) => p.x))].sort((a, b) => a - b);
  if (!pts.length || charges.length < 2) return '';
  const ys = pts.map((p) => p[key]);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y0 === y1) { const d = Math.abs(y0) * 0.05 || 1; y0 -= d; y1 += d; }
  const pad = (y1 - y0) * 0.15; y0 -= pad; y1 += pad;
  const x0 = charges[0], x1 = charges[charges.length - 1];
  const W = 340, H = 150, L = 46, R = 10, T = 10, B = 26;
  const X = (x) => L + (x - x0) / (x1 - x0) * (W - L - R), Y = (y) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  const lab = (v) => (digits ? v.toFixed(digits) : String(Math.round(v)));
  const txt = 'font-size="11" style="fill:var(--mute)"';
  const step = Math.ceil(charges.length / 7);
  const cols = ['var(--accent-text)', 'var(--amber)', 'var(--red)', 'var(--mute)'];
  return `<div class="lbl" style="margin-top:8px">${title}</div>
    <svg viewBox="0 0 ${W} ${H}" class="plot" role="img" aria-label="${esc(title)} by charge weight">
    ${[y0 + pad, (y0 + y1) / 2, y1 - pad].map((v) => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" style="stroke:var(--line)"/><text x="${L - 4}" y="${Y(v) + 4}" text-anchor="end" ${txt}>${lab(v)}</text>`).join('')}
    ${charges.map((c, i) => (i % step ? '' : `<text x="${X(c)}" y="${H - 8}" text-anchor="middle" ${txt}>${c}</text>`)).join('')}
    ${series.map((s, si) => {
      const col = cols[si % cols.length];
      const good = s.pts.filter((p) => fin(p[key]) && p.proven).sort((a, b) => a.x - b.x);
      return `${good.length > 1 ? `<polyline fill="none" style="stroke:${col}" stroke-width="2" points="${good.map((p) => X(p.x) + ',' + Y(p[key])).join(' ')}"/>` : ''}
        ${s.pts.filter((p) => fin(p[key])).map((p) => `<circle cx="${X(p.x)}" cy="${Y(p[key])}" r="5" stroke-width="2" style="stroke:${col};fill:${p.proven ? col : 'var(--field)'}"/>`).join('')}`;
    }).join('')}</svg>`;
}

function laLadder(items) {
  const map = new Map();
  for (const { c, vp } of items) {
    const k = c.primerId + '|' + c.jump;
    if (!map.has(k)) map.set(k, { label: `${nm('primers', c.primerId)} · ${c.jump} thou`, pts: [] });
    map.get(k).pts.push({ x: Number(c.charge), mr: c.mr, vel: c.vel, proven: c.nGroups >= 2 });
  }
  const series = [...map.values()];
  const a = ladderChart(series, 'mr', 'Mean radius (in) by charge', 3), b = ladderChart(series, 'vel', 'Average velocity (fps) by charge', 0);
  if (!a && !b) return '<div class="muted">Charge ladder needs 2+ different charges.</div>';
  return `${a}${b}${series.length > 1 ? `<div class="muted">${series.map((s, i) => `<span style="color:${['var(--accent-text)', 'var(--amber)', 'var(--red)', 'var(--mute)'][i % 4]}">●</span> ${esc(s.label)}`).join(' &nbsp; ')}</div>` : ''}
    <div class="muted">Filled = 2+ groups. Hollow = single group (unproven).</div>`;
}

function laPanel(title, items, d) {
  const ranked = items.filter(({ c }) => c.nGroups >= 2 && c.mr !== null).sort(laSorts.mr);
  const best = ranked.find(({ c }) => !comboFlagged(c)); // a flagged load is never "best"
  if (best) {
    const { c, vp } = best;
    return `<div class="card"><b>${esc(title)}</b>
      <div class="mono v">${c.charge} gn</div><div class="muted">${esc(nm('primers', c.primerId))} · ${c.jump} thou</div>
      <div class="kv"><span>MR</span><b>${fmt(c.mr)}</b></div><div class="muted" style="text-align:right">n=${c.groups.reduce((a, g) => a + gstats(g).n, 0)} · ${fmt(c.mrMoa, 2)} MOA</div>
      <div class="kv"><span>Vel SD</span><b>${fmt(vp.sd, 1)}</b></div><div class="kv"><span>Vel ES</span><b>${fmt(vp.es, 0)}</b></div><div class="muted" style="text-align:right">n=${vp.n} shots with velocity</div>
      <div class="kv"><span>Groups</span><b>${c.nGroups}</b></div><div class="muted" style="text-align:right">${c.nShots} shots</div>
      <a class="btn sm" href="${comboHref(c)}">See groups</a></div>`;
  }
  return `<div class="card"><b>${esc(title)}</b><div class="warn">${ranked.length ? 'No unflagged load qualifies yet' : 'Not enough data yet'}</div>
    ${items.length ? items.map(({ c }) => `<div class="muted">${c.charge} gn · ${esc(nm('primers', c.primerId))} · ${c.jump} thou — MR ${fmt(c.mr)} (${c.nGroups} group, ${c.nShots} shots)${comboFlagged(c) ? ' <span class="tag r">Issue</span>' : ''}</div>`).join('') : '<div class="muted">No groups at this distance.</div>'}</div>`;
}

function viewLoad(rid) {
  const r = byId('rifles', rid);
  if (!r) return viewHome();
  if (LA.rid !== rid) LA = { rid, bullet: '', powder: '', powderB: '', sort: 'mr', thin: false, ladderThin: false, compare: false };
  if (isPistol(rid)) { navTo('#/rifle/' + rid, true); return; } // rifle-only page (ranks by mean radius)
  bar(back('#/rifle/' + rid, 'Firearm', true), 'Load Analysis', '', rid);
  const all = S.groups.filter((g) => g.rifleId === rid);
  const usedIds = (k) => new Set(all.map((g) => g[k]));
  const bullets = S.bullets.filter((b) => usedIds('bulletId').has(b.id)), powders = S.powders.filter((p) => usedIds('powderId').has(p.id));
  const inSel = (g, pw) => (!LA.bullet || g.bulletId === LA.bullet) && (!pw || g.powderId === pw);
  const sel = (id, label, list, val, any) => `<div class="f"><label class="lbl" for="${id}">${label}</label><select class="in" style="min-height:48px;font-size:16px" id="${id}">${opts(list, val, (x) => x.name + (fin(x.weight) ? ' ' + x.weight + ' gn' : ''), any)}</select></div>`;
  const controls = `<div class="grid2">${sel('la-bullet', 'Bullet', bullets, LA.bullet, 'Any')}${sel('la-powder', LA.compare ? 'Powder A' : 'Powder', powders, LA.powder, 'Any')}</div>
    ${LA.compare ? sel('la-powderB', 'Powder B', powders, LA.powderB, 'Pick a powder') : ''}
    <label class="row" style="min-height:44px;font-weight:600"><input type="checkbox" id="la-compare" style="width:24px;height:24px"${LA.compare ? ' checked' : ''}> Compare powders</label>`;

  if (LA.compare) {
    let body;
    if (!LA.bullet) body = '<div class="card muted">Pick a bullet to compare powders.</div>';
    else if (!LA.powder || !LA.powderB) body = '<div class="card muted">Pick Powder A and Powder B.</div>';
    else if (LA.powder === LA.powderB) body = '<div class="card muted">Pick two different powders.</div>';
    else {
      const cA = laItems(combos(all.filter((g) => inSel(g, LA.powder)))), cB = laItems(combos(all.filter((g) => inSel(g, LA.powderB))));
      const dists = [...new Set([...cA, ...cB].map(({ c }) => Number(c.distance)))].sort((a, b) => a - b);
      body = dists.map((d) => `<h2>${d} yd</h2><div class="grid2">${laPanel(nm('powders', LA.powder), cA.filter(({ c }) => Number(c.distance) === d), d)}${laPanel(nm('powders', LA.powderB), cB.filter(({ c }) => Number(c.distance) === d), d)}</div>`).join('')
        || '<div class="card muted">Not enough data yet.</div>';
    }
    main(`<h1>Load Analysis</h1>${controls}<div class="muted">Each powder's best load (lowest pooled mean radius, 2+ groups) at each tested distance.</div>${body}`);
    return;
  }

  const cs = laItems(combos(all.filter((g) => inSel(g, LA.powder))));
  const dists = [...new Set(cs.map(({ c }) => Number(c.distance)))].sort((a, b) => a - b);
  const ladderOn = !!(LA.bullet && LA.powder);
  const sections = dists.map((d) => {
    const at = cs.filter(({ c }) => Number(c.distance) === d);
    const ranked = at.filter(({ c }) => c.nGroups >= 2 && c.mr !== null), thin = at.filter((x) => !ranked.includes(x));
    const bestC = ranked.slice().sort(laSorts.mr).find(({ c }) => !comboFlagged(c));
    return `<h2>${d} yd</h2>
      ${ranked.length ? laTable(ranked, bestC && bestC.c) : `<div class="card muted">Not enough data yet.${thin.length ? ` (${thin.length} load${thin.length === 1 ? '' : 's'} with 1 group below.)` : ''}</div>`}
      ${thin.length ? `<details class="unproven"><summary>Unproven (1 group) · ${thin.length}</summary>${laTable(thin, null)}</details>` : ''}
      ${ladderOn ? laLadder(at.filter((x) => LA.ladderThin || x.c.nGroups >= 2)) : ''}`;
  }).join('');
  main(`<h1>Load Analysis</h1>${controls}
    ${ladderOn ? `<label class="row" style="min-height:44px;font-weight:600"><input type="checkbox" id="la-ladderthin" style="width:24px;height:24px"${LA.ladderThin ? ' checked' : ''}> Include single-group points in the ladder</label>` : '<div class="muted">Pick both a bullet and a powder to see the charge ladder.</div>'}
    <div class="muted">Best load at each tested distance. Ranked by pooled mean radius; tap Vel SD or Vel ES to re-sort. Metrics are never blended. Include = N groups are left out.</div>
    ${sections || '<div class="card muted">Not enough data yet.</div>'}`);
}

/* ---------- Excluded & Flagged page (per firearm) ---------- */
let IS = { rid: null, tab: 'flag', bullet: '', min: '', max: '', cat: '' };
function viewIssues(rid) {
  const r = byId('rifles', rid);
  if (!r) return viewHome();
  if (IS.rid !== rid) IS = { rid, tab: 'flag', bullet: '', min: '', max: '', cat: '' };
  bar(back('#/rifle/' + rid, 'Firearm', true), 'Excluded & Flagged', '', rid);
  const mine = S.groups.filter((g) => g.rifleId === rid);
  const flagged = mine.filter((g) => g.issue === true), excluded = mine.filter((g) => g.include === false && g.issue !== true);
  const isFlag = IS.tab === 'flag', base = isFlag ? flagged : excluded;
  const lo = num(IS.min), hi = num(IS.max);
  const rows = base.filter((g) => (!IS.bullet || g.bulletId === IS.bullet) && (lo === null || Number(g.charge) >= lo) && (hi === null || Number(g.charge) <= hi) && (!isFlag || !IS.cat || g.issueCategory === IS.cat))
    .sort((a, b) => Number(b.charge) - Number(a.charge) || gdate(b).localeCompare(gdate(a))); // charge descending
  const pistol = isPistol(rid);
  const bulletOpts = S.bullets.filter((b) => mine.some((g) => g.bulletId === b.id));
  const card = (g) => `<a class="card ${isFlag ? 'flag' : 'excl'}" href="#/group/${g.id}">
    <div class="row sb"><b>${g.charge} gn · ${esc(nm('powders', g.powderId))}</b>${isFlag ? '<span class="tag r">Issue</span>' : '<span class="tag a">Excluded</span>'}</div>
    <div class="muted">${esc(gdate(g))} · ${esc(bl(g.bulletId))} · ${esc(nm('primers', g.primerId))} · ${pistol ? 'COAL ' + (fin(g.coal) ? g.coal + '"' : '—') : g.jump + ' thou'}</div>
    ${isFlag ? `<div><b>${esc(g.issueCategory || 'No category')}</b> — applies to ${SCOPE_TEXT[g.issueScope || 'exact']}</div>${g.issueNote ? `<div>${esc(g.issueNote)}</div>` : ''}`
      : (g.notes ? `<div>${esc(g.notes)}</div>` : '<div class="muted">No note.</div>')}</a>`;
  const empty = !base.length ? (isFlag ? 'No issues logged for this firearm.' : 'No excluded groups for this firearm.') : 'No groups match these filters.';
  main(`<h1>Excluded &amp; Flagged</h1>
    <div class="grid2"><button class="btn ${isFlag ? 'pri' : ''}" data-act="is-tab" data-v="flag" aria-pressed="${isFlag}">Flagged (${flagged.length})</button>
    <button class="btn ${isFlag ? '' : 'pri'}" data-act="is-tab" data-v="excl" aria-pressed="${!isFlag}">Excluded (${excluded.length})</button></div>
    <div class="muted">${isFlag ? 'Groups with an issue logged. They are always excluded from the pooled numbers.' : 'Groups set to Include = N without an issue flag.'}</div>
    <div class="grid2">
      <div class="f"><label class="lbl" for="is-bullet">Bullet</label><select class="in" style="min-height:48px;font-size:16px" id="is-bullet">${opts(bulletOpts, IS.bullet, (x) => x.name + (fin(x.weight) ? ' ' + x.weight + ' gn' : ''), 'Any')}</select></div>
      ${isFlag ? `<div class="f"><label class="lbl" for="is-cat">Category</label><select class="in" style="min-height:48px;font-size:16px" id="is-cat"><option value="">Any</option>${ISSUE_CATS.map((c) => `<option${c === IS.cat ? ' selected' : ''}>${c}</option>`).join('')}</select></div>` : '<div></div>'}
      <div class="f"><label class="lbl" for="is-min">Charge min (gn)</label><input class="in m" style="min-height:48px;font-size:16px" id="is-min" inputmode="decimal" value="${esc(IS.min)}"></div>
      <div class="f"><label class="lbl" for="is-max">Charge max (gn)</label><input class="in m" style="min-height:48px;font-size:16px" id="is-max" inputmode="decimal" value="${esc(IS.max)}"></div></div>
    <div class="muted">${rows.length} shown · sorted by charge, highest first</div>
    ${rows.length ? rows.map(card).join('') : `<div class="card muted">${empty}</div>`}`);
}

/* ---------- Tools ---------- */
let LC = { rid: '', bullet: '', powder: '', charge: '', primer: '', jump: '' };
function lcResult() {
  if (!LC.rid) return '<div class="muted">Add a firearm first.</div>';
  if (!LC.bullet || !LC.powder) return '<div class="muted">Pick a bullet and a powder.</div>';
  const ch = num(LC.charge);
  if (ch === null) return '<div class="muted">Enter a charge weight.</div>';
  const pistol = isPistol(LC.rid), x = num(LC.jump);
  const fl = flagsFor({ rifleId: LC.rid, bulletId: LC.bullet, powderId: LC.powder, charge: ch, primerId: LC.primer, jump: pistol ? null : x, coal: pistol ? x : null });
  return fl.length
    ? `<div class="card flagbox"><div class="lbl" style="color:inherit">Issue logged on this load · do not load</div>${fl.map(flagLine).join('')}</div>`
    : `<div class="card okbox"><b>Clear</b><div>No issue is logged for this bullet and powder at ${ch} gn on this firearm.</div><div class="muted" style="color:inherit">This only checks the issues you have logged in this app. It does not prove a load is safe. Always follow published load data.</div></div>`;
}
function viewLoadCheck() {
  bar(back('#/tools', 'Tools', true), 'Load check');
  if (!byId('rifles', LC.rid) || isArch(LC.rid)) LC.rid = (liveRifles()[0] || {}).id || '';
  const pistol = isPistol(LC.rid);
  main(`<h1>Load check</h1>
    <div class="muted">Before you build a load: does it match an issue you logged on this firearm? Leave primer or ${pistol ? 'COAL' : 'jump'} blank to match any.</div>
    <div class="f"><label class="lbl" for="lc-rid">Firearm</label><select class="in" id="lc-rid">${opts(liveRifles(), LC.rid, (x) => x.name)}</select></div>
    <div class="f"><label class="lbl" for="lc-bullet">Bullet</label><select class="in" id="lc-bullet">${opts(act(S.bullets), LC.bullet, (x) => x.name + (fin(x.weight) ? ' ' + x.weight + ' gn' : ''), '— pick a bullet —')}</select></div>
    <div class="f"><label class="lbl" for="lc-powder">Powder</label><select class="in" id="lc-powder">${opts(act(S.powders), LC.powder, (x) => x.name, '— pick a powder —')}</select></div>
    <div class="grid2"><div class="f"><label class="lbl" for="lc-charge">Charge (gn)</label><input class="in m" id="lc-charge" inputmode="decimal" value="${esc(LC.charge)}"></div>
    <div class="f"><label class="lbl" for="lc-jump">${pistol ? 'COAL (in) · optional' : 'Jump (thou) · optional'}</label><input class="in m" id="lc-jump" inputmode="decimal" value="${esc(LC.jump)}"></div></div>
    <div class="f"><label class="lbl" for="lc-primer">Primer · optional</label><select class="in" id="lc-primer">${opts(act(S.primers), LC.primer, (x) => x.name, 'Any primer')}</select></div>
    <div id="lc-out">${lcResult()}</div>`);
}
/* ---------- Components inventory (informational only: never feeds pooling, ranking, best load, issue flags, cost or any statistic) ----------
   One event ledger per library item. On hand = the sum of its events (Starting count +, Purchase +, Used -, Recount +/-).
   Powder is kept in grains and shown in lb or kg. Nothing is clamped: a negative balance is shown in red.
   Batches create Used events. Consolidating turns each item's history into one new Starting count. */
const INV = {
  bullet: { store: 'bullets', title: 'Projectiles', unit: 'units', one: 'Projectile' },
  powder: { store: 'powders', title: 'Powders', unit: 'grains', one: 'Powder' },
  primer: { store: 'primers', title: 'Primers', unit: 'units', one: 'Primer' },
  case: { store: 'cases', title: 'Unused cases', unit: 'virgin brass', one: 'Case' }
};
const INV_TYPES = { start: 'Starting count', purchase: 'Purchase', used: 'Used', recount: 'Recount' };
const evOf = (kind, id) => S.ledger.filter((e) => e.kind === kind && e.itemId === id);
const onHand = (kind, id) => Math.round(evOf(kind, id).reduce((a, e) => a + e.qty, 0) * 100) / 100;
const isTracked = (kind, id) => S.ledger.some((e) => e.kind === kind && e.itemId === id);
const toGrains = (q, unit) => Math.round((unit === 'lb' ? q * GR_PER_LB : unit === 'kg' ? q * GR_PER_KG : q) * 100) / 100;
const num0 = (n) => (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
function qtyText(kind, item, n, signed) { // powder: lb or kg (the item's unit) with the grains beside it
  const sign = n < 0 ? '−' : signed && n > 0 ? '+' : '', a = Math.abs(n);
  if (kind !== 'powder') return sign + num0(a);
  const kg = !!item && item.unit === 'kg';
  return `${sign}${(a / (kg ? GR_PER_KG : GR_PER_LB)).toFixed(3)} ${kg ? 'kg' : 'lb'} (${num0(a)} gr)`;
}
const invName = (kind, id) => { const it = byId(INV[kind].store, id); return it ? it.name + (kind === 'bullet' && fin(it.weight) ? ' ' + it.weight + ' gn' : '') : '?'; };
const invPrefs = () => S.prefs.find((p) => p.id === 'inv') || { id: 'inv', low: 200 };
const lowLimit = () => (fin(invPrefs().low) && invPrefs().low >= 0 ? invPrefs().low : 200);
// Low-stock check: for each firearm's Current Best Load (none yet = skipped), how many rounds can each tracked component still make?
// Brass is not checked. A negative balance is shown in red instead. Returns Map "kind|id" -> [{ rid, name, rounds }].
function lowStock() {
  const lim = lowLimit(), out = new Map();
  if (!(lim > 0)) return out;
  for (const r of liveRifles()) { // archived firearms are skipped
    const info = bestInfo(r.id), c = info.pistol ? (info.pb && info.pb.c) : info.best;
    if (!c) continue;
    for (const [kind, id, per] of [['bullet', c.bulletId, 1], ['primer', c.primerId, 1], ['powder', c.powderId, Number(c.charge)]]) {
      if (!isTracked(kind, id) || !(per > 0)) continue;
      const it = byId(INV[kind].store, id);
      if (it && it.archived) continue; // archived items are never flagged
      const have = onHand(kind, id);
      if (have < 0) continue;
      const rounds = Math.floor(have / per);
      if (rounds < lim) { const k = kind + '|' + id; if (!out.has(k)) out.set(k, []); out.get(k).push({ rid: r.id, name: r.name, rounds }); }
    }
  }
  return out;
}
const lowLineText = (l) => `Enough for ${l.rounds} round${l.rounds === 1 ? '' : 's'} of ${l.name}'s best load (limit ${lowLimit()})`;
function lowLine(rid) { // small yellow notice on the firearm page
  const rows = [];
  for (const [k, arr] of lowStock()) { const [kind, id] = k.split('|'); for (const l of arr) if (l.rid === rid) rows.push(`${INV[kind].one}: ${invName(kind, id)} — enough for ${l.rounds} round${l.rounds === 1 ? '' : 's'} (limit ${lowLimit()})`); }
  return rows.length ? `<a class="card excl" href="#/components"><div class="lbl">Running low · best load</div>${rows.map((t) => `<div>${esc(t)}</div>`).join('')}<div class="muted">Tap for Components</div></a>` : '';
}

/* Components page: the four libraries (bullets, powders, primers, cases), one list at a time. Each item's own page holds its specs and cost,
   its stock and history, and Archive / Delete. Archived items stay in the data (and on old groups) but leave every pick-list and the low-stock flags. */
let CM = { sec: 'bullet', q: '', cal: '', arch: false };
const CM_SECS = [['bullet', 'Bullets'], ['powder', 'Powders'], ['primer', 'Primers'], ['case', 'Cases']];
function cmSpec(kind, it) {
  if (kind === 'bullet') return [fin(it.weight) ? it.weight + ' gn' : '', it.style].filter(Boolean).join(' ');
  if (kind === 'primer') return it.type || '';
  if (kind === 'case') return (it.caliberIds || []).map((id) => calName(id)).filter(Boolean).join(', ');
  return '';
}
function cmCost(kind, it) { // computed cost per unit, with tax; '' when the price or quantity is missing
  const rate = 1 + taxPct() / 100;
  if (kind === 'powder') {
    if (!hasNum(it.price) || !(Number(it.pkg) > 0)) return '';
    return `$${((Number(it.price) + (hasNum(it.ship) ? Number(it.ship) : 0)) * rate / Number(it.pkg)).toFixed(2)}/${it.unit === 'kg' ? 'kg' : 'lb'}`;
  }
  const p = unitPre(kind, it);
  return p === null ? '' : `$${(p * rate).toFixed(4)}/${kind === 'case' ? 'firing' : 'each'}`;
}
function cmListHtml() {
  const kind = CM.sec, low = lowStock(), q = CM.q.trim().toLowerCase();
  const list = S[INV[kind].store].filter((it) => (CM.arch || !it.archived)
    && (!q || (it.name + ' ' + cmSpec(kind, it)).toLowerCase().includes(q))
    && (!CM.cal || kind === 'powder' || kind === 'primer' || (kind === 'bullet' ? it.caliberId === CM.cal : (it.caliberIds || []).includes(CM.cal))))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) return `<div class="card muted">${S[INV[kind].store].some((it) => CM.arch || !it.archived) ? 'Nothing matches.' : `No ${CM_SECS.find((s) => s[0] === kind)[1].toLowerCase()} yet. Tap + Add.`}</div>`;
  return list.map((it) => {
    const n = onHand(kind, it.id), neg = n < 0, lw = it.archived ? null : low.get(kind + '|' + it.id), tr = isTracked(kind, it.id);
    const sub = [cmSpec(kind, it), cmCost(kind, it)].filter(Boolean).join(' · ');
    return `<a class="card ${neg ? 'flag' : lw ? 'excl' : ''}" href="#/components/item/${kind}/${it.id}">
      <div class="row sb"><b>${esc(it.name)}${it.archived ? ' <span class="tag">Archived</span>' : ''}</b><span class="mono v" ${neg ? 'style="color:var(--red)"' : ''}>${tr ? qtyText(kind, it, n) : '—'}</span></div>
      <div class="muted">${sub ? esc(sub) : '&nbsp;'}</div>
      ${neg ? '<div class="muted"><b style="color:var(--red)">Below zero</b></div>' : tr ? '' : '<div class="muted">nothing entered yet</div>'}
      ${lw ? lw.map((l) => `<div class="warn">${esc(lowLineText(l))}</div>`).join('') : ''}</a>`;
  }).join('');
}
function viewComponents() {
  bar(back('#/', 'Firearms', true), 'Components');
  const kind = CM.sec, st = INV[kind].store, lim = lowLimit();
  const calFilter = kind === 'bullet' || kind === 'case';
  main(`<h1>Components</h1>
    <div class="grid2"><a class="btn pri" href="#/components/batch">Log loaded batch</a><a class="btn" href="#/components/history">History</a></div>
    <div class="segc" role="group" aria-label="Component type">${CM_SECS.map(([k, l]) => `<button type="button" data-act="cm-sec" data-v="${k}" aria-pressed="${k === kind}">${l}</button>`).join('')}</div>
    <div class="row" style="gap:8px"><input class="in" id="cm-q" type="search" placeholder="Search ${esc(CM_SECS.find((s) => s[0] === kind)[1].toLowerCase())}" value="${esc(CM.q)}" autocomplete="off" style="flex:1"><button class="btn sm pri" data-act="lib-new" data-s="${st}">+ Add</button></div>
    ${calFilter ? `<div class="f"><label class="lbl" for="cm-cal">Caliber</label><select class="in" id="cm-cal"><option value="">All calibers</option>${S.calibers.slice().sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<option value="${esc(c.id)}"${CM.cal === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>` : ''}
    <label class="row" style="min-height:44px"><input type="checkbox" id="cm-arch" style="width:24px;height:24px"${CM.arch ? ' checked' : ''}> Show archived</label>
    <div id="cm-list">${cmListHtml()}</div>
    <div class="muted">On hand is the sum of each item's events. Informational only: it never changes your stats, rankings or costs. Costs shown include tax. Warning limit: ${lim ? lim + ' rounds' : 'off'} (Settings).</div>
    <h2>Consolidate</h2>
    <div class="muted">Turns every item's history into one Starting count. Asks first and offers a backup.</div>
    <button class="btn" data-act="inv-consolidate" style="border-color:var(--accent-text);color:var(--accent-text)">Consolidate all components</button>`);
}

function invEventCard(e, withItem) {
  const it = byId(INV[e.kind].store, e.itemId);
  return `<div class="card"><div class="row sb"><span><span class="tag">${INV_TYPES[e.type]}</span> <span class="muted">${esc(e.date)}</span>${e.batchId ? ' <span class="tag">from batch</span>' : ''}</span><b class="mono" style="font-weight:600">${qtyText(e.kind, it, e.qty, true)}</b></div>
    ${withItem ? `<div>${INV[e.kind].one}: ${esc(invName(e.kind, e.itemId))}</div>` : ''}${e.note ? `<div class="muted">${esc(e.note)}</div>` : ''}
    <div class="row sb"><span></span><button class="btn sm danger" data-act="inv-del-event" data-id="${e.id}">Delete</button></div></div>`;
}
function viewComponentItem(kind, id) {
  const it = INV[kind] && byId(INV[kind].store, id);
  if (!it) return viewComponents();
  bar(back('#/components', 'Components', true), invName(kind, id), '', null);
  const st = INV[kind].store, n = onHand(kind, id), lw = it.archived ? null : lowStock().get(kind + '|' + id), evs = evOf(kind, id).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);
  const money2 = (v) => (hasNum(v) ? '$' + Number(v).toFixed(2) : '—');
  const rows = {
    bullet: [['Caliber', calName(it.caliberId) || '—'], ['Style', it.style || '—'], ['Weight', fin(it.weight) ? it.weight + ' gn' : '—'], ['Diameter', fin(it.diameter) ? it.diameter + ' in' : '—'], ['Price (before tax)', money2(it.price)], ['Quantity in the box', hasNum(it.qty) ? it.qty : '—'], ['Shipping and fees', money2(it.ship)]],
    powder: [['Price (before tax)', money2(it.price)], ['Package size', hasNum(it.pkg) ? it.pkg + ' ' + (it.unit === 'kg' ? 'kg' : 'lb') : '—'], ['Shipping and fees', money2(it.ship)]],
    primer: [['Type', it.type || '—'], ['Price (before tax)', money2(it.price)], ['Quantity in the box', hasNum(it.qty) ? it.qty : '—'], ['Shipping and fees', money2(it.ship)]],
    case: [['Calibers', (it.caliberIds || []).map((c) => calName(c)).filter(Boolean).join(', ') || '—'], ['Price (before tax)', money2(it.price)], ['Quantity', hasNum(it.qty) ? it.qty : '—'], ['Loads per case', hasNum(it.loads) ? it.loads : '10 (default)'], ['Shipping and fees', money2(it.ship)]]
  }[kind];
  main(`<div class="row sb"><span class="muted">${INV[kind].one}</span>${it.archived ? '<span class="tag">Archived</span>' : ''}</div>
    <details class="sec" open><summary>Specs and cost</summary>
      <div class="card">${rows.map(([l, v]) => `<div class="kv"><span>${esc(l)}</span><b>${esc(v)}</b></div>`).join('')}
        <div class="muted">${esc(costLive(st, it))}</div></div>
      <button class="btn" data-act="lib-edit" data-s="${st}" data-id="${id}">Edit specs and cost</button></details>
    <details class="sec" open><summary>Stock</summary>
      <div class="card ${n < 0 ? 'flag' : lw ? 'excl' : ''}"><div class="lbl">On hand</div><div class="mono" style="font-size:30px;font-weight:600;${n < 0 ? 'color:var(--red)' : ''}">${qtyText(kind, it, n)}</div>
        ${n < 0 ? '<div style="color:var(--red);font-weight:600">Below zero. Check your entries or recount.</div>' : ''}${lw ? lw.map((l) => `<div class="warn">${esc(lowLineText(l))}</div>`).join('') : ''}<div class="muted">The sum of the events in History.</div></div>
      <div class="grid2"><button class="btn pri" data-act="inv-add" data-k="${kind}" data-id="${id}" data-t="start">Starting count</button><button class="btn" data-act="inv-add" data-k="${kind}" data-id="${id}" data-t="purchase">Purchase</button>
        <button class="btn" data-act="inv-add" data-k="${kind}" data-id="${id}" data-t="recount">Recount</button><button class="btn" data-act="inv-add" data-k="${kind}" data-id="${id}" data-t="used">Used (manual)</button></div></details>
    <details class="sec" open><summary>History · ${evs.length} event${evs.length === 1 ? '' : 's'}</summary>
      ${evs.length ? evs.map((e) => invEventCard(e, false)).join('') : '<div class="card muted">No events yet. Add a starting count to begin.</div>'}</details>
    <details class="sec"><summary>Archive and delete</summary>
      <div class="muted">${it.archived ? 'Archived: hidden from every pick-list, the low-stock flags and the pop-up. Its groups and history are untouched.' : 'Archiving hides it from every pick-list, the low-stock flags and the pop-up. Existing groups still show it, and its history is kept. You can restore it any time.'}</div>
      <button class="btn" data-act="${it.archived ? 'cm-restore' : 'cm-archive'}" data-k="${kind}" data-id="${id}">${it.archived ? 'Restore from archive' : 'Archive this item'}</button>
      <div class="muted">Delete only works for an item never used in a group, historical entry or batch, and with no events. Otherwise archive it.</div>
      <button class="btn danger sm" data-act="lib-delete" data-k="${kind}" data-id="${id}">Delete this item</button></details>`);
}
const LIB_USE = { bullets: 'bulletId', powders: 'powderId', primers: 'primerId', cases: 'caseId' };
function libBlock(s, x) { // why a bullet / powder / primer / case cannot be deleted; '' = free to delete
  const f = LIB_USE[s], cnt = (list) => list.filter((r) => r[f] === x.id).length;
  const nG = cnt(S.groups), nH = cnt(S.hist), nB = cnt(S.batches), nE = S.ledger.filter((e) => e.itemId === x.id).length, parts = [];
  if (nG) parts.push(`${nG} group${nG === 1 ? '' : 's'}`);
  if (nH) parts.push(`${nH} historical entr${nH === 1 ? 'y' : 'ies'}`);
  if (nB) parts.push(`${nB} batch${nB === 1 ? '' : 'es'}`);
  if (nE) parts.push(`${nE} inventory event${nE === 1 ? '' : 's'}`);
  return parts.length ? `Used or has history (${parts.join(', ')}). Archive it instead.` : '';
}
async function libDelete(kind, id) {
  const st = INV[kind].store, x = byId(st, id); if (!x) return;
  const why = libBlock(st, x);
  if (why) return toast(why);
  if (!confirm(`Delete "${x.name}"? This cannot be undone.`)) return;
  await del(st, id); toast('Deleted'); navTo('#/components', true);
}
async function cmArchive(kind, id, on) {
  const st = INV[kind].store, x = byId(st, id); if (!x) return;
  if (on && !confirm(`Archive "${x.name}"? It leaves every pick-list and the low-stock flags. Existing groups and its history stay. You can restore it.`)) return;
  await put(st, { ...x, archived: on }); toast(on ? 'Archived' : 'Restored'); render();
}
function invEventDialog(kind, id, type) {
  const it = byId(INV[kind].store, id), isP = kind === 'powder';
  const titles = { start: 'Starting count', purchase: 'Purchase', recount: 'Recount', used: 'Used (manual)' };
  const fields = [{ k: 'qty', label: type === 'recount' ? 'Actual count now' : 'Quantity', type: 'num', req: true }];
  if (isP) fields.push({ k: 'unit', label: 'Unit', type: 'select', opts: [['lb', 'lb'], ['kg', 'kg'], ['gr', 'grains']] });
  fields.push({ k: 'date', label: 'Date (YYYY-MM-DD)', req: true }, { k: 'note', label: 'Note · optional' });
  formDialog(`${titles[type]} · ${it.name}`, fields, { date: today(), unit: isP ? (it.unit === 'kg' ? 'kg' : 'lb') : '' }, async (v) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) { toast('Date must be YYYY-MM-DD'); throw new Error('bad date'); }
    if (v.qty < 0 || (type !== 'recount' && v.qty === 0)) { toast('Enter a quantity above 0'); throw new Error('bad qty'); }
    const base = isP ? toGrains(v.qty, v.unit) : v.qty, before = onHand(kind, id);
    let signed = type === 'used' ? -base : base, note = v.note;
    if (type === 'recount') {
      signed = Math.round((base - before) * 100) / 100;
      if (signed === 0) { toast('That matches what is on hand, nothing to log'); throw new Error('no change'); }
      note = `Counted ${qtyText(kind, it, base)}, was ${qtyText(kind, it, before)}${v.note ? ' · ' + v.note : ''}`;
    }
    await put('ledger', { id: uid(), kind, itemId: id, type, qty: signed, date: v.date, note, ts: Date.now() });
  });
}
async function invDelEvent(id) {
  const e = byId('ledger', id); if (!e) return;
  if (!confirm(e.batchId ? 'This event came from a batch. The batch record stays; deleting the batch later removes any events that remain. Delete this event?' : 'Delete this event? On hand recomputes.')) return;
  await del('ledger', id); render();
}

/* Log a loaded batch: pick (or type) the parts, the rounds and the date; saving creates Used events. */
let IB = { rid: '', load: '', bullet: '', powder: '', primer: '', case: '', charge: '', rounds: '', date: '', deduct: true, all: false };
const loggedLoads = (rid) => { const m = new Map(); for (const g of S.groups.filter((x) => x.rifleId === rid).sort((a, b) => b.ts - a.ts)) { const k = [g.bulletId, g.powderId, Number(g.charge), g.primerId].join('|'); if (!m.has(k)) m.set(k, g); } return [...m.entries()]; };
function ibLines() {
  const n = num(IB.rounds), ch = num(IB.charge), lines = [], skipped = [];
  if (!(n > 0)) return { lines, skipped, error: 'Enter the number of rounds' };
  const add = (kind, id, qty) => { const have = onHand(kind, id); lines.push({ kind, id, qty, before: have, after: Math.round((have - qty) * 100) / 100 }); };
  if (IB.bullet) add('bullet', IB.bullet, n); else skipped.push('No bullet chosen: projectiles not deducted');
  if (IB.powder && ch > 0) add('powder', IB.powder, Math.round(n * ch * 100) / 100); else skipped.push(IB.powder ? 'No charge entered: powder not deducted' : 'No powder chosen: powder not deducted');
  if (IB.primer) add('primer', IB.primer, n); else skipped.push('No primer chosen: primers not deducted');
  if (IB.deduct) { if (IB.case) add('case', IB.case, n); else skipped.push('No case chosen: cases not deducted'); }
  return { lines, skipped };
}
function ibSummaryHtml(r, title) {
  if (r.error) return `<div class="muted">${r.error}.</div>`;
  const neg = r.lines.filter((l) => l.after < 0);
  return `<div class="lbl">${title}</div>${r.lines.map((l) => { const it = byId(INV[l.kind].store, l.id); return `<div class="row sb"><span>${esc(INV[l.kind].one)} · ${esc(invName(l.kind, l.id))}</span><span class="mono" ${l.after < 0 ? 'style="color:var(--red)"' : ''}>${qtyText(l.kind, it, l.before)} → ${qtyText(l.kind, it, l.after)}</span></div>`; }).join('')}
    ${neg.map((l) => `<div style="color:var(--red);font-weight:600">${esc(INV[l.kind].one)} would go below zero${isTracked(l.kind, l.id) ? '' : ' (nothing entered for it yet)'}.</div>`).join('')}
    ${r.skipped.map((t) => `<div class="muted">${esc(t)}</div>`).join('')}`;
}
function viewBatch() {
  bar(back('#/components', 'Components', true), 'Log loaded batch');
  if (!IB.date) IB.date = today();
  if (IB.rid && (!byId('rifles', IB.rid) || isArch(IB.rid))) IB.rid = '';
  const caseList = IB.rid && !IB.all ? casesFor(IB.rid, IB.case) : act(S.cases, IB.case);
  const loads = IB.rid ? loggedLoads(IB.rid) : [];
  const sel = (kind, label, list) => `<div class="f"><label class="lbl" for="ib-${kind}">${label}</label><select class="in" id="ib-${kind}">${opts(list, IB[kind], (x) => x.name + (kind === 'bullet' && fin(x.weight) ? ' ' + x.weight + ' gn' : ''), '— none —')}</select></div>`;
  main(`<h1>Log loaded batch</h1>
    <div class="muted">Records the components you used up loading a batch of rounds. It never changes group shot counts or fouling shots.</div>
    <div class="f"><label class="lbl" for="ib-rid">Firearm · optional</label><select class="in" id="ib-rid">${opts(liveRifles(), IB.rid, (x) => x.name, 'No firearm')}</select></div>
    ${IB.rid && loads.length ? `<div class="f"><label class="lbl" for="ib-load">Logged load</label><select class="in" id="ib-load"><option value="">— pick a load —</option>${loads.map(([k, g]) => `<option value="${esc(k)}"${IB.load === k ? ' selected' : ''}>${esc(bl(g.bulletId))} · ${esc(nm('powders', g.powderId))} ${g.charge} gn · ${esc(nm('primers', g.primerId))}</option>`).join('')}</select><div class="muted">Fills the parts below. Change any of them by hand.</div></div>` : ''}
    ${sel('bullet', 'Bullet', act(S.bullets, IB.bullet))}${sel('powder', 'Powder', act(S.powders, IB.powder))}
    <div class="f"><label class="lbl" for="ib-charge">Charge (gn)</label><input class="in m" id="ib-charge" inputmode="decimal" value="${esc(IB.charge)}"></div>
    ${sel('primer', 'Primer', act(S.primers, IB.primer))}
    <div class="f"><label class="lbl" for="ib-case">Case</label><select class="in" id="ib-case">${opts(caseList, IB.case, (x) => x.name, '— none —')}</select>${IB.rid && (caseList.length < act(S.cases, IB.case).length || IB.all) ? `<div class="muted"><label style="text-decoration:underline"><input type="checkbox" id="ib-allcase"${IB.all ? ' checked' : ''}> show all cases</label></div>` : ''}</div>
    <div class="grid2"><div class="f"><label class="lbl" for="ib-rounds">Rounds loaded</label><input class="in m" id="ib-rounds" inputmode="numeric" value="${esc(IB.rounds)}"></div>
      <div class="f"><label class="lbl" for="ib-date">Date</label><input class="in m" id="ib-date" value="${esc(IB.date)}"></div></div>
    <label class="row" style="min-height:44px;font-weight:600"><input type="checkbox" id="ib-deduct" style="width:24px;height:24px"${IB.deduct ? ' checked' : ''}> Deduct unused cases</label>
    <div class="card" id="ib-sum">${ibSummaryHtml(ibLines(), 'Summary')}</div>
    <button class="btn pri" data-act="ib-save">Review and save</button>`);
}
function ibConfirm() {
  const r = ibLines();
  if (r.error) return toast(r.error);
  if (!r.lines.length) return toast('Nothing to deduct: pick at least one component');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(IB.date)) return toast('Date must be YYYY-MM-DD');
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog" style="display:flex;flex-direction:column;gap:12px"><h1 style="font-size:22px">Save this batch?</h1>
    <div class="card" style="border:2px solid var(--accent-text)"><b>${esc(IB.date)} · ${esc(IB.rounds)} rounds</b>${ibSummaryHtml(r, 'Components used')}</div>
    <button class="btn pri" type="button" id="ib-ok">Confirm and save</button><button class="btn" type="button" id="ib-x">Cancel</button></form>`;
  document.body.appendChild(d);
  const close = () => { d.close(); d.remove(); };
  $('#ib-x', d).onclick = close;
  $('#ib-ok', d).onclick = async () => { close(); await ibSave(r.lines); };
  d.addEventListener('cancel', () => setTimeout(() => d.remove(), 0));
  d.showModal();
}
async function ibSave(lines) {
  const keyOf = (m) => [...m].flatMap(([k, arr]) => arr.map((x) => k + '#' + x.rid));
  const before = new Set(keyOf(lowStock()));
  const rounds = num(IB.rounds);
  const batch = { id: uid(), ts: Date.now(), date: IB.date, rifleId: IB.rid, bulletId: IB.bullet, powderId: IB.powder, primerId: IB.primer, caseId: IB.case, charge: num(IB.charge), rounds, deductCases: !!(IB.deduct && IB.case), settled: false };
  await put('batches', batch);
  for (const l of lines) await put('ledger', { id: uid(), kind: l.kind, itemId: l.id, type: 'used', qty: -l.qty, date: IB.date, note: `Batch: ${rounds} rounds`, batchId: batch.id, ts: Date.now() });
  // pop-up only for components that dropped below the limit because of THIS batch
  const after = lowStock(), newly = [];
  for (const [k, arr] of after) for (const x of arr) if (!before.has(k + '#' + x.rid)) newly.push({ k, ...x });
  IB = { ...IB, load: '', bullet: '', powder: '', primer: '', case: '', charge: '', rounds: '', date: '', deduct: true, all: false };
  navTo('#/components', true); toast('Batch saved');
  if (newly.length) lowPopup(newly);
}
function lowPopup(newly) {
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog" style="display:flex;flex-direction:column;gap:12px"><h1 style="font-size:22px">Running low</h1>
    <div class="card excl">${newly.map((x) => { const [kind, id] = x.k.split('|'); return `<div><b>${esc(INV[kind].one)}: ${esc(invName(kind, id))}</b><div>${esc(lowLineText(x))}</div></div>`; }).join('')}</div>
    <div class="muted">These dropped below your limit because of the batch you just saved.</div><button class="btn pri" type="button" id="lp-ok">OK</button></form>`;
  document.body.appendChild(d);
  $('#lp-ok', d).onclick = () => { d.close(); d.remove(); };
  d.addEventListener('cancel', () => setTimeout(() => d.remove(), 0));
  d.showModal();
}

function viewInvHistory() {
  bar(back('#/components', 'Components', true), 'History');
  const bIds = new Set(S.batches.map((b) => b.id));
  const rows = [
    ...S.batches.map((b) => ({ t: 'b', date: b.date, ts: b.ts, o: b })),
    ...S.ledger.filter((e) => !e.batchId || !bIds.has(e.batchId)).map((e) => ({ t: 'e', date: e.date, ts: e.ts, o: e }))
  ].sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);
  const batchCard = (b) => {
    const evs = S.ledger.filter((e) => e.batchId === b.id);
    const sums = evs.map((e) => { const it = byId(INV[e.kind].store, e.itemId); return `${qtyText(e.kind, it, e.qty, true)} ${e.kind === 'powder' ? 'powder' : INV[e.kind].title.toLowerCase()}`; });
    const r = byId('rifles', b.rifleId);
    return `<div class="card"><div class="row sb"><span><span class="tag" style="background:var(--accent-soft);color:var(--accent-text)">Batch</span>${b.settled ? ' <span class="tag">settled</span>' : ''} <span class="muted">${esc(b.date)}</span></span><b class="mono" style="font-weight:600">${b.rounds} rds</b></div>
      <div>${esc(r ? r.name + ' · ' : '')}${esc(invName('bullet', b.bulletId))} · ${esc(invName('powder', b.powderId))} ${fin(b.charge) ? b.charge + ' gn' : ''} · ${esc(invName('primer', b.primerId))}</div>
      <div class="muted">${evs.length ? esc(sums.join(' · ')) : 'Its events were consolidated into the starting counts.'}</div>
      <div class="row sb"><span></span><button class="btn sm danger" data-act="inv-del-batch" data-id="${b.id}">Delete batch</button></div></div>`;
  };
  main(`<h1>History</h1>
    <div class="muted">Loaded batches and every individual addition, use and recount, newest first. Each item's own page shows just its events.</div>
    ${rows.length ? rows.map((x) => (x.t === 'b' ? batchCard(x.o) : invEventCard(x.o, true))).join('') : '<div class="card muted">Nothing logged yet.</div>'}
    <h2>Consolidate</h2>
    <div class="card"><div>Turns every component's history into one new Starting count equal to what is on hand now, and deletes the individual events. Batches stay in the list as a log, marked settled.</div></div>
    <button class="btn" data-act="inv-consolidate" style="border-color:var(--accent-text);color:var(--accent-text)">Consolidate all components</button>`);
}
async function invDelBatch(id) {
  const b = byId('batches', id); if (!b) return;
  const evs = S.ledger.filter((e) => e.batchId === id);
  if (!confirm(evs.length ? `Delete this batch and its ${evs.length} event${evs.length === 1 ? '' : 's'}? On hand goes back up by what it used.` : 'Delete this batch record? Its events were already consolidated, so on hand does not change.')) return;
  for (const e of evs) await del('ledger', e.id);
  await del('batches', id); toast('Batch deleted'); render();
}
function invConsolidate() {
  const items = [];
  for (const kind of Object.keys(INV)) for (const it of S[INV[kind].store]) {
    const ev = evOf(kind, it.id);
    if (!ev.length || (ev.length === 1 && ev[0].type === 'start')) continue; // nothing to collapse
    items.push({ kind, it, n: ev.length, have: onHand(kind, it.id) });
  }
  if (!items.length) return toast('Nothing to consolidate: every item is already a single starting count');
  const neg = items.some((x) => x.have < 0), old = !S.cfg.lastBackup || Date.now() - S.cfg.lastBackup > 864e5;
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog" style="display:flex;flex-direction:column;gap:12px"><h1 style="font-size:22px">Consolidate all components?</h1>
    <div class="card" style="border:2px solid var(--accent-text)">${items.map((x) => `<div class="row sb"><span>${esc(INV[x.kind].one)} · ${esc(invName(x.kind, x.it.id))}</span><span class="mono" ${x.have < 0 ? 'style="color:var(--red)"' : ''}>${qtyText(x.kind, x.it, x.have)} · ${x.n} events</span></div>`).join('')}
      ${neg ? '<div style="color:var(--red);font-weight:600">At least one item is below zero. It will start below zero. Recount it first if that is wrong.</div>' : ''}
      <div>Each becomes one Starting count dated today, and its old events are deleted. This cannot be undone.</div>
      <div class="muted">${S.cfg.lastBackup ? 'Last backup: ' + new Date(S.cfg.lastBackup).toLocaleString() : 'You have not made a backup yet.'}</div></div>
    <button class="btn ${old ? 'pri' : ''}" type="button" id="co-backup">Back up first, then consolidate</button>
    <button class="btn ${old ? '' : 'pri'}" type="button" id="co-go">Consolidate without a new backup</button><button class="btn" type="button" id="co-x">Cancel</button></form>`;
  document.body.appendChild(d);
  const close = () => { d.close(); d.remove(); };
  const apply = async () => {
    const day = today();
    for (const x of items) {
      for (const e of evOf(x.kind, x.it.id)) await del('ledger', e.id);
      await put('ledger', { id: uid(), kind: x.kind, itemId: x.it.id, type: 'start', qty: x.have, date: day, note: `Consolidated from ${x.n} events on ${day}`, ts: Date.now() });
    }
    for (const b of S.batches) if (!b.settled) await put('batches', { ...b, settled: true });
    close(); toast(`Consolidated ${items.length} component${items.length === 1 ? '' : 's'}`); render();
  };
  $('#co-x', d).onclick = close;
  $('#co-go', d).onclick = apply;
  $('#co-backup', d).onclick = async () => { try { await exportData(); } catch (e) { toast('Backup failed, nothing was consolidated'); return; } await apply(); };
  d.addEventListener('cancel', () => setTimeout(() => d.remove(), 0));
  d.showModal();
}

/* Load Cost Calculator: one bullet, one primer, one case per round, plus a powder charge. Each part comes from the library or is entered manually. */
const CC_STORE = { bullet: 'bullets', powder: 'powders', primer: 'primers', case: 'cases' };
const CC_FIELDS = {
  bullet: [['price', 'Price ($, before tax)'], ['qty', 'Quantity in the box'], ['ship', 'Shipping and fees ($)']],
  primer: [['price', 'Price ($, before tax)'], ['qty', 'Quantity in the box'], ['ship', 'Shipping and fees ($)']],
  powder: [['price', 'Price ($, before tax)'], ['pkg', 'Package size'], ['unit', 'unit'], ['ship', 'Shipping and fees ($)']],
  case: [['price', 'Price ($, before tax; 0 = free)'], ['qty', 'Quantity'], ['loads', 'Loads per case (blank = 10)'], ['ship', 'Shipping and fees ($)']]
};
const MAN = '__manual__';
let CC = { rid: '', bullet: '', powder: '', primer: '', case: '', charge: '', all: false, m: { bullet: {}, powder: { unit: 'lb' }, primer: {}, case: { loads: '10' } } };
const ccItem = (kind) => {
  if (CC[kind] === MAN) { const m = CC.m[kind]; return { price: num(m.price), qty: num(m.qty), pkg: num(m.pkg), unit: m.unit || 'lb', loads: num(m.loads), ship: num(m.ship) }; }
  return CC[kind] ? byId(CC_STORE[kind], CC[kind]) : null;
};
function ccResult() {
  if (!CC.bullet && !CC.powder && !CC.primer && !CC.case) return '<div class="muted">Pick a bullet, powder, primer and case, or choose Manual to type in prices.</div>';
  const L = loadCost({ bullet: ccItem('bullet'), powder: ccItem('powder'), primer: ccItem('primer'), brass: ccItem('case'), charge: num(CC.charge) });
  const why = { bullet: !CC.bullet ? 'not picked' : '', powder: !CC.powder ? 'not picked' : num(CC.charge) === null ? 'enter a charge' : '', primer: !CC.primer ? 'not picked' : '', brass: !CC.case ? 'not picked' : '' };
  const per = (n) => (L.none ? '—' : money(L.total * n, 2));
  return `<div class="card"><div class="row sb"><div class="lbl">Cost per round</div><b class="mono" style="font-size:24px">${L.none ? '—' : money(L.total)}${L.incomplete ? ' · incomplete' : ''}</b></div>
    <div class="grid3"><div><div class="lbl">Per 20</div><span class="mono v">${per(20)}</span></div><div><div class="lbl">Per 50</div><span class="mono v">${per(50)}</span></div><div><div class="lbl">Per 100</div><span class="mono v">${per(100)}</span></div></div>
    ${costLines(L, why)}
    <div class="kv"><span><b>Total</b>${L.incomplete ? ' (incomplete)' : ''}</span><b>${L.none ? '—' : money(L.total)}</b></div>
    <div class="muted">${esc(curLabel())} · prices before tax, tax added at ${taxPct()}%. Missing lines are left out of the total, not counted as zero.</div></div>`;
}
function ccManualHtml(kind) {
  const m = CC.m[kind];
  return `<div class="card" id="ccm-${kind}">${CC_FIELDS[kind].map(([k, label]) => (k === 'unit'
    ? `<div class="f"><label class="lbl" for="cc-m-${kind}-unit">Package unit</label><select class="in" id="cc-m-${kind}-unit"><option value="lb"${m.unit !== 'kg' ? ' selected' : ''}>lb</option><option value="kg"${m.unit === 'kg' ? ' selected' : ''}>kg</option></select></div>`
    : `<div class="f"><label class="lbl" for="cc-m-${kind}-${k}">${label}</label><input class="in m" id="cc-m-${kind}-${k}" inputmode="decimal" value="${esc(m[k] ?? '')}"></div>`)).join('')}
    <button class="btn sm" data-act="cc-save" data-v="${kind}">Save to library</button></div>`;
}
function viewCostCalc() {
  bar(back('#/tools', 'Tools', true), 'Load cost');
  if (CC.rid && (!byId('rifles', CC.rid) || isArch(CC.rid))) CC.rid = '';
  const caseList = CC.rid && !CC.all ? casesFor(CC.rid, CC.case) : act(S.cases, CC.case);
  const sel = (kind, label, list, extra = '') => `<div class="f"><label class="lbl" for="cc-${kind}">${label}</label><select class="in" id="cc-${kind}">${opts(list, CC[kind], (x) => x.name + (kind === 'bullet' && fin(x.weight) ? ' ' + x.weight + ' gn' : ''), '— pick —')}<option value="${MAN}"${CC[kind] === MAN ? ' selected' : ''}>Manual…</option></select>${extra}</div>${CC[kind] === MAN ? ccManualHtml(kind) : ''}`;
  const loads = CC.rid ? (() => { const m = new Map(); for (const g of S.groups.filter((x) => x.rifleId === CC.rid).sort((a, b) => b.ts - a.ts)) { const k = [g.bulletId, g.powderId, Number(g.charge), g.primerId].join('|'); if (!m.has(k)) m.set(k, g); } return [...m.entries()]; })() : [];
  main(`<h1>Load cost</h1>
    <div class="muted">Cost per round from your library prices (before tax, plus tax). One bullet, one primer and one case per round. Display only: nothing here affects your data or rankings.</div>
    <div class="f"><label class="lbl" for="cc-rid">Firearm · optional (filters the case list, enables the shortcut)</label><select class="in" id="cc-rid">${opts(liveRifles(), CC.rid, (x) => x.name, 'No firearm')}</select></div>
    ${CC.rid && loads.length ? `<div class="f"><label class="lbl" for="cc-fill">Fill from a logged load</label><select class="in" id="cc-fill"><option value="">— pick a load —</option>${loads.map(([k, g]) => `<option value="${esc(k)}">${esc(bl(g.bulletId))} · ${esc(nm('powders', g.powderId))} ${g.charge} gn · ${esc(nm('primers', g.primerId))}</option>`).join('')}</select></div>` : ''}
    ${sel('bullet', 'Bullet', act(S.bullets, CC.bullet))}
    ${sel('powder', 'Powder', act(S.powders, CC.powder))}
    <div class="f"><label class="lbl" for="cc-charge">Charge (gn)</label><input class="in m" id="cc-charge" inputmode="decimal" value="${esc(CC.charge)}"></div>
    ${sel('primer', 'Primer', act(S.primers, CC.primer))}
    ${sel('case', 'Case', caseList, CC.rid && caseList.length < act(S.cases, CC.case).length ? '<div class="muted"><label style="text-decoration:underline"><input type="checkbox" id="cc-allcase"> show all cases</label></div>' : (CC.rid && CC.all ? '<div class="muted"><label style="text-decoration:underline"><input type="checkbox" id="cc-allcase" checked> show all cases</label></div>' : ''))}
    <div id="cc-out">${ccResult()}</div>`);
}
function ccSave(kind) { // turn a manual entry into a library item (needs a name; a bullet also needs a diameter)
  const m = CC.m[kind], store = CC_STORE[kind];
  const fields = [{ k: 'name', label: 'Name for the library', req: true }];
  if (kind === 'bullet') fields.push({ k: 'weight', label: 'Weight (gn) · optional', type: 'num' }, { k: 'diameter', label: 'Diameter (in)', type: 'num', req: true });
  formDialog('Save to library', fields, kind === 'bullet' ? { diameter: 0.308 } : {}, async (v) => {
    const item = { id: uid(), name: v.name, price: num(m.price), qty: num(m.qty), ship: num(m.ship) };
    if (kind === 'powder') { item.pkg = num(m.pkg); item.unit = m.unit || 'lb'; delete item.qty; }
    if (kind === 'case') item.loads = num(m.loads);
    if (kind === 'bullet') { item.weight = v.weight; item.diameter = v.diameter; }
    await put(store, item);
    CC[kind] = item.id; CC.m[kind] = kind === 'powder' ? { unit: 'lb' } : kind === 'case' ? { loads: '10' } : {};
    toast('Saved to library');
  });
}
function viewTools() {
  bar(back('#/', 'Firearms', true), 'Tools');
  main(`<h1>Tools</h1>
    <a class="card" href="#/tools/cost"><div class="row sb"><b>Load cost</b><span aria-hidden="true">→</span></div>
      <div class="muted">Cost per round, per 20, 50 and 100 from your library prices, with tax.</div></a>
    <a class="card" href="#/tools/loadcheck"><div class="row sb"><b>Load check</b><span aria-hidden="true">→</span></div>
      <div class="muted">Before you build a load: see whether it matches an issue you logged (too hot, too weak, short stroke...).</div></a>
    <a class="card" href="#/tools/crimp"><div class="row sb"><b>Crimp test</b><span aria-hidden="true">→</span></div>
      <div class="muted">Check whether your crimp holds COAL in the magazine tube. A decreasing ladder: each pass measures the rounds still in the tube.</div></a>`);
}

/* Crimp test. Pass p holds rounds p..n (pass 1 = all rounds, the baseline). From pass 2 on, each COAL is compared with its OWN pass 1 value:
   within +/- tolerance = green, outside = red. One working test is kept on this device (meta store, not in backups) until you clear it. */
let CR = null, crTimer = null;
const crKey = (p, r) => p + '-' + r;
function crLoad() {
  if (!CR) CR = { id: 'crimp', n: 8, tol: 0.005, pass: 1, vals: {}, ...(S.meta.find((m) => m.id === 'crimp') || {}) };
  return CR;
}
function crSave() { clearTimeout(crTimer); crTimer = setTimeout(() => { rp(store('meta', 'readwrite').put(CR)).catch(() => {}); }, 250); }
function crCalc() {
  const { n, tol } = CR, cells = {};
  let entered = 0, ok = 0, bad = 0, worst = 0, worstAt = '';
  for (let p = 1; p <= n; p++) for (let r = p; r <= n; r++) {
    const v = num(CR.vals[crKey(p, r)]), base = num(CR.vals[crKey(1, r)]);
    let st = 'none', d = null;
    if (v !== null) {
      entered++;
      if (p === 1) st = 'base';
      else if (base === null) st = 'nobase';
      else {
        d = v - base;
        st = Math.abs(d) <= tol + 1e-9 ? 'ok' : 'bad'; // exactly on the limit counts as within
        if (st === 'ok') ok++; else bad++;
        if (Math.abs(d) > worst) { worst = Math.abs(d); worstAt = `round ${r}, pass ${p}`; }
      }
    }
    cells[crKey(p, r)] = { st, d };
  }
  return { cells, entered, ok, bad, worst, worstAt, total: n * (n + 1) / 2 };
}
const crDelta = (c) => (c.st === 'ok' || c.st === 'bad' ? `<b>${sfmt(c.d, 3)}</b><small>${c.st === 'ok' ? 'OK' : 'OUT'}</small>` : c.st === 'nobase' ? '<small>enter pass 1</small>' : '');
function crSummary(k) {
  const compared = k.ok + k.bad;
  const verdict = !compared ? '<span class="tag">No comparisons yet</span>' : k.bad ? `<span class="tag a">${k.bad} outside tolerance</span>` : '<span class="tag g">All within tolerance</span>';
  return `${verdict}<div class="muted" style="margin-top:6px">${k.entered} of ${k.total} entered · ${compared} compared to pass 1${compared ? ` · worst change ${fmt(k.worst, 3)}" (${k.worstAt})` : ''}</div>`;
}
function crMatrix(k) {
  const n = CR.n, tag = { ok: 'ok', bad: 'bad', base: 'base', nobase: 'none', none: 'none' };
  let h = `<div class="crm" style="grid-template-columns:34px repeat(${n},minmax(0,1fr))"><span></span>${Array.from({ length: n }, (_, i) => `<span class="lbl" style="text-align:center">${i + 1}</span>`).join('')}`;
  for (let p = 1; p <= n; p++) {
    h += `<span class="lbl">P${p}</span>`;
    for (let r = 1; r <= n; r++) h += r < p ? '<span></span>' : `<button type="button" class="crcell ${tag[k.cells[crKey(p, r)].st]}" data-act="cr-pass" data-p="${p}" aria-label="Pass ${p}, round ${r}: ${k.cells[crKey(p, r)].st === 'ok' ? 'within tolerance' : k.cells[crKey(p, r)].st === 'bad' ? 'outside tolerance' : 'no result'}"></button>`;
  }
  return h + '</div><div class="muted">Rows = passes, columns = rounds. Green within tolerance, red outside, blue = pass 1 baseline. Tap a row to open that pass.</div>';
}
function crRefresh() { // patch colors and text in place so typing never loses focus
  const k = crCalc();
  $$('.crrow').forEach((row) => {
    const c = k.cells[crKey(row.dataset.p, row.dataset.r)];
    $('input', row).className = 'in m cr-in ' + (c.st === 'ok' || c.st === 'bad' ? c.st : '');
    $('.crd', row).innerHTML = crDelta(c);
  });
  const s = $('#cr-sum'); if (s) s.innerHTML = crSummary(k);
  const m = $('#cr-mat'); if (m) m.innerHTML = crMatrix(k);
}
function viewCrimp() {
  crLoad();
  bar(back('#/tools', 'Tools', true), 'Crimp test');
  const k = crCalc(), n = CR.n, p = Math.min(CR.pass, n);
  const rows = [];
  for (let r = p; r <= n; r++) {
    const c = k.cells[crKey(p, r)], base = CR.vals[crKey(1, r)];
    rows.push(`<div class="crrow" data-p="${p}" data-r="${r}"><div><b>Rnd ${r}</b>${p > 1 ? `<small>Pass 1: ${base ? esc(base) : '—'}</small>` : ''}</div>
      <input class="in m cr-in ${c.st === 'ok' || c.st === 'bad' ? c.st : ''}" inputmode="decimal" autocomplete="off" value="${esc(CR.vals[crKey(p, r)] ?? '')}" aria-label="Pass ${p}, round ${r} COAL (in)" placeholder="COAL">
      <div class="crd">${crDelta(c)}</div></div>`);
  }
  main(`<h1>Crimp test</h1>
    <div class="muted">Pass 1: measure COAL of all ${n} rounds. Each later pass: the rounds still in the tube (pass 2 = rounds 2–${n}, and so on down to round ${n}). Each COAL is checked against its own pass 1 value.</div>
    <div class="grid2">
      <div class="f"><span class="lbl">Rounds</span><div class="row"><button class="btn sm" data-act="cr-n" data-v="-1" aria-label="Fewer rounds">−</button><b class="mono v" style="min-width:36px;text-align:center">${n}</b><button class="btn sm" data-act="cr-n" data-v="1" aria-label="More rounds">+</button></div></div>
      <div class="f"><label class="lbl" for="cr-tol">Tolerance ± (in)</label><input class="in m" id="cr-tol" inputmode="decimal" value="${CR.tol}"></div>
    </div>
    <div class="card" id="cr-sum">${crSummary(k)}</div>
    <div class="row" style="flex-wrap:wrap;gap:6px">${Array.from({ length: n }, (_, i) => `<button class="btn sm ${i + 1 === p ? 'pri' : ''}" style="min-width:44px" data-act="cr-pass" data-p="${i + 1}" aria-pressed="${i + 1 === p}">${i + 1}</button>`).join('')}</div>
    <h2>Pass ${p} · ${p === 1 ? `all ${n} rounds (baseline)` : `rounds ${p}–${n}`}</h2>
    <div class="stack">${rows.join('')}</div>
    ${p < n ? `<button class="btn dark" data-act="cr-pass" data-p="${p + 1}">Next pass →</button>` : ''}
    <h2>Overview</h2><div id="cr-mat">${crMatrix(k)}</div>
    <button class="btn danger" data-act="cr-clear">Clear all values</button>
    <div class="muted">Kept on this device until you clear it. Not included in backups.</div>`);
}

/* Calibers are a library. A rifle and a bullet are linked by sharing the same caliber; the group form's bullet list follows the rifle. */
const calNorm = (s) => String(s || '').toLowerCase().replace(/^\./, '').replace(/\s+/g, ' ').trim();
const calMatch = (a, b) => { a = calNorm(a); b = calNorm(b); return !!a && !!b && (a.startsWith(b) || b.startsWith(a)); }; // only used to migrate old free-text values
const calName = (id) => (byId('calibers', id) || {}).name || '';
const calOpts = () => [['', '— none —'], ...S.calibers.slice().sort((a, b) => a.name.localeCompare(b.name)).map((c) => [c.id, c.name])];
// bullets of the rifle's caliber, plus any bullet with no caliber set (never hide a bullet just because it is unassigned)
function bulletsFor(rid, keepId) {
  const r = byId('rifles', rid);
  const all = act(S.bullets, keepId);
  if (!r || !r.caliberId) return all;
  return all.filter((b) => !b.caliberId || b.caliberId === r.caliberId || b.id === keepId);
}

function histForm(rid, h) {
  if (!act(S.bullets).length || !act(S.powders).length) { toast('Add a bullet and powder in Components first'); return; }
  formDialog(h ? 'Edit historical entry' : 'Historical entry', [
    { k: 'bulletId', label: 'Bullet', type: 'select', opts: bulletsFor(rid, h && h.bulletId).map((b) => [b.id, bl(b.id)]) },
    { k: 'powderId', label: 'Powder', type: 'select', opts: act(S.powders, h && h.powderId).map((p) => [p.id, p.name]) },
    { k: 'charge', label: 'Charge (gn)', type: 'num', req: true },
    { k: 'es', label: 'Extreme spread, manual (in)', type: 'num' },
    { k: 'note', label: 'Note' }
  ], h || {}, async (v) => { await put('hist', { ...(h || { id: uid(), rifleId: rid }), ...v }); },
  h ? async () => { if (!confirm('Delete this entry?')) return false; await del('hist', h.id); return true; } : null);
}

function plotSVG(g, s) {
  const pts = g.shots.filter((p) => fin(p.x) && fin(p.y));
  if (!pts.length) return '';
  let E = Math.max(0.5, ...pts.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y)))) * 1.15;
  E = Math.ceil(E * 4) / 4;
  const rad = s.dia ? s.dia / 2 : 0.154;
  const rings = [];
  for (let r = 0.25; r <= E + 1e-6; r += 0.25) rings.push(r);
  return `<svg class="plot" viewBox="${-E} ${-E} ${2 * E} ${2 * E}" role="img" aria-label="Shot plot, inches from point of aim">
    ${rings.map((r) => `<circle cx="0" cy="0" r="${r}" fill="none" style="stroke:var(--line)" stroke-width="${E / 200}"/>`).join('')}
    <line x1="${-E}" y1="0" x2="${E}" y2="0" style="stroke:var(--line2)" stroke-width="${E / 200}"/><line x1="0" y1="${-E}" x2="0" y2="${E}" style="stroke:var(--line2)" stroke-width="${E / 200}"/>
    ${pts.map((p, i) => `<circle cx="${p.x}" cy="${-p.y}" r="${rad}" style="fill:var(--accent);fill-opacity:.45;stroke:var(--accent-text)" stroke-width="${E / 250}"/><text x="${p.x}" y="${-p.y + E / 60}" font-size="${E / 22}" text-anchor="middle" style="fill:var(--ink)">${g.shots.indexOf(p) + 1}</text>`).join('')}
    ${s.cx !== null ? `<path d="M${s.cx - E / 25} ${-s.cy}H${s.cx + E / 25}M${s.cx} ${-s.cy - E / 25}V${-s.cy + E / 25}" style="stroke:var(--red)" stroke-width="${E / 90}"/>` : ''}
    <circle cx="0" cy="0" r="${E / 60}" style="fill:var(--ink)"/></svg>
    <div class="muted">Plot: rings every 0.25" from point of aim · red cross = group center · circles drawn at bullet diameter.</div>`;
}

// Pistol group detail: manual group size + velocity stats only (no X/Y plot, POA, jump, mean radius or calculated ES).
function viewGroupPistol(g) {
  const s = gstats(g), se = sessOf(g) || {}, gid = g.id;
  bar(back('#/session/' + g.sessionId + '?g=' + gid, 'Session'), 'Group · ' + gdate(g), isArch(g.rifleId) ? '' : `<a class="r" href="#/edit/${gid}">Edit</a>`, g.rifleId);
  const sess = groupsOf(g.sessionId);
  main(`${archBanner(g.rifleId)}<div><h1 style="font-size:24px">${esc(se.id ? sessionLabel(se) : '—')} · Group ${sess.findIndex((x) => x.id === g.id) + 1}</h1>
    <div class="muted">${esc(bl(g.bulletId))} · ${esc(nm('powders', g.powderId))} ${g.charge} gn · ${esc(nm('primers', g.primerId))} · COAL ${fin(g.coal) ? g.coal + '"' : '—'} · ${fin(g.distance) ? g.distance + ' yd' : 'no distance'}</div>
    ${caseLine(g)}
    <div class="row" style="margin-top:6px">${g.include === false ? '<span class="tag a">Excluded from analysis</span>' : '<span class="tag g">Included</span>'}${g.reference ? '<span class="tag g">Reference group</span>' : ''}</div></div>
    ${issueBox(g)}
    <div class="hero"><div class="lbl">Group size (manual, outside-to-outside)</div><div class="big mono">${fmt(g.groupSize, 2)}"</div><div class="mono">${fmt(moa(g.groupSize, g.distance), 2)} MOA</div>
      <div style="opacity:.85;font-size:13px">at ${fin(g.distance) ? g.distance + ' yd' : '— (set a distance to see MOA)'}</div></div>
    <div class="card"><div class="lbl">Velocity · ${s.vn} of ${s.total} shots</div>
      <div class="kv"><span>Average</span><b>${fin(s.vavg) ? s.vavg.toFixed(0) + ' fps' : '—'}</b></div>
      <div class="kv"><span>Std dev (sample)</span><b>${fmt(s.vsd, 1)}</b></div>
      <div class="kv"><span>Extreme spread</span><b>${fmt(s.ves, 0)}</b></div></div>
    <div class="card"><a href="#/session/${g.sessionId}?g=${g.id}" style="display:flex;flex-direction:column;gap:8px;color:inherit">
      <div class="row sb"><div class="lbl">Session · tap to see all its groups</div><span aria-hidden="true">→</span></div>
      <b>${esc(se.id ? sessionLabel(se) : '—')}</b>
      <div class="muted">${fin(se.temp) ? se.temp + ' F · ' : ''}${esc(se.wind || 'no wind noted')}</div>
      <div class="kv"><span>Session fouling shots</span><b>${fin(se.fouling) ? se.fouling : 0}</b></div>
      <div class="kv"><span>Rounds since clean (at start of group)</span><b>${roundsSinceClean(g) ?? '—'}</b></div></a>
      ${isArch(g.rifleId) ? '' : `<button class="btn sm" data-act="edit-session" data-id="${g.sessionId}">Edit session</button>`}</div>
    ${costCard(g)}
    <div class="card"><div class="lbl">Shots</div><table><thead><tr><th>#</th><th>Velocity (fps)</th></tr></thead><tbody>
      ${g.shots.map((p, i) => `<tr><td>${i + 1}</td><td>${fin(p.v) ? p.v : '—'}</td></tr>`).join('')}</tbody></table></div>
    ${g.notes ? `<div class="card"><div class="lbl">Notes</div>${esc(g.notes)}</div>` : ''}
    ${isArch(g.rifleId) ? '' : `<a class="btn dark" href="#/add/${g.sessionId}?from=${g.id}">+ Add another group (same session &amp; load)</a>
    <button class="btn danger" data-act="del-group" data-id="${g.id}">Delete group</button>`}`);
}

function viewGroup(gid) {
  const g = byId('groups', gid);
  if (!g) return viewHome();
  if (isPistol(g.rifleId)) return viewGroupPistol(g);
  const s = gstats(g);
  const se = sessOf(g) || {};
  bar(back('#/session/' + g.sessionId + '?g=' + gid, 'Session'), 'Group · ' + gdate(g), isArch(g.rifleId) ? '' : `<a class="r" href="#/edit/${gid}">Edit</a>`, g.rifleId);
  const sess = groupsOf(g.sessionId);
  main(`${archBanner(g.rifleId)}<div><h1 style="font-size:24px">${esc(se.id ? sessionLabel(se) : '—')} · Group ${sess.findIndex((x) => x.id === g.id) + 1}</h1>
    <div class="muted">${esc(bl(g.bulletId))} · ${esc(nm('powders', g.powderId))} ${g.charge} gn · ${esc(nm('primers', g.primerId))} · ${g.jump} thou · ${fin(g.distance) ? g.distance + ' yd' : 'no distance'}</div>
    ${caseLine(g)}
    <div class="row" style="margin-top:6px">${g.include === false ? '<span class="tag a">Excluded from analysis</span>' : '<span class="tag g">Included</span>'}${g.reference ? '<span class="tag g">Reference group</span>' : ''}</div></div>
    ${issueBox(g)}
    <div class="hero"><div class="grid2"><div><div class="lbl">Mean radius</div><div class="big mono">${fmt(s.mr)}"</div><div class="mono">${fmt(moa(s.mr, g.distance), 2)} MOA</div></div><div><div class="lbl">ES (center)</div><div class="big mono">${fmt(s.es)}"</div><div class="mono">${fmt(moa(s.es, g.distance), 2)} MOA</div></div></div>
      <div style="opacity:.85;font-size:13px">at ${fin(g.distance) ? g.distance + ' yd' : '— (set a distance to see MOA)'}</div></div>
    ${plotSVG(g, s)}
    <div class="card"><div class="lbl">Extreme spread</div>
      <div class="kv"><span>Calculated, center-to-center</span><b>${fmt(s.es)}"</b></div>
      <div class="kv"><span>Calculated, in MOA</span><b>${fmt(moa(s.es, g.distance), 2)}</b></div>
      <div class="kv"><span>+ bullet dia ${fmt(s.dia)} = outside-to-outside</span><b>${fmt(s.esOO)}"</b></div>
      <div class="kv"><span>Outside-to-outside, in MOA</span><b>${fmt(moa(s.esOO, g.distance), 2)}</b></div>
      <div class="kv"><span>Manual caliper reading</span><b>${fin(g.esManual) ? fmt(g.esManual) + '"' : '—'}</b></div></div>
    <div class="card"><div class="lbl">Group center &amp; POA offset</div>
      <div class="kv"><span>Center X / Y</span><b>${sfmt(s.cx)} / ${sfmt(s.cy)}</b></div>
      <div class="kv"><span>Distance from POA</span><b>${fmt(s.poa)}"</b></div></div>
    <div class="card"><div class="lbl">Velocity · ${s.vn} of ${s.total} shots</div>
      <div class="kv"><span>Average</span><b>${fin(s.vavg) ? s.vavg.toFixed(0) + ' fps' : '—'}</b></div>
      <div class="kv"><span>Std dev (sample)</span><b>${fmt(s.vsd, 1)}</b></div>
      <div class="kv"><span>Extreme spread</span><b>${fmt(s.ves, 0)}</b></div></div>
    <div class="card"><a href="#/session/${g.sessionId}?g=${g.id}" style="display:flex;flex-direction:column;gap:8px;color:inherit">
      <div class="row sb"><div class="lbl">Session · tap to see all its groups</div><span aria-hidden="true">→</span></div>
      <b>${esc(se.id ? sessionLabel(se) : '—')}</b>
      <div class="muted">${fin(se.temp) ? se.temp + ' F · ' : ''}${esc(se.wind || 'no wind noted')}</div>
      <div class="kv"><span>Session fouling shots</span><b>${fin(se.fouling) ? se.fouling : 0}</b></div>
      <div class="kv"><span>Rounds since clean (at start of group)</span><b>${roundsSinceClean(g) ?? '—'}</b></div></a>
      <div class="kv"><span>COAL / trimmed length</span><b>${fin(g.coal) ? g.coal : '—'} / ${fin(g.trim) ? g.trim : '—'}</b></div>
      ${isArch(g.rifleId) ? '' : `<button class="btn sm" data-act="edit-session" data-id="${g.sessionId}">Edit session</button>`}</div>
    ${costCard(g)}
    <div class="card"><div class="lbl">Shots</div><table><thead><tr><th>#</th><th>Vel</th><th>X</th><th>Y</th><th>Rad</th></tr></thead><tbody>
      ${g.shots.map((p, i) => `<tr><td>${i + 1}</td><td>${fin(p.v) ? p.v : '—'}</td><td>${sfmt(p.x)}</td><td>${sfmt(p.y)}</td><td>${fin(p.x) && fin(p.y) && s.cx !== null ? fmt(Math.hypot(p.x - s.cx, p.y - s.cy)) : '—'}</td></tr>`).join('')}</tbody></table></div>
    ${g.notes ? `<div class="card"><div class="lbl">Notes</div>${esc(g.notes)}</div>` : ''}
    ${isArch(g.rifleId) ? '' : `<a class="btn dark" href="#/add/${g.sessionId}?from=${g.id}">+ Add another group (same session &amp; load)</a>
    <button class="btn danger" data-act="del-group" data-id="${g.id}">Delete group</button>`}`);
}

function shotRow(i, p = {}) {
  const c = (cls, val, lab, sign) => `<td class="cell"><input class="in m ${cls}" inputmode="decimal" aria-label="Shot ${i + 1} ${lab}" value="${fin(val) ? val : ''}" autocomplete="off">${sign ? '<button type="button" class="sg" data-act="sign" aria-label="Toggle sign">±</button>' : ''}</td>`;
  return `<tr><td class="mono" style="width:24px;padding:0"><b>${i + 1}</b></td>${c('sv', p.v, 'velocity', false)}${c('sx', p.x, 'X', true)}${c('sy', p.y, 'Y', true)}</tr>`;
}

/* Case (optional, from the Cases library). NOT part of the combo key, so pooling, rankings and issue flags ignore it.
   A new group starts with the case of the most recent group that has one on the same firearm (by logged order). */
// Caliber is a display filter only (never touches pooling or stats): cases tagged with the firearm's caliber, plus untagged cases.
// No firearm caliber = every case. The group's own current case (keepId) is always kept in the list.
function casesFor(rid, keepId) {
  const r = byId('rifles', rid);
  const all = act(S.cases, keepId);
  if (!r || !r.caliberId) return all;
  return all.filter((c) => !(c.caliberIds && c.caliberIds.length) || c.caliberIds.includes(r.caliberId) || c.id === keepId);
}
const lastCase = (rid) => {
  const g = S.groups.filter((x) => x.rifleId === rid && x.caseId && byId('cases', x.caseId) && !byId('cases', x.caseId).archived).sort((a, b) => b.ts - a.ts)[0];
  return g ? g.caseId : '';
};
const caseLine = (g) => (g.caseId && byId('cases', g.caseId) ? `<div class="muted">Case: ${esc(nm('cases', g.caseId))}</div>` : '');
// bulk fill: only groups whose case is blank, never overwriting one; asks first and offers a backup
function setCaseBulk(rid) {
  if (!act(S.cases).length) return toast('Add a case in Components first');
  const blanks = () => S.groups.filter((g) => g.rifleId === rid && !g.caseId);
  if (!blanks().length) return toast('Every group on this firearm already has a case');
  const old = !S.cfg.lastBackup || Date.now() - S.cfg.lastBackup > 864e5;
  const filtered = casesFor(rid); // same caliber filter as the group form; if it leaves nothing, show every case
  const start = filtered.length ? filtered : act(S.cases);
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog" style="display:flex;flex-direction:column;gap:12px"><h1 style="font-size:22px">Set case for groups without one</h1>
    <div class="f"><label class="lbl" for="sc-case">Case</label><select class="in" id="sc-case">${opts(start, start[0].id, (x) => x.name)}</select>
    ${filtered.length && filtered.length < act(S.cases).length ? '<div class="muted"><label style="text-decoration:underline"><input type="checkbox" id="sc-all"> show all cases</label></div>' : ''}</div>
    <div class="card"><b id="sc-msg"></b><div class="muted">Groups that already have a case are not changed.</div>
    <div class="muted">${S.cfg.lastBackup ? 'Last backup: ' + new Date(S.cfg.lastBackup).toLocaleString() : 'You have not made a backup yet.'}</div></div>
    <button class="btn ${old ? 'pri' : ''}" type="button" id="sc-backup">Back up first, then set</button>
    <button class="btn ${old ? '' : 'pri'}" type="button" id="sc-go">Set without a new backup</button>
    <button class="btn" type="button" id="sc-x">Cancel</button></form>`;
  document.body.appendChild(d);
  const close = () => { d.close(); d.remove(); };
  const msg = () => { $('#sc-msg', d).textContent = `Set "${nm('cases', $('#sc-case', d).value)}" on ${blanks().length} group${blanks().length === 1 ? '' : 's'} that have no case?`; };
  const apply = async () => {
    const cid = $('#sc-case', d).value; let n = 0;
    for (const g of blanks()) { await put('groups', { ...g, caseId: cid }); n++; } // re-read at click time: never overwrites
    close(); toast(`Case set on ${n} group${n === 1 ? '' : 's'}`); render();
  };
  $('#sc-case', d).onchange = msg; msg();
  if ($('#sc-all', d)) $('#sc-all', d).onchange = (e) => { const lst = e.target.checked ? act(S.cases) : filtered; $('#sc-case', d).innerHTML = opts(lst, lst[0].id, (x) => x.name); msg(); };
  $('#sc-x', d).onclick = close;
  $('#sc-go', d).onclick = apply;
  $('#sc-backup', d).onclick = async () => { await exportData(); await apply(); };
  d.addEventListener('cancel', () => setTimeout(() => d.remove(), 0));
  d.showModal();
}

/* Issue fields shared by the rifle and pistol group forms. Turning Issue on sets Include to N and locks it; turning it off leaves Include at N, unlocked. */
function issueFields(g0) {
  const on = !!(g0 && g0.issue === true), sc = (g0 && g0.issueScope) || 'exact', cat = (g0 && g0.issueCategory) || '';
  const rd = (v, label) => `<label><input type="radio" name="isc" value="${v}"${sc === v ? ' checked' : ''}><span>${label}</span></label>`;
  return `<div class="f"><span class="lbl">Issue</span><div class="seg"><label><input type="radio" name="iss" value="1"${on ? ' checked' : ''}><span>Y</span></label><label><input type="radio" name="iss" value="0"${on ? '' : ' checked'}><span>N</span></label></div></div>
    <div id="issbox" class="stack"${on ? '' : ' hidden'}>
      <div class="muted">Flagging a group sets Include to N, so it stays out of the pooled numbers.</div>
      <div class="f"><label class="lbl" for="f-icat">Category</label><select class="in" id="f-icat"><option value="">— optional —</option>${ISSUE_CATS.map((c) => `<option${c === cat ? ' selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="f"><span class="lbl">Applies to</span><div class="seg seg3">${rd('exact', 'This load')}${rd('higher', 'Higher')}${rd('lower', 'Lower')}</div>
        <div class="muted">Higher: this charge and above are bad. Lower: this charge and below are bad.</div></div>
      <div class="f"><label class="lbl" for="f-inote">Issue note</label><input class="in" id="f-inote" type="text" value="${esc((g0 && g0.issueNote) || '')}" autocomplete="off"></div>
    </div>
    <div id="issWarn"></div>`;
}
function issueSync() {
  const box = $('#issbox'); if (!box) return;
  const on = !!$('input[name=iss][value="1"]:checked');
  box.hidden = !on;
  $$('input[name=inc]').forEach((r) => { r.disabled = on; });
  if (on) { const n = $('input[name=inc][value="0"]'); if (n) n.checked = true; }
}
function issueRead() {
  const on = !!$('input[name=iss][value="1"]:checked');
  const sc = $('input[name=isc]:checked');
  return { issue: on, issueCategory: on ? ($('#f-icat').value || '') : '', issueScope: on ? (sc ? sc.value : 'exact') : '', issueNote: on ? $('#f-inote').value.trim() : '' };
}
// advisory only: warns when the bullet + powder + charge being logged match a flag on this firearm (ignores the group being edited)
function issueWarn(rid, gid) {
  const box = $('#issWarn'); if (!box) return;
  const fl = flagsFor({ rifleId: rid, bulletId: $('#f-bullet').value, powderId: $('#f-powder').value, charge: num($('#f-charge').value), primerId: $('#f-primer').value,
    jump: $('#f-jump') ? num($('#f-jump').value) : null, coal: $('#f-coal') ? num($('#f-coal').value) : null }, gid);
  box.innerHTML = fl.length ? `<div class="card flagbox"><div class="lbl" style="color:inherit">Warning · issue logged on this load</div>${fl.map(flagLine).join('')}</div>` : '';
}

/* Pistol group form: no X/Y, bullseye, jump or calculated spread. Explicit shot count with one velocity box per shot (a blank reading still counts as a shot),
   one manual group size, and COAL (required: it is part of the pistol combo key). */
const vRow = (i, val) => `<tr data-i="${i}"><td class="mono" style="width:24px;padding:0"><b>${i + 1}</b></td><td class="cell"><input class="in m sv" inputmode="decimal" aria-label="Shot ${i + 1} velocity (fps)" placeholder="fps" value="${esc(val ?? '')}" autocomplete="off"></td></tr>`;
function viewGroupFormPistol(rid, gid, fromId, sid) {
  const r = byId('rifles', rid);
  const g0 = gid ? byId('groups', gid) : null;
  const src = g0 || (fromId && byId('groups', fromId)) || S.groups.filter((g) => g.rifleId === rid).sort((a, b) => b.ts - a.ts)[0] || {};
  const missing = !act(S.bullets).length || !act(S.powders).length || !act(S.primers).length;
  bar(back(g0 ? '#/group/' + gid : '#/session/' + sid, g0 ? 'Group' : 'Session'), g0 ? 'Edit Group' : 'New Group', '', rid);
  const curSid = g0 ? g0.sessionId : sid;
  const sessOpts = sessionsOf(rid).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts)
    .map((x) => `<option value="${x.id}"${x.id === curSid ? ' selected' : ''}>${esc(sessionLabel(x))} · ${fin(x.fouling) ? x.fouling : 0} fouling</option>`).join('');
  const bLabel = (x) => x.name + (fin(x.weight) ? ' ' + x.weight + ' gn' : '');
  const filtered = bulletsFor(rid, g0 && src.bulletId);
  const caseSel = g0 ? (g0.caseId || '') : (casesFor(rid).some((c) => c.id === lastCase(rid)) ? lastCase(rid) : ''); // new group: the case last used on this firearm, only if it passes the caliber filter
  const n0 = g0 ? g0.shots.length : (src.shots && src.shots.length ? src.shots.length : 10);
  const vals = Array.from({ length: Math.max(n0, 30) }, (_, i) => (g0 && g0.shots[i] && fin(g0.shots[i].v) ? String(g0.shots[i].v) : ''));
  const sec = (t) => `<h2 style="color:var(--accent-text);border-color:var(--accent-text)">${t}</h2>`;
  const fld = (id, label, val, cls = 'm', extra = '') => `<div class="f"><label class="lbl" for="${id}">${label}</label><input class="in ${cls}" id="${id}" type="text" ${cls === 'm' ? 'inputmode="decimal"' : ''} value="${esc(val ?? '')}" autocomplete="off" ${extra}></div>`;
  const yn = (name, on) => `<div class="seg"><label><input type="radio" name="${name}" value="1"${on ? ' checked' : ''}><span>Y</span></label><label><input type="radio" name="${name}" value="0"${on ? '' : ' checked'}><span>N</span></label></div>`;
  main(`${missing ? '<div class="card warn">Add at least one Bullet, Powder and Primer in <a href="#/components" style="text-decoration:underline">Components</a> first.</div>' : ''}
    <form id="gform" data-pistol="1" autocomplete="off">
    ${sec('SESSION')}
    <div class="f"><label class="lbl" for="f-session">Session</label><select class="in" id="f-session">${sessOpts}</select></div>
    <div class="muted">Date, wind, temp and fouling shots belong to the session. Change them with Edit session on the firearm or group page.</div>
    ${sec('LOAD')}
    <div class="f"><label class="lbl" for="f-bullet">Bullet</label><select class="in" id="f-bullet">${opts(filtered, src.bulletId, bLabel)}</select>
    ${r.caliberId ? `<div class="muted">Showing ${esc(calName(r.caliberId))} bullets (and any with no caliber set).${filtered.length < act(S.bullets, g0 && src.bulletId).length ? ' <label style="text-decoration:underline"><input type="checkbox" id="f-allcal"> show all bullets</label>' : ''}</div>`
      : '<div class="muted">Set this firearm\'s caliber (firearm → Edit) to filter bullets automatically.</div>'}</div>
    <div class="f"><label class="lbl" for="f-powder">Powder</label><select class="in" id="f-powder">${opts(act(S.powders, g0 && src.powderId), src.powderId, (x) => x.name)}</select></div>
    <div class="grid2">${fld('f-charge', 'Charge (gn)', src.charge)}${fld('f-coal', 'COAL (in)', src.coal)}</div>
    <div class="f"><label class="lbl" for="f-primer">Primer</label><select class="in" id="f-primer">${opts(act(S.primers, g0 && src.primerId), src.primerId, (x) => x.name)}</select></div>
    <div class="f"><label class="lbl" for="f-case">Case · optional</label><select class="in" id="f-case">${opts(casesFor(rid, caseSel), caseSel, (x) => x.name, '— none —')}</select>${casesFor(rid, caseSel).length < act(S.cases, caseSel).length ? '<div class="muted"><label style="text-decoration:underline"><input type="checkbox" id="f-allcase"> show all cases</label></div>' : ''}</div>
    ${fld('f-dist', 'Distance (yards)', fin(src.distance) ? src.distance : 25)}
    ${sec('GROUP')}
    ${fld('f-size', 'Group size (manual, outside-to-outside)', g0 && fin(g0.groupSize) ? g0.groupSize : '')}
    <div class="muted">One number in inches, measured at the distance above. Optional.</div>
    ${sec('FLAGS')}
    <div class="grid2"><div class="f"><span class="lbl">Include in analysis</span>${yn('inc', g0 ? g0.include !== false : true)}</div>
    <div class="f"><span class="lbl">Reference group</span>${yn('ref', g0 ? !!g0.reference : false)}</div></div>
    ${fld('f-notes', 'Notes', g0 ? g0.notes : '', '')}
    ${issueFields(g0)}
    ${sec('SHOTS')}
    ${fld('f-nshots', 'Shots fired', n0)}
    <div class="muted">One velocity box per shot. Leave a box blank if the chronograph missed it: it still counts as a shot.</div>
    <table class="shots"><thead><tr><th></th><th>Velocity fps</th></tr></thead><tbody id="shots" data-kind="v">${Array.from({ length: n0 }, (_, i) => vRow(i, vals[i])).join('')}</tbody></table>
    <div class="card" id="preview"></div>
    <button class="btn pri" type="submit" ${missing ? 'disabled' : ''}>Save group</button></form>`);
  const count = () => { const n = num($('#f-nshots').value); return n !== null && n >= 1 ? Math.min(30, Math.round(n)) : 0; };
  const shotsNow = () => Array.from({ length: count() }, (_, i) => ({ v: num(vals[i]) }));
  const pv = () => {
    const box = $('#preview'); if (!box) return;
    const s = gstats({ bulletId: $('#f-bullet').value, shots: shotsNow() }), size = num($('#f-size').value), d = num($('#f-dist').value);
    box.innerHTML = `<div class="lbl">Live preview</div><div class="grid3">
      <div><div class="lbl">Avg vel</div><span class="mono v">${fin(s.vavg) ? s.vavg.toFixed(0) : '—'}</span></div>
      <div><div class="lbl">Vel SD</div><span class="mono v">${fmt(s.vsd, 1)}</span></div>
      <div><div class="lbl">Vel ES</div><span class="mono v">${fmt(s.ves, 0)}</span></div></div>
      <div class="muted">${s.total} shot${s.total === 1 ? '' : 's'} · ${s.vn} with a velocity reading · size ${fmt(size, 2)}" = ${fmt(moa(size, d), 2)} MOA</div>`;
    issueWarn(rid, gid);
  };
  const form = $('#gform');
  form.addEventListener('input', (e) => {
    if (e.target.classList.contains('sv')) vals[Number(e.target.closest('tr').dataset.i)] = e.target.value.trim();
    else if (e.target.id === 'f-nshots') { const n = count(); if (n) $('#shots').innerHTML = Array.from({ length: n }, (_, i) => vRow(i, vals[i])).join(''); }
    pv();
  });
  form.addEventListener('change', (e) => {
    if (e.target.id === 'f-allcal') {
      const cur = $('#f-bullet').value;
      $('#f-bullet').innerHTML = opts(e.target.checked ? act(S.bullets, cur) : bulletsFor(rid, cur), cur, bLabel);
    }
    if (e.target.id === 'f-allcase') { // temporarily show every case, keeping the current pick
      const cur = $('#f-case').value;
      $('#f-case').innerHTML = opts(e.target.checked ? act(S.cases, cur) : casesFor(rid, cur), cur, (x) => x.name, '— none —');
    }
    issueSync();
    pv();
  });
  form.onsubmit = (e) => { e.preventDefault(); saveGroupPistol(rid, gid, g0, shotsNow()); };
  issueSync();
  pv();
}
async function saveGroupPistol(rid, gid, g0, shots) {
  const sessionId = $('#f-session').value;
  if (!byId('sessions', sessionId)) return toast('Pick a session');
  const charge = num($('#f-charge').value), coal = num($('#f-coal').value), distance = num($('#f-dist').value), size = num($('#f-size').value);
  if (charge === null) return toast('Charge weight is required');
  if (coal === null || coal <= 0) return toast('COAL is required for a pistol');
  if (distance === null || distance <= 0) return toast('Distance in yards is required');
  if (size !== null && size <= 0) return toast('Group size must be more than 0');
  if (!shots.length) return toast('Shots fired must be at least 1');
  const g = {
    id: gid || uid(), rifleId: rid, sessionId,
    ts: g0 && g0.sessionId === sessionId ? g0.ts : Date.now(),
    bulletId: $('#f-bullet').value, powderId: $('#f-powder').value, primerId: $('#f-primer').value,
    charge, coal, distance, groupSize: size,
    ...issueRead(), include: issueRead().issue ? false : $('input[name=inc]:checked').value === '1', reference: $('input[name=ref]:checked').value === '1',
    caseId: ($('#f-case') && $('#f-case').value) || '', notes: $('#f-notes').value.trim(), shots
  };
  if (!g.bulletId || !g.powderId || !g.primerId) return toast('Pick bullet, powder and primer');
  await put('groups', g);
  requestPersist(); // ask the browser to keep this data (some browsers only grant it after real use)
  if (g0 && navIdx > 0) history.back();
  else navTo('#/group/' + g.id, true);
}

function viewGroupForm(rid, gid, fromId, sid) {
  const r = byId('rifles', rid);
  if (!r) return viewHome();
  if (isPistol(rid)) return viewGroupFormPistol(rid, gid, fromId, sid);
  const g0 = gid ? byId('groups', gid) : null;
  const src = g0 || (fromId && byId('groups', fromId)) || S.groups.filter((g) => g.rifleId === rid).sort((a, b) => b.ts - a.ts)[0] || {};
  const missing = !act(S.bullets).length || !act(S.powders).length || !act(S.primers).length;
  bar(back(g0 ? '#/group/' + gid : '#/session/' + sid, g0 ? 'Group' : 'Session'), g0 ? 'Edit Group' : 'New Group', '', rid);
  const curSid = g0 ? g0.sessionId : sid;
  const sessOpts = sessionsOf(rid).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts)
    .map((x) => `<option value="${x.id}"${x.id === curSid ? ' selected' : ''}>${esc(sessionLabel(x))} · ${fin(x.fouling) ? x.fouling : 0} fouling</option>`).join('');
  const bLabel = (x) => x.name + (fin(x.weight) ? ' ' + x.weight + ' gn' : '');
  const filtered = bulletsFor(rid, g0 && src.bulletId);
  const caseSel = g0 ? (g0.caseId || '') : (casesFor(rid).some((c) => c.id === lastCase(rid)) ? lastCase(rid) : ''); // new group: the case last used on this firearm, only if it passes the caliber filter
  const nShots = g0 ? g0.shots.length : 5;
  const sec = (t) => `<h2 style="color:var(--accent-text);border-color:var(--accent-text)">${t}</h2>`;
  const fld = (id, label, val, cls = 'm', extra = '') => `<div class="f"><label class="lbl" for="${id}">${label}</label><input class="in ${cls}" id="${id}" type="text" ${cls === 'm' ? 'inputmode="decimal"' : ''} value="${esc(val ?? '')}" autocomplete="off" ${extra}></div>`;
  const yn = (name, on) => `<div class="seg"><label><input type="radio" name="${name}" value="1"${on ? ' checked' : ''}><span>Y</span></label><label><input type="radio" name="${name}" value="0"${on ? '' : ' checked'}><span>N</span></label></div>`;
  main(`${missing ? '<div class="card warn">Add at least one Bullet, Powder and Primer in <a href="#/components" style="text-decoration:underline">Components</a> first.</div>' : ''}
    <form id="gform" autocomplete="off">
    ${sec('SESSION')}
    <div class="f"><label class="lbl" for="f-session">Session</label><select class="in" id="f-session">${sessOpts}</select></div>
    <div class="muted">Date, wind, temp and fouling shots belong to the session. Change them with Edit session on the firearm or group page.</div>
    ${sec('LOAD')}
    <div class="f"><label class="lbl" for="f-bullet">Bullet</label><select class="in" id="f-bullet">${opts(filtered, src.bulletId, bLabel)}</select>
    ${r.caliberId ? `<div class="muted">Showing ${esc(calName(r.caliberId))} bullets (and any with no caliber set).${filtered.length < act(S.bullets, g0 && src.bulletId).length ? ' <label style="text-decoration:underline"><input type="checkbox" id="f-allcal"> show all bullets</label>' : ''}</div>`
      : '<div class="muted">Set this firearm\'s caliber (firearm → Edit) to filter bullets automatically.</div>'}</div>
    <div class="f"><label class="lbl" for="f-powder">Powder</label><select class="in" id="f-powder">${opts(act(S.powders, g0 && src.powderId), src.powderId, (x) => x.name)}</select></div>
    <div class="grid2">${fld('f-charge', 'Charge (gn)', src.charge)}${fld('f-jump', 'Jump (thou off lands)', src.jump)}</div>
    ${fld('f-dist', 'Distance (yards)', fin(src.distance) ? src.distance : 100)}
    <div class="f"><label class="lbl" for="f-primer">Primer</label><select class="in" id="f-primer">${opts(act(S.primers, g0 && src.primerId), src.primerId, (x) => x.name)}</select></div>
    <div class="f"><label class="lbl" for="f-case">Case · optional</label><select class="in" id="f-case">${opts(casesFor(rid, caseSel), caseSel, (x) => x.name, '— none —')}</select>${casesFor(rid, caseSel).length < act(S.cases, caseSel).length ? '<div class="muted"><label style="text-decoration:underline"><input type="checkbox" id="f-allcase"> show all cases</label></div>' : ''}</div>
    <div class="grid2">${fld('f-coal', 'COAL (in) · optional', src.coal)}${fld('f-trim', 'Trimmed case (in) · opt.', src.trim)}</div>
    ${sec('FLAGS')}
    <div class="grid2"><div class="f"><span class="lbl">Include in analysis</span>${yn('inc', g0 ? g0.include !== false : true)}</div>
    <div class="f"><span class="lbl">Reference group</span>${yn('ref', g0 ? !!g0.reference : false)}</div></div>
    ${fld('f-notes', 'Notes', g0 ? g0.notes : '', '')}
    ${issueFields(g0)}
    ${sec('SHOTS · X / Y INCHES FROM POINT OF AIM')}
    <div class="muted">Velocity optional per shot. Blank rows are ignored. Tap ± to flip sign. +Y is up, +X is right.</div>
    <table class="shots"><thead><tr><th></th><th>Vel fps</th><th>X in</th><th>Y in</th></tr></thead><tbody id="shots">
    ${Array.from({ length: nShots }, (_, i) => shotRow(i, g0 ? g0.shots[i] : {})).join('')}</tbody></table>
    <div class="grid2"><button type="button" class="btn sm" data-act="add-shot">+ Add shot</button><button type="button" class="btn sm" data-act="rm-shot">− Remove last</button></div>
    ${fld('f-esm', 'Extreme spread, manual caliper (in) · optional', g0 ? g0.esManual : '')}
    <div class="card" id="preview"></div>
    <button class="btn pri" type="submit" ${missing ? 'disabled' : ''}>Save group</button></form>`);
  const form = $('#gform');
  form.addEventListener('input', () => { preview(); issueWarn(rid, gid); });
  form.addEventListener('change', (e) => {
    if (e.target.id === 'f-allcal') { // temporarily show bullets of every caliber, keeping the current pick
      const cur = $('#f-bullet').value;
      $('#f-bullet').innerHTML = opts(e.target.checked ? act(S.bullets, cur) : bulletsFor(rid, cur), cur, bLabel);
    }
    if (e.target.id === 'f-allcase') { // temporarily show every case, keeping the current pick
      const cur = $('#f-case').value;
      $('#f-case').innerHTML = opts(e.target.checked ? act(S.cases, cur) : casesFor(rid, cur), cur, (x) => x.name, '— none —');
    }
    issueSync();
    preview();
    issueWarn(rid, gid);
  });
  form.onsubmit = (e) => { e.preventDefault(); saveGroup(rid, gid, g0); };
  issueSync();
  preview();
  issueWarn(rid, gid);
}

function readShots() {
  return $$('#shots tr').map((tr) => ({ v: num($('.sv', tr).value), x: num($('.sx', tr).value), y: num($('.sy', tr).value) }))
    .filter((s) => s.v !== null || s.x !== null || s.y !== null);
}
function preview() {
  const box = $('#preview'); if (!box) return;
  const g = { bulletId: $('#f-bullet').value, shots: readShots() };
  const s = gstats(g);
  box.innerHTML = `<div class="lbl">Live preview</div><div class="grid3">
    <div><div class="lbl">Mean rad</div><span class="mono v">${fmt(s.mr)}"</span></div>
    <div><div class="lbl">ES ctr</div><span class="mono v">${fmt(s.es)}"</span></div>
    <div><div class="lbl">Avg vel</div><span class="mono v">${fin(s.vavg) ? s.vavg.toFixed(0) : '—'}</span></div></div>
    <div class="grid3"><div><div class="lbl">MR MOA</div><span class="mono v">${fmt(moa(s.mr, num($('#f-dist').value)), 2)}</span></div>
    <div><div class="lbl">ES MOA</div><span class="mono v">${fmt(moa(s.es, num($('#f-dist').value)), 2)}</span></div></div>
    <div class="muted">${s.n} shot${s.n === 1 ? '' : 's'} with X/Y · ${s.vn} with velocity${s.n === 1 ? ' · mean radius needs 2+ shots' : ''}</div>`;
}
async function saveGroup(rid, gid, g0) {
  const sessionId = $('#f-session').value;
  if (!byId('sessions', sessionId)) return toast('Pick a session');
  const charge = num($('#f-charge').value), jump = num($('#f-jump').value);
  if (charge === null) return toast('Charge weight is required');
  if (jump === null) return toast('Jump / seating depth is required');
  const distance = num($('#f-dist').value);
  if (distance === null || distance <= 0) return toast('Distance in yards is required');
  const shots = readShots();
  if (!shots.length) return toast('Enter at least one shot');
  const g = {
    id: gid || uid(), rifleId: rid, sessionId,
    // moving a group to another session puts it last there; otherwise it keeps its place in the order
    ts: g0 && g0.sessionId === sessionId ? g0.ts : Date.now(),
    bulletId: $('#f-bullet').value, powderId: $('#f-powder').value, primerId: $('#f-primer').value,
    charge, jump, distance, coal: num($('#f-coal').value), trim: num($('#f-trim').value),
    ...issueRead(), include: issueRead().issue ? false : $('input[name=inc]:checked').value === '1', reference: $('input[name=ref]:checked').value === '1',
    caseId: ($('#f-case') && $('#f-case').value) || '', notes: $('#f-notes').value.trim(), esManual: num($('#f-esm').value), shots
  };
  if (!g.bulletId || !g.powderId || !g.primerId) return toast('Pick bullet, powder and primer');
  await put('groups', g);
  requestPersist(); // ask the browser to keep this data (some browsers only grant it after real use)
  if (g0 && navIdx > 0) history.back(); // editing: return to the group page we came from (re-rendered with the new numbers)
  else navTo('#/group/' + g.id, true);
}
async function deleteGroup(id) {
  const g = byId('groups', id);
  if (!g || !confirm('Delete this group? This cannot be undone.')) return;
  await del('groups', id);
  navTo('#/rifle/' + g.rifleId, true); // the deleted group's page must not stay in history
}

/* ---------- sessions ---------- */
function sessionForm(rid, se) {
  formDialog(se ? 'Edit session' : 'New session', [
    { k: 'date', label: 'Date (YYYY-MM-DD)', req: true },
    { k: 'fouling', label: 'Fouling shots this session', type: 'num' },
    { k: 'temp', label: 'Temp (F)', type: 'num' },
    { k: 'wind', label: 'Wind / conditions' }
  ], se ? { ...se } : { date: today(), fouling: 0 }, async (v) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) { toast('Date must be YYYY-MM-DD'); throw new Error('bad date'); }
    const s = { ...(se || { id: uid(), rifleId: rid, ts: Date.now() }), date: v.date, fouling: v.fouling ?? 0, temp: v.temp, wind: v.wind };
    await put('sessions', s);
    if (!se) location.hash = '#/add/' + s.id; // straight into the first group
  }, se ? async () => {
    const n = groupsOf(se.id).length;
    if (!confirm(`Delete this session${n ? ` and its ${n} group${n === 1 ? '' : 's'}` : ''}? This cannot be undone.`)) return false;
    for (const g of groupsOf(se.id)) await del('groups', g.id);
    await del('sessions', se.id);
    return true;
  } : null);
}

function viewSettings() {
  bar(back('#/', 'Firearms', true), 'Settings');
  const lib = (title, s, sub) => `<h2 class="row sb" style="align-items:center">${title}<button class="btn sm" data-act="lib-new" data-s="${s}">+ Add</button></h2>
    ${S[s].filter((x) => !x.archived).sort((a, b) => a.name.localeCompare(b.name)).map((x) => `<div class="item" role="button" tabindex="0" data-act="lib-edit" data-s="${s}" data-id="${x.id}"><div>${esc(x.name)}${sub(x) ? `<small>${esc(sub(x))}</small>` : ''}</div><span class="muted">Edit</span></div>`).join('') || '<div class="muted">None yet.</div>'}`;
  main(`<h1>Settings</h1>
    ${lib('CALIBERS', 'calibers', () => '')}
    <div class="muted" style="margin-top:-4px">Add a caliber once (e.g. ".308 Win"), then pick it on each firearm and each bullet. A firearm only offers bullets of its own caliber.</div>
    ${lib('FIREARMS', 'rifles', (x) => `${calName(x.caliberId) || 'no caliber'}${x.barrel ? ' · ' + x.barrel + ' in' : ''} · start ${x.startRounds || 0} rds`).replace('data-act="lib-new" data-s="rifles"', 'data-act="new-rifle"')}
    <div class="muted">Bullets, powders, primers and cases are on the <a href="#/components" style="text-decoration:underline">Components</a> page.</div>
    <h2>APPEARANCE</h2>
    <div class="grid3">${[['light', 'Light'], ['dark', 'Dark'], ['auto', 'Auto']].map(([v, l]) => `<button class="btn ${themePref() === v ? 'pri' : ''}" data-act="theme" data-v="${v}" aria-pressed="${themePref() === v}">${l}</button>`).join('')}</div>
    <div class="lbl">Accent color</div>
    <div class="grid3">${[['green', 'Green', '#3f5b2e'], ['blue', 'Blue', '#0b4f9c'], ['orange', 'Orange', '#c2560c']].map(([v, l, c]) => `<button class="btn ${accentPref() === v ? 'pri' : ''}" data-act="accent" data-v="${v}" aria-pressed="${accentPref() === v}"><span class="swatch" style="background:${c}"></span>${l}</button>`).join('')}</div>
    <div class="muted">Auto follows your phone's light or dark setting. Theme and accent are saved on this device only.</div>
    <h2>COST</h2>
    <div class="grid2"><div class="f"><label class="lbl" for="cost-tax">Tax rate (%)</label><input class="in m" id="cost-tax" inputmode="decimal" value="${taxPct()}"></div>
    <div class="f"><label class="lbl" for="cost-cur">Currency label</label><input class="in" id="cost-cur" value="${esc(curLabel())}" maxlength="6"></div></div>
    <div class="muted">Applies to every price you enter on the Components page (prices are before tax). The label is display only. Changing a price or the tax rate changes every load's cost everywhere, and no price history is kept.</div>
    <h2>INVENTORY</h2>
    <div class="f"><label class="lbl" for="inv-low">Warn below this many rounds of a firearm's best load</label><input class="in m" id="inv-low" inputmode="numeric" value="${lowLimit()}"></div>
    <div class="muted">A bullet, primer or powder that can no longer make this many rounds of a firearm's Current Best Load shows yellow on Components and on that firearm's page. 0 turns it off. Brass is never checked, and a firearm with no best load yet is skipped.</div>
    <h2>PREFERENCES</h2>
    <div class="f"><label class="lbl" for="pref-dist">Main-screen best load distance (yards)</label><input class="in m" id="pref-dist" inputmode="numeric" value="${bestDist()}"></div>
    <div class="muted">The firearm page shows the best rifle load at this distance. Every distance is on the Best Loads page.</div>
    <h2>BACKUP</h2>
    <div class="muted">Data lives only on this device. Export a JSON file to back up or move it to another device.</div>
    <div class="grid2"><button class="btn dark" data-act="export">Export data</button><button class="btn dark" data-act="share">Share backup</button></div>
    <button class="btn" data-act="import">Import data</button>
    <div class="muted">Share backup opens your phone's share sheet (email, Files, a cloud drive). Sharing can't confirm the file arrived: the reminder resets when you finish the share sheet, not when the file is delivered. Cancelling it changes nothing. Where sharing files isn't available it downloads instead.</div>
    <div class="muted" id="share-diag">${esc((() => { const w = shareSupport(new File(['{}'], 'x.json', { type: 'application/json' })); return w ? 'File sharing on this device: not available (' + w + ').' : 'File sharing on this device: available.'; })())}</div>
    <div class="muted">${S.cfg.lastBackup ? 'Last backup: ' + new Date(S.cfg.lastBackup).toLocaleString() : 'No backup made yet.'}</div>
    <div class="lbl" style="margin-top:6px">Remind me after</div>
    <div class="grid2"><div class="f"><label class="lbl" for="bk-days">Days</label><input class="in m" id="bk-days" inputmode="numeric" value="${S.cfg.days}"></div>
    <div class="f"><label class="lbl" for="bk-groups">New groups</label><input class="in m" id="bk-groups" inputmode="numeric" value="${S.cfg.groups}"></div></div>
    <div class="muted">Whichever comes first. Set either to 0 to turn that trigger off.</div>
    <input type="file" id="imp" accept="application/json,.json" hidden>
    <div class="muted" id="persist"></div>
    <h2>ABOUT</h2>
    <div class="muted" id="ver">App version ${APP_VERSION}</div>`);
  $('#imp').onchange = (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; };
  // which copy this browser is really running, and whether a newer one is already downloaded and waiting
  (async () => {
    const el = $('#ver'); if (!el) return;
    let line = `App version ${APP_VERSION}`;
    try {
      const names = (await caches.keys()).filter((k) => k.startsWith('loaddev-')).sort();
      line += names.length ? ` · cached copy: ${names.join(', ')}` : ' · no offline copy saved yet';
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg && reg.waiting) line += ' · a newer version is downloaded and waiting: use "Reload & update", or close every tab of the app and reopen it';
    } catch (e) { /* version still shown */ }
    if ($('#ver')) $('#ver').textContent = line;
  })();
  if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then((p) => { const el = $('#persist'); if (el) el.textContent = p ? 'Storage: persistent.' : 'Storage: browser-managed. Export backups occasionally.'; });
}

const LIBS = {
  bullets: [{ k: 'name', label: 'Manufacturer / name', req: true },
    { k: 'caliberId', label: 'Caliber (add calibers in Settings)', type: 'select', opts: [] },
    { k: 'style', label: 'Style (bullet shape)', list: ['BTHP', 'BT', 'SP', 'SPBT', 'FMJ', 'FMJBT', 'HP', 'RN', 'SWC', 'Hybrid'] },
    { k: 'weight', label: 'Weight (gn)', type: 'num' }, { k: 'diameter', label: 'Diameter (in)', type: 'num', req: true },
    { k: 'price', label: 'Price ($, before tax) · optional', type: 'num' }, { k: 'qty', label: 'Quantity in the box', type: 'num' }, { k: 'ship', label: 'Shipping and fees for this purchase ($)', type: 'num' }],
  calibers: [{ k: 'name', label: 'Caliber name (e.g. .308 Win, 7mm Rem Mag, .45 ACP)', req: true }],
  powders: [{ k: 'name', label: 'Name', req: true },
    { k: 'price', label: 'Price ($, before tax) · optional', type: 'num' }, { k: 'pkg', label: 'Package size', type: 'num' }, { k: 'unit', label: 'Package unit', type: 'select', opts: [['lb', 'lb'], ['kg', 'kg']] }, { k: 'ship', label: 'Shipping and fees for this purchase ($)', type: 'num' }],
  primers: [{ k: 'name', label: 'Brand / name', req: true },
    { k: 'type', label: 'Type', list: ['Large Rifle', 'Large Rifle Magnum', 'Small Rifle', 'Small Rifle Magnum', 'Large Pistol', 'Large Pistol Magnum', 'Small Pistol', 'Small Pistol Magnum'] },
    { k: 'price', label: 'Price ($, before tax) · optional', type: 'num' }, { k: 'qty', label: 'Quantity in the box', type: 'num' }, { k: 'ship', label: 'Shipping and fees for this purchase ($)', type: 'num' }],
  cases: [{ k: 'name', label: 'Manufacturer / name', req: true }, { k: 'caliberIds', label: 'Calibers (optional, pick any)', type: 'multi', opts: [], empty: 'Add calibers in Settings to tag cases.' },
    { k: 'price', label: 'Price ($, before tax) · optional (0 = free brass)', type: 'num' }, { k: 'qty', label: 'Quantity', type: 'num' }, { k: 'loads', label: 'Expected loads per case (blank = 10)', type: 'num' }, { k: 'ship', label: 'Shipping and fees for this purchase ($)', type: 'num' }]
};
const LIB_ONE = { calibers: 'caliber', bullets: 'bullet', powders: 'powder', primers: 'primer', cases: 'case' };
function libForm(s, x) { // deleting bullets, powders, primers and cases happens on the item's page (libDelete); only calibers delete from here
  formDialog((x ? 'Edit ' : 'Add ') + LIB_ONE[s], LIBS[s].map((f) => (f.k === 'caliberId' ? { ...f, opts: calOpts() } : f.k === 'caliberIds' ? { ...f, opts: calOpts().filter((o) => o[0]) } : f)), x || (s === 'bullets' ? { diameter: 0.308 } : s === 'cases' ? { loads: 10 } : {}), async (v) => { await put(s, { ...(x || { id: uid() }), ...v }); },
    x && s === 'calibers' ? async () => {
      // blocked while anything uses it; the message says what
      const nF = S.rifles.filter((r) => r.caliberId === x.id).length, nB = S.bullets.filter((b) => b.caliberId === x.id).length, nC = S.cases.filter((c) => (c.caliberIds || []).includes(x.id)).length;
      if (nF || nB || nC) {
        toast('In use by ' + [nF && `${nF} firearm${nF === 1 ? '' : 's'}`, nB && `${nB} bullet${nB === 1 ? '' : 's'}`, nC && `${nC} case${nC === 1 ? '' : 's'}`].filter(Boolean).join(', ') + ' — remove it there first');
        return false;
      }
      if (!confirm('Delete this item?')) return false;
      await del(s, x.id); return true;
    } : null, ['bullets', 'powders', 'primers', 'cases'].includes(s) ? (v) => costLive(s, v) : null);
}

/* ---------- router & events ---------- */
function render() {
  const mn = $('#menu'); if (mn) mn.hidden = true; // any navigation closes the hamburger menu
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const p = path.split('/').filter(Boolean);
  const q = new URLSearchParams(qs || '');
  try {
    if (!p.length) viewHome();
    else if (p[0] === 'rifle') viewRifle(p[1]);
    else if (p[0] === 'all') viewAll(p[1]);
    else if (p[0] === 'tools') { if (p[1] === 'crimp') viewCrimp(); else if (p[1] === 'loadcheck') viewLoadCheck(); else if (p[1] === 'cost') viewCostCalc(); else viewTools(); }
    else if (p[0] === 'components') { if (p[1] === 'item') viewComponentItem(p[2], p[3]); else if (p[1] === 'batch') viewBatch(); else if (p[1] === 'history') viewInvHistory(); else viewComponents(); }
    else if (p[0] === 'archive') viewArchive();
    else if (p[0] === 'issues') viewIssues(p[1]);
    else if (p[0] === 'best') viewBest(p[1]);
    else if (p[0] === 'load') viewLoad(p[1]);
    else if (p[0] === 'sessions') viewSessions(p[1]);
    else if (p[0] === 'session') { viewSession(p[1], q.get('g')); const h = $('.hl'); if (h) h.scrollIntoView({ block: 'center' }); }
    else if (p[0] === 'combo') viewCombo(p[1], decodeURIComponent(p[2] || ''));
    else if (p[0] === 'add') {
      let se = byId('sessions', p[1]); // #/add/<sessionId>; a rifle id means "latest session"
      if (!se && byId('rifles', p[1])) se = latestSession(p[1]);
      const arid = se ? se.rifleId : p[1];
      if (isArch(arid)) { navTo('#/rifle/' + arid, true); toast('Archived firearm: restore it to add or edit'); }
      else if (se) viewGroupForm(se.rifleId, null, q.get('from'), se.id);
      else if (byId('rifles', p[1])) { navTo('#/rifle/' + p[1], true); toast('Start a session first'); }
      else viewHome();
    }
    else if (p[0] === 'edit') { const g = byId('groups', p[1]); if (g && isArch(g.rifleId)) { navTo('#/group/' + g.id, true); toast('Archived firearm: restore it to add or edit'); } else if (g) viewGroupForm(g.rifleId, g.id); else viewHome(); }
    else if (p[0] === 'group') viewGroup(p[1]);
    else if (p[0] === 'settings') viewSettings();
    else viewHome();
  } catch (e) { console.error(e); main(`<div class="card"><b>Something went wrong showing this page.</b><div class="muted">${esc(e.message)}</div></div><a class="btn" href="#/">Home</a>`); }
  renderBanners();
}

/* ---------- banners: app update + backup reminder ---------- */
let updateWorker = null; // a new service worker that is installed and waiting
function backupDue() {
  const c = S.cfg;
  if (!S.groups.length || Date.now() < (c.snooze || 0)) return null;
  if (!c.lastBackup) return 'You have data on this device but have never backed it up.';
  const days = (Date.now() - c.lastBackup) / 864e5;
  const fresh = S.groups.filter((g) => g.ts > c.lastBackup).length;
  if (c.days > 0 && days >= c.days) return `Last backup was ${Math.floor(days)} days ago.`;
  if (c.groups > 0 && fresh >= c.groups) return `${fresh} groups logged since your last backup.`;
  return null;
}
function renderBanners() {
  const box = $('#banners');
  if (!box) return;
  const onForm = /^#\/(add|edit)\//.test(location.hash); // never nag mid-entry
  const due = onForm ? null : backupDue();
  box.innerHTML = (updateWorker ? `<div class="banner"><span>Update available</span><button class="btn sm dark" data-act="apply-update">Reload &amp; update</button></div>` : '')
    + (due ? `<div class="banner warnb"><span>${esc(due)} Back up now.</span><button class="btn sm dark" data-act="export">Backup Now</button><button class="btn sm dark" data-act="share">Share</button><button class="btn sm" data-act="snooze">Later</button></div>` : '');
}
function initUpdates() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const track = (w) => w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) { updateWorker = w; renderBanners(); } });
    if (reg.waiting && navigator.serviceWorker.controller) { updateWorker = reg.waiting; renderBanners(); }
    reg.addEventListener('updatefound', () => reg.installing && track(reg.installing));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    reg.update().catch(() => {});
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading && updateWorker) { reloading = true; location.reload(); } });
}
window.addEventListener('hashchange', () => { trackNav(); render(); });

document.addEventListener('click', (e) => {
  const up = e.target.closest('a[data-up]');
  if (up) { e.preventDefault(); goUp(up.getAttribute('href')); return; }
  const bk = e.target.closest('a[data-back]');
  if (bk && navIdx > 0) { e.preventDefault(); history.back(); return; }
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const a = t.dataset.act, id = t.dataset.id;
  if (a === 'new-rifle') rifleForm(null);
  else if (a === 'edit-rifle') { if (!viewOnly(id)) rifleForm(byId('rifles', id)); }
  else if (a === 'rifle-archive') setRifleArchived(id, true);
  else if (a === 'rifle-restore') setRifleArchived(id, false);
  else if (a === 'lib-new') libForm(t.dataset.s, null);
  else if (a === 'lib-edit') { if (t.dataset.s === 'rifles') { if (!viewOnly(id)) rifleForm(byId('rifles', id)); } else libForm(t.dataset.s, byId(t.dataset.s, id)); }
  else if (a === 'new-hist') { if (!viewOnly(id)) histForm(id, null); }
  else if (a === 'edit-hist') { if (!viewOnly(byId('hist', id).rifleId)) histForm(byId('hist', id).rifleId, byId('hist', id)); }
  else if (a === 'del-group') { if (!viewOnly((byId('groups', id) || {}).rifleId)) deleteGroup(id); }
  else if (a === 'theme') { try { localStorage.setItem('theme', t.dataset.v); } catch (err) { /* private mode: applies for this visit only */ } applyTheme(t.dataset.v); viewAllKeepScroll(); }
  else if (a === 'accent') { try { localStorage.setItem('accent', t.dataset.v); } catch (err) { /* private mode: applies for this visit only */ } applyTheme(themePref(), t.dataset.v); viewAllKeepScroll(); }
  else if (a === 'go') { if (!e.target.closest('a')) location.hash = t.dataset.href; }
  else if (a === 'la-sort') { LA.sort = t.dataset.v; viewAllKeepScroll(); }
  else if (a === 'is-tab') { IS.tab = t.dataset.v; viewAllKeepScroll(); }
  else if (a === 'cc-save') ccSave(t.dataset.v);
  else if (a === 'inv-add') invEventDialog(t.dataset.k, id, t.dataset.t);
  else if (a === 'inv-del-event') invDelEvent(id);
  else if (a === 'inv-del-batch') invDelBatch(id);
  else if (a === 'inv-consolidate') invConsolidate();
  else if (a === 'cm-sec') { CM = { ...CM, sec: t.dataset.v, q: '', cal: '' }; viewAllKeepScroll(); }
  else if (a === 'cm-archive') cmArchive(t.dataset.k, id, true);
  else if (a === 'cm-restore') cmArchive(t.dataset.k, id, false);
  else if (a === 'lib-delete') libDelete(t.dataset.k, id);
  else if (a === 'ib-save') ibConfirm();
  else if (a === 'set-case') { if (!viewOnly(id)) setCaseBulk(id); }
  else if (a === 'menu') { const m = $('#menu'); m.hidden = !m.hidden; t.setAttribute('aria-expanded', String(!m.hidden)); }
  else if (a === 'cr-pass') { CR.pass = Number(t.dataset.p); crSave(); viewAllKeepScroll(); window.scrollTo(0, 0); }
  else if (a === 'cr-n') {
    CR.n = Math.max(2, Math.min(20, CR.n + Number(t.dataset.v)));
    for (const key of Object.keys(CR.vals)) { const [pp, rr] = key.split('-').map(Number); if (pp > CR.n || rr > CR.n) delete CR.vals[key]; }
    CR.pass = Math.min(CR.pass, CR.n); crSave(); viewAllKeepScroll();
  }
  else if (a === 'cr-clear') { if (confirm('Clear all entered COAL values? Rounds and tolerance stay.')) { CR.vals = {}; CR.pass = 1; crSave(); render(); } }
  else if (a === 'new-session') { if (!viewOnly(id)) sessionForm(id, null); }
  else if (a === 'edit-session') { const se = byId('sessions', id); if (se && !viewOnly(se.rifleId)) sessionForm(se.rifleId, se); }
  else if (a === 'apply-update') { if (updateWorker) updateWorker.postMessage({ type: 'SKIP_WAITING' }); }
  else if (a === 'snooze') { S.cfg.snooze = Date.now() + 864e5; saveCfg(); renderBanners(); }
  else if (a === 'export') exportData();
  else if (a === 'share') shareBackup();
  else if (a === 'import') $('#imp').click();
  else if (a === 'add-shot') { const tb = $('#shots'); tb.insertAdjacentHTML('beforeend', shotRow(tb.rows.length)); $$('#shots tr:last-child .sv')[0].focus(); }
  else if (a === 'rm-shot') { const tb = $('#shots'); if (tb.rows.length > 1) { tb.deleteRow(-1); preview(); } }
  else if (a === 'sign') {
    const inp = t.previousElementSibling;
    const v = inp.value.trim();
    inp.value = v.startsWith('-') ? v.slice(1) : '-' + v;
    inp.focus(); preview();
  }
});
document.addEventListener('input', (e) => {
  if (e.target.classList && e.target.classList.contains('cr-in')) {
    const row = e.target.closest('.crrow');
    CR.vals[crKey(row.dataset.p, row.dataset.r)] = e.target.value.trim();
    crSave(); crRefresh();
  } else if (e.target.id && e.target.id.startsWith('ib-') && e.target.id !== 'ib-allcase' && e.target.id !== 'ib-deduct') { // Log loaded batch
    const id = e.target.id, v = e.target.value, sum = () => { const s = $('#ib-sum'); if (s) s.innerHTML = ibSummaryHtml(ibLines(), 'Summary'); };
    if (id === 'ib-rid') { IB.rid = v; IB.load = ''; IB.all = false; viewAllKeepScroll(); }
    else if (id === 'ib-load') {
      const g = v && S.groups.filter((x) => x.rifleId === IB.rid && [x.bulletId, x.powderId, Number(x.charge), x.primerId].join('|') === v).sort((a, b) => b.ts - a.ts)[0];
      const live = (s, id) => (id && byId(s, id) && !byId(s, id).archived ? id : ''); // an archived part is not filled in
      if (g) { IB.load = v; IB.bullet = live('bullets', g.bulletId); IB.powder = live('powders', g.powderId); IB.primer = live('primers', g.primerId); IB.charge = String(g.charge); IB.case = live('cases', g.caseId); viewAllKeepScroll(); }
    }
    else if (['ib-bullet', 'ib-powder', 'ib-primer', 'ib-case'].includes(id)) { IB[id.slice(3)] = v; sum(); }
    else if (['ib-charge', 'ib-rounds', 'ib-date'].includes(id)) { IB[id.slice(3)] = v.trim(); sum(); }
  } else if (e.target.id && e.target.id.startsWith('cc-') && e.target.id !== 'cc-allcase') { // Load cost calculator
    const id = e.target.id, v = e.target.value;
    if (id === 'cc-rid') { CC.rid = v; CC.all = false; viewAllKeepScroll(); }
    else if (id === 'cc-fill') {
      const g = v && S.groups.filter((x) => x.rifleId === CC.rid && [x.bulletId, x.powderId, Number(x.charge), x.primerId].join('|') === v).sort((a, b) => b.ts - a.ts)[0];
      const live = (s, id) => (id && byId(s, id) && !byId(s, id).archived ? id : ''); // an archived part is not filled in
      if (g) { CC.bullet = live('bullets', g.bulletId); CC.powder = live('powders', g.powderId); CC.primer = live('primers', g.primerId); CC.charge = String(g.charge); CC.case = live('cases', g.caseId); viewAllKeepScroll(); }
    }
    else if (id === 'cc-charge') { CC.charge = v.trim(); const o = $('#cc-out'); if (o) o.innerHTML = ccResult(); }
    else if (id.startsWith('cc-m-')) { const [, , kind, field] = id.split('-'); CC.m[kind][field] = v.trim(); const o = $('#cc-out'); if (o) o.innerHTML = ccResult(); }
    else { const kind = id.slice(3); if (CC_STORE[kind]) { CC[kind] = v; viewAllKeepScroll(); } }
  } else if (e.target.id && e.target.id.startsWith('lc-')) { // Load check: patch the result in place so typing keeps focus
    LC[e.target.id.slice(3).replace('rid', 'rid')] = e.target.value.trim();
    if (e.target.id === 'lc-rid') viewAllKeepScroll(); else { const o = $('#lc-out'); if (o) o.innerHTML = lcResult(); }
  } else if (e.target.id === 'cm-q') { // Components search: patch the list in place so typing keeps focus
    CM.q = e.target.value; const l = $('#cm-list'); if (l) l.innerHTML = cmListHtml();
  } else if (e.target.id === 'cr-tol') {
    const v = num(e.target.value); CR.tol = v !== null && v >= 0 ? v : 0;
    crSave(); crRefresh();
  }
});
document.addEventListener('click', (e) => { // tap outside the hamburger menu closes it
  const m = $('#menu');
  if (m && !m.hidden && !e.target.closest('#menu') && !e.target.closest('[data-act=menu]')) { m.hidden = true; const b = $('[data-act=menu]'); if (b) b.setAttribute('aria-expanded', 'false'); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { const m = $('#menu'); if (m) m.hidden = true; }
  if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('cr-in')) { // Enter = next round's box
    e.preventDefault();
    const all = $$('.cr-in'), i = all.indexOf(e.target);
    (all[i + 1] || e.target).focus();
  }
});
document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.item[data-act]')) { e.preventDefault(); e.target.click(); } });
document.addEventListener('change', (e) => {
  const k = e.target.dataset && e.target.dataset.filter;
  if (k) { F[k] = e.target.value; viewAllKeepScroll(); }
  if (e.target.id === 'best-thin') { showThin = e.target.checked; viewAllKeepScroll(); }
  if (e.target.id === 'is-bullet') { IS.bullet = e.target.value; viewAllKeepScroll(); }
  if (e.target.id === 'is-cat') { IS.cat = e.target.value; viewAllKeepScroll(); }
  if (e.target.id === 'is-min') { IS.min = e.target.value.trim(); viewAllKeepScroll(); }
  if (e.target.id === 'is-max') { IS.max = e.target.value.trim(); viewAllKeepScroll(); }
  if (e.target.id === 'la-bullet') { LA.bullet = e.target.value; viewAllKeepScroll(); }
  if (e.target.id === 'la-powder') { LA.powder = e.target.value; viewAllKeepScroll(); }
  if (e.target.id === 'la-powderB') { LA.powderB = e.target.value; viewAllKeepScroll(); }
  if (e.target.id === 'la-compare') { LA.compare = e.target.checked; viewAllKeepScroll(); }
  if (e.target.id === 'la-ladderthin') { LA.ladderThin = e.target.checked; viewAllKeepScroll(); }
  if (e.target.id === 'cost-tax' || e.target.id === 'cost-cur') {
    const n = num($('#cost-tax').value), cur = $('#cost-cur').value.trim() || 'CAD';
    put('prefs', { id: 'cost', tax: n !== null && n >= 0 ? n : 12, currency: cur }).then(() => { $('#cost-tax').value = taxPct(); $('#cost-cur').value = curLabel(); });
  }
  if (e.target.id === 'cm-cal') { CM.cal = e.target.value; const l = $('#cm-list'); if (l) l.innerHTML = cmListHtml(); }
  if (e.target.id === 'cm-arch') { CM.arch = e.target.checked; const l = $('#cm-list'); if (l) l.innerHTML = cmListHtml(); }
  if (e.target.id === 'cc-allcase') { CC.all = e.target.checked; viewAllKeepScroll(); }
  if (e.target.id === 'ib-allcase') { IB.all = e.target.checked; viewAllKeepScroll(); }
  if (e.target.id === 'ib-deduct') { IB.deduct = e.target.checked; const s = $('#ib-sum'); if (s) s.innerHTML = ibSummaryHtml(ibLines(), 'Summary'); }
  if (e.target.id === 'inv-low') { const n = num(e.target.value); put('prefs', { id: 'inv', low: n !== null && n >= 0 ? Math.round(n) : 200 }).then(() => { e.target.value = lowLimit(); }); }
  if (e.target.id === 'pref-dist') {
    const n = num(e.target.value);
    S.cfg.bestDist = n !== null && n > 0 ? Math.round(n) : 100;
    e.target.value = S.cfg.bestDist;
    saveCfg();
  }
  if (e.target.id === 'bk-days' || e.target.id === 'bk-groups') {
    const n = num(e.target.value);
    S.cfg[e.target.id === 'bk-days' ? 'days' : 'groups'] = n !== null && n >= 0 ? Math.round(n) : (e.target.id === 'bk-days' ? 7 : 10);
    e.target.value = S.cfg[e.target.id === 'bk-days' ? 'days' : 'groups'];
    saveCfg(); renderBanners();
  }
});
function viewAllKeepScroll() { const y = window.scrollY; render(); window.scrollTo(0, y); }

/* Ask the browser to keep this data safe from clean-up. Called at startup and again after each group save (some browsers only
   grant it after real use). If a request is refused it is not repeated during the same visit, so there are no repeated prompts. */
let persistRefused = false;
function requestPersist() {
  if (persistRefused || !(navigator.storage && navigator.storage.persist && navigator.storage.persisted)) return;
  navigator.storage.persisted().then((p) => (p ? true : navigator.storage.persist())).then((ok) => { if (!ok) persistRefused = true; }).catch(() => {});
}
(async function init() {
  try {
    db = await openDB();
    await loadAll();
    await migrate();
    requestPersist();
  } catch (e) {
    main(`<div class="card"><b>Storage unavailable.</b><div class="muted">${esc(e.message)}. This app needs IndexedDB (not private-browsing mode).</div></div>`);
    return;
  }
  initNav();
  render();
  initUpdates();
})();
