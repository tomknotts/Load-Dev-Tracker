'use strict';
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
const STORES = ['rifles', 'calibers', 'bullets', 'powders', 'primers', 'cases', 'sessions', 'groups', 'hist']; // exported / imported
const ALL_STORES = [...STORES, 'meta']; // meta = per-device settings (backup reminder), never exported
let db;
const S = {};
const rp = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const store = (s, m) => db.transaction(s, m).objectStore(s);
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('loadtracker', 3);
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

async function exportData() {
  const data = {};
  for (const s of STORES) data[s] = S[s];
  const blob = new Blob([JSON.stringify({ app: '308-load-dev-tracker', version: 2, exported: new Date().toISOString(), data }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `load-dev-backup-${today()}.json`;
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
const ckey = (g) => [g.bulletId, g.powderId, Number(g.charge), g.primerId, Number(g.jump), Number(g.distance)].join('|');
function combos(groups) {
  const m = new Map();
  for (const g of groups) {
    if (g.include === false) continue;
    if (!m.has(ckey(g))) m.set(ckey(g), { key: ckey(g), bulletId: g.bulletId, powderId: g.powderId, charge: g.charge, primerId: g.primerId, jump: g.jump, distance: g.distance, groups: [] });
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
      vel: vn ? vs.reduce((a, s) => a + s.vavg * s.vn, 0) / vn : null
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
const comboLabel = (c) => `${bl(c.bulletId)} · ${nm('powders', c.powderId)} ${c.charge} gn · ${nm('primers', c.primerId)} · ${c.jump} thou · ${c.distance} yd`;

/* ---------- UI plumbing ---------- */
// With rid, the middle of the bar shows the rifle name (tap = that rifle's main page) and the page name underneath.
const bar = (left, title, right = '', rid = null) => {
  const r = rid && byId('rifles', rid);
  const mid = r ? `<a class="t" href="#/rifle/${rid}"><span class="n">${esc(r.name)}</span><small>${esc(title)}</small></a>` : `<div class="t">${esc(title)}</div>`;
  $('#bar').innerHTML = `${left || '<span style="min-width:64px"></span>'}${mid}${right || '<span style="min-width:64px"></span>'}`;
};
const main = (h) => { $('#main').innerHTML = h; window.scrollTo(0, 0); };
const back = (href, label) => `<a href="${href}">← ${esc(label)}</a>`;
const opts = (list, sel, lab, blank) => (blank ? `<option value="">${esc(blank)}</option>` : '') + list.map((x) => `<option value="${esc(x.id)}"${x.id === sel ? ' selected' : ''}>${esc(lab(x))}</option>`).join('');
let F = { rid: null, powder: '', bullet: '', primer: '', charge: '', jump: '' };

function formDialog(title, fields, vals, onSave, onDelete) {
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog"><h1 style="font-size:22px">${esc(title)}</h1>
    ${fields.map((f) => `<div class="f"><label class="lbl" for="d-${f.k}">${esc(f.label)}</label>${
      f.type === 'select'
        ? `<select class="in" id="d-${f.k}">${f.opts.map((o) => `<option value="${esc(o[0])}"${o[0] === vals[f.k] ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`
        : `<input class="in ${f.type === 'num' ? 'm' : ''}" id="d-${f.k}" type="text" ${f.type === 'num' ? 'inputmode="decimal"' : ''} ${f.list ? `list="dl-${f.k}"` : ''} value="${esc(vals[f.k] ?? '')}" autocomplete="off">${f.list ? `<datalist id="dl-${f.k}">${f.list.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>` : ''}`}</div>`).join('')}
    <div class="grid2"><button class="btn pri" value="ok">Save</button><button class="btn" value="cancel" type="button" id="d-x">Cancel</button></div>
    ${onDelete ? '<button class="btn danger sm" type="button" id="d-del">Delete</button>' : ''}</form>`;
  document.body.appendChild(d);
  const close = () => { d.close(); d.remove(); };
  $('#d-x', d).onclick = close;
  d.addEventListener('cancel', () => setTimeout(() => d.remove(), 0));
  if (onDelete) $('#d-del', d).onclick = async () => { if (await onDelete()) { close(); render(); } };
  $('form', d).onsubmit = async (e) => {
    e.preventDefault();
    const out = {};
    for (const f of fields) {
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
  bar('', 'Load Dev Tracker', '<a class="r" href="#/settings">Settings</a>');
  const rows = S.rifles.slice().sort((a, b) => a.name.localeCompare(b.name)).map((r) => {
    const t = rifleTotals(r.id);
    return `<a class="item" href="#/rifle/${r.id}"><div><b style="font-size:20px">${esc(r.name)}</b><small>${esc(calName(r.caliberId))}${r.barrel ? ' · ' + r.barrel + ' in' : ''}</small></div><div style="text-align:right"><div class="mono v">${t.barrel}</div><small>barrel rounds</small></div></a>`;
  }).join('');
  main(`<h1>Rifles</h1>${rows || '<div class="card muted">No rifles yet. Add one to start logging.</div>'}
    <button class="btn pri" data-act="new-rifle">+ Add New Rifle</button>
    <a class="btn" href="#/settings">Settings · Components</a>
    <div class="muted">Stored on this device only. Use Export in Settings to back up.</div>`);
}

function rifleForm(r) {
  formDialog(r ? 'Edit rifle' : 'New rifle', [
    { k: 'name', label: 'Name / label', req: true },
    { k: 'caliberId', label: 'Caliber (add calibers in Settings)', type: 'select', opts: calOpts() },
    { k: 'barrel', label: 'Barrel length (in)', type: 'num' },
    { k: 'startRounds', label: 'Rounds already through barrel', type: 'num' }
  ], r || {}, async (v) => {
    await put('rifles', { ...(r || { id: uid() }), name: v.name, caliberId: v.caliberId, barrel: v.barrel, startRounds: v.startRounds ?? 0 });
  }, r ? async () => {
    if (!confirm(`Delete "${r.name}" and ALL its groups? This cannot be undone.`)) return false;
    for (const g of S.groups.filter((g2) => g2.rifleId === r.id)) await del('groups', g.id);
    for (const s of sessionsOf(r.id)) await del('sessions', s.id);
    for (const h of S.hist.filter((h2) => h2.rifleId === r.id)) await del('hist', h.id);
    await del('rifles', r.id);
    location.hash = '#/';
    return true;
  } : null);
}

const comboHref = (c) => `#/combo/${c.groups[0].rifleId}/${encodeURIComponent(c.key)}`;
function groupCard(g, showSess) {
  const s = gstats(g);
  return `<a class="card ${g.include === false ? 'excl' : ''}" href="#/group/${g.id}">
    <div class="row sb"><b>${esc(nm('powders', g.powderId))} ${g.charge} gn</b>${g.include === false ? '<span class="tag a">Excluded</span>' : g.reference ? '<span class="tag g">Ref</span>' : ''}</div>
    <div class="muted">${showSess && sessOf(g) ? esc(sessionLabel(sessOf(g))) + ' · ' : ''}${esc(bl(g.bulletId))} · ${esc(nm('primers', g.primerId))} · ${g.jump} thou · ${fin(g.distance) ? g.distance + ' yd' : 'no distance'} · RSC ${roundsSinceClean(g) ?? '—'}</div>
    <div class="grid4"><div><div class="lbl">MR</div><span class="mono v">${fmt(s.mr)}</span></div><div><div class="lbl">MR MOA</div><span class="mono v">${fmt(moa(s.mr, g.distance), 2)}</span></div><div><div class="lbl">ES</div><span class="mono v">${fmt(s.es)}</span></div><div><div class="lbl">Shots</div><span class="mono v">${s.total}</span></div></div></a>`;
}
function comboRow(c, best, rank) {
  const ranked = c.nGroups >= 2;
  return `<a class="card" href="${comboHref(c)}" ${best ? 'style="border:2px solid var(--accent-text)"' : ''}>
    <div class="row sb"><b>${esc(comboLabel(c))}</b>${rank ? `<span class="tag ${rank === 1 ? 'g' : ''}">${rank === 1 ? '#1 best' : '#' + rank}</span>` : ''}</div>
    <div class="grid4"><div><div class="lbl">Grp</div><span class="mono v">${c.nGroups}</span></div><div><div class="lbl">Shots</div><span class="mono v">${c.nShots}</span></div>
    <div><div class="lbl">MR</div><span class="mono v">${fmt(c.mr)}</span></div><div><div class="lbl">Vel</div><span class="mono v">${fin(c.vel) ? Math.round(c.vel) : '—'}</span></div></div>
    <div class="muted">MR ${fmt(c.mrMoa, 2)} MOA · ES ${fmt(c.es)}" / ${fmt(c.esMoa, 2)} MOA (average of each group's calculated ES) · MR weighted by shots</div>
    ${ranked ? '' : '<div class="warn">Not enough data yet — needs 2+ groups</div>'}<div class="muted">Tap to see its groups →</div></a>`;
}

function viewRifle(rid) {
  const r = byId('rifles', rid);
  if (!r) return viewHome();
  bar(back('#/', 'Rifles'), r.name, `<button class="r" data-act="edit-rifle" data-id="${rid}">Edit</button>`);
  const gs = S.groups.filter((g) => g.rifleId === rid);
  const cs = combos(gs);
  const bd = bestDist();
  const best = cs.find((c) => Number(c.distance) === bd && c.nGroups >= 2 && c.mr !== null); // main screen ranks one distance (default 100 yd); other distances live on the Best page
  const t = rifleTotals(rid);
  const latest = latestSession(rid);
  main(`<div class="muted">${esc(calName(r.caliberId))}${r.barrel ? ' · ' + r.barrel + ' in barrel' : ''}</div>
    ${best ? `<a class="hero" href="${comboHref(best)}"><div class="lbl">Current best load · ${bd} yd</div><div style="font-size:19px;font-weight:600">${esc(bl(best.bulletId))} · ${esc(nm('powders', best.powderId))}</div>
      <div class="mono">${best.charge} gn · ${esc(nm('primers', best.primerId))} · ${best.jump} thou jump</div>
      <div class="big mono">${fmt(best.mr)}"</div><div class="mono">${fmt(best.mrMoa, 2)} MOA</div><div>pooled mean radius · ${best.nGroups} groups · ${best.nShots} shots</div><div style="opacity:.85;font-size:13px">Tap to see its groups →</div></a>`
      : `<div class="hero"><div class="lbl">Current best load · ${bd} yd</div><div style="font-size:19px;font-weight:600">Not enough data yet</div><div>Needs 2+ groups at the exact same Bullet + Powder + Charge + Primer + Jump at ${bd} yd. Other distances are on the Best Loads page.</div></div>`}
    <div class="grid2"><div class="card"><div class="lbl">Shots logged</div><div class="mono v" style="font-size:30px">${t.shots}</div></div>
    <div class="card"><div class="lbl">Barrel total</div><div class="mono v" style="font-size:30px">${t.barrel}</div><div class="muted">${t.start} start + ${t.shots} logged + ${t.fouling} fouling</div></div></div>
    ${latest ? `<a class="card" href="#/session/${latest.id}"><div class="lbl">Current session · tap to open</div><div class="row sb"><b>${esc(sessionLabel(latest))}</b><span class="mono">${fin(latest.fouling) ? latest.fouling : 0} fouling · ${groupsOf(latest.id).length} grp</span></div></a>` : ''}
    ${latest ? `<a class="btn dark" href="#/add/${rid}">+ Add New Group</a>` : ''}
    <button class="btn ${latest ? '' : 'dark'}" data-act="new-session" data-id="${rid}">+ Start New Session</button>
    <a class="btn" href="#/best/${rid}">Best Loads by Distance</a>
    <a class="btn" href="#/load/${rid}">Load Analysis</a>
    <a class="btn" href="#/sessions/${rid}">View Session Data</a>
    <a class="btn" href="#/all/${rid}">View All Data</a>
    ${cs.length ? `<h2>Loads · pooled by distance (Include = Y only)</h2>${cs.map((c) => comboRow(c, c === best)).join('')}` : ''}`);
}

function viewAll(rid) {
  const r = byId('rifles', rid);
  if (!r) return viewHome();
  if (F.rid !== rid) F = { rid, powder: '', bullet: '', primer: '', charge: '', jump: '', distance: '' };
  bar(back('#/rifle/' + rid, 'Back'), 'All Data', '', rid);
  const all = S.groups.filter((g) => g.rifleId === rid);
  const gs = all.filter((g) => (!F.powder || g.powderId === F.powder) && (!F.bullet || g.bulletId === F.bullet) && (!F.primer || g.primerId === F.primer) &&
    (!F.charge || String(Number(g.charge)) === F.charge) && (!F.jump || String(Number(g.jump)) === F.jump) && (!F.distance || String(Number(g.distance)) === F.distance));
  const used = (k, s) => S[s].filter((x) => all.some((g) => g[k] === x.id));
  const dist = (k) => [...new Set(all.map((g) => String(Number(g[k]))))].sort((a, b) => a - b);
  const sel = (key, label, inner) => `<div class="f"><label class="lbl" for="F-${key}">${label}</label><select class="in" style="min-height:48px;font-size:16px" id="F-${key}" data-filter="${key}">${inner}</select></div>`;
  const filtering = !!(F.powder || F.bullet || F.primer || F.charge || F.jump || F.distance);
  const list = sessionsOf(rid).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts).map((se) => {
    const mine = gs.filter((g) => g.sessionId === se.id).sort((a, b) => a.ts - b.ts);
    if (filtering && !mine.length) return '';
    return `<div class="row sb" style="margin-top:6px"><div><b>${esc(sessionLabel(se))}</b><div class="muted">${fin(se.fouling) ? se.fouling : 0} fouling${fin(se.temp) ? ' · ' + se.temp + ' F' : ''}${se.wind ? ' · ' + esc(se.wind) : ''}</div></div>
      <button class="btn sm" data-act="edit-session" data-id="${se.id}">Edit session</button></div>
      ${mine.length ? mine.map((g) => groupCard(g)).join('') : '<div class="card muted">No groups in this session yet.</div>'}`;
  }).join('');
  const cs = combos(gs);
  const hist = S.hist.filter((h) => h.rifleId === rid);
  const hmap = new Map();
  for (const h of hist) { const k = [h.bulletId, h.powderId, h.charge].join('|'); if (!hmap.has(k)) hmap.set(k, []); hmap.get(k).push(h); }
  main(`<div class="grid2">
    ${sel('powder', 'Powder', opts(used('powderId', 'powders'), F.powder, (x) => x.name, 'All'))}
    ${sel('bullet', 'Bullet', opts(used('bulletId', 'bullets'), F.bullet, (x) => x.name + (fin(x.weight) ? ' ' + x.weight : ''), 'All'))}
    ${sel('primer', 'Primer', opts(used('primerId', 'primers'), F.primer, (x) => x.name, 'All'))}
    ${sel('charge', 'Charge', '<option value="">All</option>' + dist('charge').map((c) => `<option${c === F.charge ? ' selected' : ''}>${c}</option>`).join(''))}
    ${sel('jump', 'Jump', '<option value="">All</option>' + dist('jump').map((c) => `<option${c === F.jump ? ' selected' : ''}>${c}</option>`).join(''))}
    ${sel('distance', 'Distance (yd)', '<option value="">All</option>' + dist('distance').map((c) => `<option${c === F.distance ? ' selected' : ''}>${c}</option>`).join(''))}</div>
    <div class="muted">${gs.length} of ${all.length} groups shown · by session, newest first</div>
    ${list || '<div class="card muted">No groups match.</div>'}
    ${cs.length ? `<h2>Pooled combos (filtered)</h2>${cs.map((c) => comboRow(c, false)).join('')}` : ''}
    <h2>Historical · manual ES only</h2>
    <div class="muted">Pre-existing data without X/Y. Kept separate — never mixed into mean-radius stats.</div>
    ${[...hmap.values()].map((arr) => { const es = arr.filter((h) => fin(h.es)); const avg = es.length ? es.reduce((a, h) => a + h.es, 0) / es.length : null;
      return `<div class="card"><b>${esc(bl(arr[0].bulletId))} · ${esc(nm('powders', arr[0].powderId))} ${arr[0].charge} gn</b><div class="kv"><span>Reference avg ES (${es.length} entr${es.length === 1 ? 'y' : 'ies'})</span><b>${fmt(avg)}"</b></div>
      ${arr.map((h) => `<div class="row sb muted"><span>${esc(h.note || '—')} · ES ${fmt(h.es)}</span><button class="btn sm" data-act="edit-hist" data-id="${h.id}">Edit</button></div>`).join('')}</div>`; }).join('')}
    <button class="btn" data-act="new-hist" data-id="${rid}">+ Add historical entry</button>`);
}

const newest = (a, b) => b.date.localeCompare(a.date) || b.ts - a.ts;
const sessMeta = (se) => `${fin(se.fouling) ? se.fouling : 0} fouling${fin(se.temp) ? ' · ' + se.temp + ' F' : ''}${se.wind ? ' · ' + esc(se.wind) : ''}`;

function viewSessions(rid) {
  const r = byId('rifles', rid);
  if (!r) return viewHome();
  bar(back('#/rifle/' + rid, 'Back'), 'Sessions', '', rid);
  const list = sessionsOf(rid).sort(newest).map((se) => {
    const gs = groupsOf(se.id);
    return `<a class="card" href="#/session/${se.id}"><div class="row sb"><b>${esc(sessionLabel(se))}</b><span class="mono">${gs.length} grp · ${gs.reduce((a, g) => a + g.shots.length, 0)} shots</span></div><div class="muted">${sessMeta(se)}</div></a>`;
  }).join('');
  main(`<h1>Sessions</h1>${list || '<div class="card muted">No sessions yet.</div>'}
    <button class="btn dark" data-act="new-session" data-id="${rid}">+ Start New Session</button>`);
}

function viewSession(sid) {
  const se = byId('sessions', sid);
  if (!se) return viewHome();
  const rid = se.rifleId, gs = groupsOf(sid);
  const shots = gs.reduce((a, g) => a + g.shots.length, 0);
  const cs = combos(gs);
  bar(back('#/sessions/' + rid, 'Sessions'), 'Session · ' + se.date, `<button class="r" data-act="edit-session" data-id="${sid}">Edit</button>`, rid);
  main(`<div><h1 style="font-size:24px">${esc(sessionLabel(se))}</h1><div class="muted">${sessMeta(se)}</div></div>
    <div class="grid3"><div class="card"><div class="lbl">Groups</div><span class="mono v">${gs.length}</span></div>
    <div class="card"><div class="lbl">Shots</div><span class="mono v">${shots}</span></div>
    <div class="card"><div class="lbl">Since clean</div><span class="mono v">${(fin(se.fouling) ? se.fouling : 0) + shots}</span></div></div>
    <a class="btn dark" href="#/add/${sid}">+ Add Group to this session</a>
    <h2>Groups · in the order fired</h2>
    ${gs.length ? gs.map((g) => groupCard(g)).join('') : '<div class="card muted">No groups in this session yet.</div>'}
    ${cs.length ? `<h2>Loads in this session · pooled across all sessions</h2>${cs.map((c) => comboRow(c, false)).join('')}` : ''}`);
}

function viewCombo(rid, key) {
  const r = byId('rifles', rid);
  const gs = S.groups.filter((g) => g.rifleId === rid && ckey(g) === key)
    .sort((a, b) => (sessOf(b) ? sessOf(b).date : '').localeCompare(sessOf(a) ? sessOf(a).date : '') || b.ts - a.ts);
  if (!r || !gs.length) return viewHome();
  bar(back('#/rifle/' + rid, 'Back'), 'Load', '', rid);
  const c = combos(gs)[0];
  const excl = gs.filter((g) => g.include === false).length;
  main(`<div><h1 style="font-size:22px">${esc(comboLabel(gs[0]))}</h1></div>
    ${c ? `<div class="hero"><div class="grid2"><div><div class="lbl">Pooled mean radius</div><div class="big mono">${fmt(c.mr)}"</div><div class="mono">${fmt(c.mrMoa, 2)} MOA</div></div>
      <div><div class="lbl">Avg ES</div><div class="big mono">${fmt(c.es)}"</div><div class="mono">${fmt(c.esMoa, 2)} MOA</div></div></div>
      <div>${c.nGroups} group${c.nGroups === 1 ? '' : 's'} · ${c.nShots} shots · avg velocity ${fin(c.vel) ? Math.round(c.vel) : '—'} fps</div>
      ${c.nGroups < 2 ? '<div style="font-weight:600">Not enough data yet — needs 2+ groups to rank</div>' : ''}</div>`
      : '<div class="card warn">Every group of this load is excluded from analysis, so there are no pooled stats.</div>'}
    <div class="muted">Pooled mean radius is weighted by shots and counts only groups with Include = Y. ES is the average of each group's calculated ES.${excl ? ` ${excl} excluded group${excl === 1 ? ' is' : 's are'} shown dimmed below.` : ''}</div>
    <h2>All groups with this load</h2>
    ${gs.map((g) => groupCard(g, true)).join('')}`);
}

// Best loads, one section per distance. A load needs 2+ groups (same bullet, powder, charge, primer, jump, distance) to be ranked.
let showThin = false; // Best page: off by default, so only ranked loads show
function viewBest(rid) {
  const r = byId('rifles', rid);
  if (!r) return viewHome();
  bar(back('#/rifle/' + rid, 'Back'), 'Best by Distance', '', rid);
  const cs = combos(S.groups.filter((g) => g.rifleId === rid));
  const dists = [...new Set(cs.map((c) => Number(c.distance)))].sort((a, b) => a - b);
  const sections = dists.map((d) => {
    const at = cs.filter((c) => Number(c.distance) === d);
    const ranked = at.filter((c) => c.nGroups >= 2 && c.mr !== null).sort((a, b) => a.mr - b.mr);
    const rest = at.filter((c) => !ranked.includes(c));
    return `<h2>${fin(d) ? d + ' yd' : 'No distance set'}</h2>
      ${ranked.map((c, i) => comboRow(c, i === 0, i + 1)).join('') || `<div class="card muted">No load has 2+ groups at this distance yet.${rest.length && !showThin ? ` (${rest.length} with 1 group — use the toggle above to see ${rest.length === 1 ? 'it' : 'them'}.)` : ''}</div>`}
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
      <td><a href="${comboHref(c)}"><b>${c.charge}</b> gn${c === bestId ? ' <span class="tag g">best MR</span>' : ''}</a><small>${esc(nm('primers', c.primerId))} · ${c.jump} thou</small></td>
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
  const best = ranked[0];
  if (best) {
    const { c, vp } = best;
    return `<div class="card"><b>${esc(title)}</b>
      <div class="mono v">${c.charge} gn</div><div class="muted">${esc(nm('primers', c.primerId))} · ${c.jump} thou</div>
      <div class="kv"><span>MR</span><b>${fmt(c.mr)}</b></div><div class="muted" style="text-align:right">n=${c.groups.reduce((a, g) => a + gstats(g).n, 0)} · ${fmt(c.mrMoa, 2)} MOA</div>
      <div class="kv"><span>Vel SD</span><b>${fmt(vp.sd, 1)}</b></div><div class="kv"><span>Vel ES</span><b>${fmt(vp.es, 0)}</b></div><div class="muted" style="text-align:right">n=${vp.n} shots with velocity</div>
      <div class="kv"><span>Groups</span><b>${c.nGroups}</b></div><div class="muted" style="text-align:right">${c.nShots} shots</div>
      <a class="btn sm" href="${comboHref(c)}">See groups</a></div>`;
  }
  return `<div class="card"><b>${esc(title)}</b><div class="warn">Not enough data yet</div>
    ${items.length ? items.map(({ c }) => `<div class="muted">${c.charge} gn · ${esc(nm('primers', c.primerId))} · ${c.jump} thou — MR ${fmt(c.mr)} (${c.nGroups} group, ${c.nShots} shots)</div>`).join('') : '<div class="muted">No groups at this distance.</div>'}</div>`;
}

function viewLoad(rid) {
  const r = byId('rifles', rid);
  if (!r) return viewHome();
  if (LA.rid !== rid) LA = { rid, bullet: '', powder: '', powderB: '', sort: 'mr', thin: false, ladderThin: false, compare: false };
  bar(back('#/rifle/' + rid, 'Back'), 'Load Analysis', '', rid);
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
    const bestC = ranked.slice().sort(laSorts.mr)[0];
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

/* Calibers are a library. A rifle and a bullet are linked by sharing the same caliber; the group form's bullet list follows the rifle. */
const calNorm = (s) => String(s || '').toLowerCase().replace(/^\./, '').replace(/\s+/g, ' ').trim();
const calMatch = (a, b) => { a = calNorm(a); b = calNorm(b); return !!a && !!b && (a.startsWith(b) || b.startsWith(a)); }; // only used to migrate old free-text values
const calName = (id) => (byId('calibers', id) || {}).name || '';
const calOpts = () => [['', '— none —'], ...S.calibers.slice().sort((a, b) => a.name.localeCompare(b.name)).map((c) => [c.id, c.name])];
// bullets of the rifle's caliber, plus any bullet with no caliber set (never hide a bullet just because it is unassigned)
function bulletsFor(rid, keepId) {
  const r = byId('rifles', rid);
  if (!r || !r.caliberId) return S.bullets;
  return S.bullets.filter((b) => !b.caliberId || b.caliberId === r.caliberId || b.id === keepId);
}

function histForm(rid, h) {
  if (!S.bullets.length || !S.powders.length) { toast('Add a bullet and powder in Settings first'); return; }
  formDialog(h ? 'Edit historical entry' : 'Historical entry', [
    { k: 'bulletId', label: 'Bullet', type: 'select', opts: bulletsFor(rid, h && h.bulletId).map((b) => [b.id, bl(b.id)]) },
    { k: 'powderId', label: 'Powder', type: 'select', opts: S.powders.map((p) => [p.id, p.name]) },
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

function viewGroup(gid) {
  const g = byId('groups', gid);
  if (!g) return viewHome();
  const s = gstats(g);
  const se = sessOf(g) || {};
  bar(back('#/session/' + g.sessionId, 'Session'), 'Group · ' + gdate(g), `<a class="r" href="#/edit/${gid}">Edit</a>`, g.rifleId);
  const sess = groupsOf(g.sessionId);
  main(`<div><h1 style="font-size:24px">${esc(se.id ? sessionLabel(se) : '—')} · Group ${sess.findIndex((x) => x.id === g.id) + 1}</h1>
    <div class="muted">${esc(bl(g.bulletId))} · ${esc(nm('powders', g.powderId))} ${g.charge} gn · ${esc(nm('primers', g.primerId))} · ${g.jump} thou · ${fin(g.distance) ? g.distance + ' yd' : 'no distance'}</div>
    <div class="muted">${fin(se.temp) ? se.temp + ' F · ' : ''}${esc(se.wind || '')}</div>
    <div class="row" style="margin-top:6px">${g.include === false ? '<span class="tag a">Excluded from analysis</span>' : '<span class="tag g">Included</span>'}${g.reference ? '<span class="tag g">Reference group</span>' : ''}</div></div>
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
    <div class="card"><div class="row sb"><div class="lbl">Session</div><button class="btn sm" data-act="edit-session" data-id="${g.sessionId}">Edit session</button></div>
      <div class="kv"><span>Session fouling shots</span><b>${fin(se.fouling) ? se.fouling : 0}</b></div>
      <div class="kv"><span>Rounds since clean (at start of group)</span><b>${roundsSinceClean(g) ?? '—'}</b></div>
      <div class="kv"><span>COAL / trimmed length</span><b>${fin(g.coal) ? g.coal : '—'} / ${fin(g.trim) ? g.trim : '—'}</b></div></div>
    <div class="card"><div class="lbl">Shots</div><table><thead><tr><th>#</th><th>Vel</th><th>X</th><th>Y</th><th>Rad</th></tr></thead><tbody>
      ${g.shots.map((p, i) => `<tr><td>${i + 1}</td><td>${fin(p.v) ? p.v : '—'}</td><td>${sfmt(p.x)}</td><td>${sfmt(p.y)}</td><td>${fin(p.x) && fin(p.y) && s.cx !== null ? fmt(Math.hypot(p.x - s.cx, p.y - s.cy)) : '—'}</td></tr>`).join('')}</tbody></table></div>
    ${g.notes ? `<div class="card"><div class="lbl">Notes</div>${esc(g.notes)}</div>` : ''}
    <a class="btn dark" href="#/add/${g.sessionId}?from=${g.id}">+ Add another group (same session &amp; load)</a>
    <button class="btn danger" data-act="del-group" data-id="${g.id}">Delete group</button>`);
}

function shotRow(i, p = {}) {
  const c = (cls, val, lab, sign) => `<td class="cell"><input class="in m ${cls}" inputmode="decimal" aria-label="Shot ${i + 1} ${lab}" value="${fin(val) ? val : ''}" autocomplete="off">${sign ? '<button type="button" class="sg" data-act="sign" aria-label="Toggle sign">±</button>' : ''}</td>`;
  return `<tr><td class="mono" style="width:24px;padding:0"><b>${i + 1}</b></td>${c('sv', p.v, 'velocity', false)}${c('sx', p.x, 'X', true)}${c('sy', p.y, 'Y', true)}</tr>`;
}

function viewGroupForm(rid, gid, fromId, sid) {
  const r = byId('rifles', rid);
  if (!r) return viewHome();
  const g0 = gid ? byId('groups', gid) : null;
  const src = g0 || (fromId && byId('groups', fromId)) || S.groups.filter((g) => g.rifleId === rid).sort((a, b) => b.ts - a.ts)[0] || {};
  const missing = !S.bullets.length || !S.powders.length || !S.primers.length;
  bar(back(g0 ? '#/group/' + gid : '#/session/' + sid, g0 ? 'Group' : 'Session'), g0 ? 'Edit Group' : 'New Group', '', rid);
  const curSid = g0 ? g0.sessionId : sid;
  const sessOpts = sessionsOf(rid).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts)
    .map((x) => `<option value="${x.id}"${x.id === curSid ? ' selected' : ''}>${esc(sessionLabel(x))} · ${fin(x.fouling) ? x.fouling : 0} fouling</option>`).join('');
  const bLabel = (x) => x.name + (fin(x.weight) ? ' ' + x.weight + ' gn' : '');
  const filtered = bulletsFor(rid, src.bulletId);
  const nShots = g0 ? g0.shots.length : 5;
  const sec = (t) => `<h2 style="color:var(--accent-text);border-color:var(--accent-text)">${t}</h2>`;
  const fld = (id, label, val, cls = 'm', extra = '') => `<div class="f"><label class="lbl" for="${id}">${label}</label><input class="in ${cls}" id="${id}" type="text" ${cls === 'm' ? 'inputmode="decimal"' : ''} value="${esc(val ?? '')}" autocomplete="off" ${extra}></div>`;
  const yn = (name, on) => `<div class="seg"><label><input type="radio" name="${name}" value="1"${on ? ' checked' : ''}><span>Y</span></label><label><input type="radio" name="${name}" value="0"${on ? '' : ' checked'}><span>N</span></label></div>`;
  main(`${missing ? '<div class="card warn">Add at least one Bullet, Powder and Primer in <a href="#/settings" style="text-decoration:underline">Settings</a> first.</div>' : ''}
    <form id="gform" autocomplete="off">
    ${sec('SESSION')}
    <div class="f"><label class="lbl" for="f-session">Session</label><select class="in" id="f-session">${sessOpts}</select></div>
    <div class="muted">Date, wind, temp and fouling shots belong to the session. Change them with Edit session on the rifle or group page.</div>
    ${sec('LOAD')}
    <div class="f"><label class="lbl" for="f-bullet">Bullet</label><select class="in" id="f-bullet">${opts(filtered, src.bulletId, bLabel)}</select>
    ${r.caliberId ? `<div class="muted">Showing ${esc(calName(r.caliberId))} bullets (and any with no caliber set).${filtered.length < S.bullets.length ? ' <label style="text-decoration:underline"><input type="checkbox" id="f-allcal"> show all bullets</label>' : ''}</div>`
      : '<div class="muted">Set this rifle\'s caliber (rifle → Edit) to filter bullets automatically.</div>'}</div>
    <div class="f"><label class="lbl" for="f-powder">Powder</label><select class="in" id="f-powder">${opts(S.powders, src.powderId, (x) => x.name)}</select></div>
    <div class="grid2">${fld('f-charge', 'Charge (gn)', src.charge)}${fld('f-jump', 'Jump (thou off lands)', src.jump)}</div>
    ${fld('f-dist', 'Distance (yards)', fin(src.distance) ? src.distance : 100)}
    <div class="f"><label class="lbl" for="f-primer">Primer</label><select class="in" id="f-primer">${opts(S.primers, src.primerId, (x) => x.name)}</select></div>
    <div class="grid2">${fld('f-coal', 'COAL (in) · optional', src.coal)}${fld('f-trim', 'Trimmed case (in) · opt.', src.trim)}</div>
    ${sec('FLAGS')}
    <div class="grid2"><div class="f"><span class="lbl">Include in analysis</span>${yn('inc', g0 ? g0.include !== false : true)}</div>
    <div class="f"><span class="lbl">Reference group</span>${yn('ref', g0 ? !!g0.reference : false)}</div></div>
    ${fld('f-notes', 'Notes', g0 ? g0.notes : '', '')}
    ${sec('SHOTS · X / Y INCHES FROM POINT OF AIM')}
    <div class="muted">Velocity optional per shot. Blank rows are ignored. Tap ± to flip sign. +Y is up, +X is right.</div>
    <table class="shots"><thead><tr><th></th><th>Vel fps</th><th>X in</th><th>Y in</th></tr></thead><tbody id="shots">
    ${Array.from({ length: nShots }, (_, i) => shotRow(i, g0 ? g0.shots[i] : {})).join('')}</tbody></table>
    <div class="grid2"><button type="button" class="btn sm" data-act="add-shot">+ Add shot</button><button type="button" class="btn sm" data-act="rm-shot">− Remove last</button></div>
    ${fld('f-esm', 'Extreme spread, manual caliper (in) · optional', g0 ? g0.esManual : '')}
    <div class="card" id="preview"></div>
    <button class="btn pri" type="submit" ${missing ? 'disabled' : ''}>Save group</button></form>`);
  const form = $('#gform');
  form.addEventListener('input', preview);
  form.addEventListener('change', (e) => {
    if (e.target.id === 'f-allcal') { // temporarily show bullets of every caliber, keeping the current pick
      const cur = $('#f-bullet').value;
      $('#f-bullet').innerHTML = opts(e.target.checked ? S.bullets : bulletsFor(rid, cur), cur, bLabel);
    }
    preview();
  });
  form.onsubmit = (e) => { e.preventDefault(); saveGroup(rid, gid, g0); };
  preview();
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
    include: $('input[name=inc]:checked').value === '1', reference: $('input[name=ref]:checked').value === '1',
    notes: $('#f-notes').value.trim(), esManual: num($('#f-esm').value), shots
  };
  if (!g.bulletId || !g.powderId || !g.primerId) return toast('Pick bullet, powder and primer');
  await put('groups', g);
  location.hash = '#/group/' + g.id;
}
async function deleteGroup(id) {
  const g = byId('groups', id);
  if (!g || !confirm('Delete this group? This cannot be undone.')) return;
  await del('groups', id);
  location.hash = '#/rifle/' + g.rifleId;
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
  bar(back('#/', 'Rifles'), 'Settings');
  const lib = (title, s, sub) => `<h2 class="row sb" style="align-items:center">${title}<button class="btn sm" data-act="lib-new" data-s="${s}">+ Add</button></h2>
    ${S[s].slice().sort((a, b) => a.name.localeCompare(b.name)).map((x) => `<div class="item" role="button" tabindex="0" data-act="lib-edit" data-s="${s}" data-id="${x.id}"><div>${esc(x.name)}${sub(x) ? `<small>${esc(sub(x))}</small>` : ''}</div><span class="muted">Edit</span></div>`).join('') || '<div class="muted">None yet.</div>'}`;
  main(`<h1>Components</h1>
    ${lib('CALIBERS', 'calibers', () => '')}
    <div class="muted" style="margin-top:-4px">Add a caliber once (e.g. ".308 Win"), then pick it on each rifle and each bullet. A rifle only offers bullets of its own caliber.</div>
    ${lib('RIFLES', 'rifles', (x) => `${calName(x.caliberId) || 'no caliber'}${x.barrel ? ' · ' + x.barrel + ' in' : ''} · start ${x.startRounds || 0} rds`).replace('data-act="lib-new" data-s="rifles"', 'data-act="new-rifle"')}
    ${lib('BULLETS', 'bullets', (x) => [calName(x.caliberId), x.style, fin(x.weight) ? x.weight + ' gn' : '', fin(x.diameter) ? 'dia ' + x.diameter + ' in' : ''].filter(Boolean).join(' · '))}
    ${lib('POWDERS', 'powders', () => '')}
    ${lib('PRIMERS', 'primers', (x) => x.type || '')}
    ${lib('CASES · optional', 'cases', () => '')}
    <h2>APPEARANCE</h2>
    <div class="grid3">${[['light', 'Light'], ['dark', 'Dark'], ['auto', 'Auto']].map(([v, l]) => `<button class="btn ${themePref() === v ? 'pri' : ''}" data-act="theme" data-v="${v}" aria-pressed="${themePref() === v}">${l}</button>`).join('')}</div>
    <div class="lbl">Accent color</div>
    <div class="grid3">${[['green', 'Green', '#3f5b2e'], ['blue', 'Blue', '#0b4f9c'], ['orange', 'Orange', '#c2560c']].map(([v, l, c]) => `<button class="btn ${accentPref() === v ? 'pri' : ''}" data-act="accent" data-v="${v}" aria-pressed="${accentPref() === v}"><span class="swatch" style="background:${c}"></span>${l}</button>`).join('')}</div>
    <div class="muted">Auto follows your phone's light or dark setting. Theme and accent are saved on this device only.</div>
    <h2>PREFERENCES</h2>
    <div class="f"><label class="lbl" for="pref-dist">Main-screen best load distance (yards)</label><input class="in m" id="pref-dist" inputmode="numeric" value="${bestDist()}"></div>
    <div class="muted">The rifle page shows the best load at this distance. Every distance is on the Best Loads page.</div>
    <h2>BACKUP</h2>
    <div class="muted">Data lives only on this device. Export a JSON file to back up or move it to another device.</div>
    <div class="grid2"><button class="btn dark" data-act="export">Export data</button><button class="btn" data-act="import">Import data</button></div>
    <div class="muted">${S.cfg.lastBackup ? 'Last backup: ' + new Date(S.cfg.lastBackup).toLocaleString() : 'No backup made yet.'}</div>
    <div class="lbl" style="margin-top:6px">Remind me after</div>
    <div class="grid2"><div class="f"><label class="lbl" for="bk-days">Days</label><input class="in m" id="bk-days" inputmode="numeric" value="${S.cfg.days}"></div>
    <div class="f"><label class="lbl" for="bk-groups">New groups</label><input class="in m" id="bk-groups" inputmode="numeric" value="${S.cfg.groups}"></div></div>
    <div class="muted">Whichever comes first. Set either to 0 to turn that trigger off.</div>
    <input type="file" id="imp" accept="application/json,.json" hidden>
    <div class="muted" id="persist"></div>`);
  $('#imp').onchange = (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; };
  if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then((p) => { const el = $('#persist'); if (el) el.textContent = p ? 'Storage: persistent.' : 'Storage: browser-managed. Export backups occasionally.'; });
}

const LIBS = {
  bullets: [{ k: 'name', label: 'Manufacturer / name', req: true },
    { k: 'caliberId', label: 'Caliber (add calibers in Settings)', type: 'select', opts: [] },
    { k: 'style', label: 'Style (bullet shape)', list: ['BTHP', 'BT', 'SP', 'SPBT', 'FMJ', 'FMJBT', 'HP', 'RN', 'SWC', 'Hybrid'] },
    { k: 'weight', label: 'Weight (gn)', type: 'num' }, { k: 'diameter', label: 'Diameter (in)', type: 'num', req: true }],
  calibers: [{ k: 'name', label: 'Caliber name (e.g. .308 Win, 7mm Rem Mag, .45 ACP)', req: true }],
  powders: [{ k: 'name', label: 'Name', req: true }],
  primers: [{ k: 'name', label: 'Brand / name', req: true },
    { k: 'type', label: 'Type', list: ['Large Rifle', 'Large Rifle Magnum', 'Small Rifle', 'Small Rifle Magnum', 'Large Pistol', 'Large Pistol Magnum', 'Small Pistol', 'Small Pistol Magnum'] }],
  cases: [{ k: 'name', label: 'Manufacturer / name', req: true }]
};
const USE = { bullets: 'bulletId', powders: 'powderId', primers: 'primerId' };
function libForm(s, x) {
  formDialog(x ? 'Edit' : 'Add', LIBS[s].map((f) => (f.k === 'caliberId' ? { ...f, opts: calOpts() } : f)), x || (s === 'bullets' ? { diameter: 0.308 } : {}), async (v) => { await put(s, { ...(x || { id: uid() }), ...v }); },
    x ? async () => {
      if (USE[s] && S.groups.some((g) => g[USE[s]] === x.id)) { toast('In use by logged groups — cannot delete'); return false; }
      if (s === 'calibers' && (S.rifles.some((r) => r.caliberId === x.id) || S.bullets.some((b) => b.caliberId === x.id))) { toast('In use by a rifle or bullet — cannot delete'); return false; }
      if (!confirm('Delete this item?')) return false;
      await del(s, x.id); return true;
    } : null);
}

/* ---------- router & events ---------- */
function render() {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const p = path.split('/').filter(Boolean);
  const q = new URLSearchParams(qs || '');
  try {
    if (!p.length) viewHome();
    else if (p[0] === 'rifle') viewRifle(p[1]);
    else if (p[0] === 'all') viewAll(p[1]);
    else if (p[0] === 'best') viewBest(p[1]);
    else if (p[0] === 'load') viewLoad(p[1]);
    else if (p[0] === 'sessions') viewSessions(p[1]);
    else if (p[0] === 'session') viewSession(p[1]);
    else if (p[0] === 'combo') viewCombo(p[1], decodeURIComponent(p[2] || ''));
    else if (p[0] === 'add') {
      let se = byId('sessions', p[1]); // #/add/<sessionId>; a rifle id means "latest session"
      if (!se && byId('rifles', p[1])) se = latestSession(p[1]);
      if (se) viewGroupForm(se.rifleId, null, q.get('from'), se.id);
      else if (byId('rifles', p[1])) { location.replace('#/rifle/' + p[1]); toast('Start a session first'); }
      else viewHome();
    }
    else if (p[0] === 'edit') { const g = byId('groups', p[1]); g ? viewGroupForm(g.rifleId, g.id) : viewHome(); }
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
    + (due ? `<div class="banner warnb"><span>${esc(due)} Back up now.</span><button class="btn sm dark" data-act="export">Backup Now</button><button class="btn sm" data-act="snooze">Later</button></div>` : '');
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
window.addEventListener('hashchange', render);

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const a = t.dataset.act, id = t.dataset.id;
  if (a === 'new-rifle') rifleForm(null);
  else if (a === 'edit-rifle') rifleForm(byId('rifles', id));
  else if (a === 'lib-new') libForm(t.dataset.s, null);
  else if (a === 'lib-edit') { if (t.dataset.s === 'rifles') rifleForm(byId('rifles', id)); else libForm(t.dataset.s, byId(t.dataset.s, id)); }
  else if (a === 'new-hist') histForm(id, null);
  else if (a === 'edit-hist') histForm(byId('hist', id).rifleId, byId('hist', id));
  else if (a === 'del-group') deleteGroup(id);
  else if (a === 'theme') { try { localStorage.setItem('theme', t.dataset.v); } catch (err) { /* private mode: applies for this visit only */ } applyTheme(t.dataset.v); viewAllKeepScroll(); }
  else if (a === 'accent') { try { localStorage.setItem('accent', t.dataset.v); } catch (err) { /* private mode: applies for this visit only */ } applyTheme(themePref(), t.dataset.v); viewAllKeepScroll(); }
  else if (a === 'go') { if (!e.target.closest('a')) location.hash = t.dataset.href; }
  else if (a === 'la-sort') { LA.sort = t.dataset.v; viewAllKeepScroll(); }
  else if (a === 'new-session') sessionForm(id, null);
  else if (a === 'edit-session') { const se = byId('sessions', id); if (se) sessionForm(se.rifleId, se); }
  else if (a === 'apply-update') { if (updateWorker) updateWorker.postMessage({ type: 'SKIP_WAITING' }); }
  else if (a === 'snooze') { S.cfg.snooze = Date.now() + 864e5; saveCfg(); renderBanners(); }
  else if (a === 'export') exportData();
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
document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.item[data-act]')) { e.preventDefault(); e.target.click(); } });
document.addEventListener('change', (e) => {
  const k = e.target.dataset && e.target.dataset.filter;
  if (k) { F[k] = e.target.value; viewAllKeepScroll(); }
  if (e.target.id === 'best-thin') { showThin = e.target.checked; viewAllKeepScroll(); }
  if (e.target.id === 'la-bullet') { LA.bullet = e.target.value; viewAllKeepScroll(); }
  if (e.target.id === 'la-powder') { LA.powder = e.target.value; viewAllKeepScroll(); }
  if (e.target.id === 'la-powderB') { LA.powderB = e.target.value; viewAllKeepScroll(); }
  if (e.target.id === 'la-compare') { LA.compare = e.target.checked; viewAllKeepScroll(); }
  if (e.target.id === 'la-ladderthin') { LA.ladderThin = e.target.checked; viewAllKeepScroll(); }
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

(async function init() {
  try {
    db = await openDB();
    await loadAll();
    await migrate();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) {
    main(`<div class="card"><b>Storage unavailable.</b><div class="muted">${esc(e.message)}. This app needs IndexedDB (not private-browsing mode).</div></div>`);
    return;
  }
  render();
  initUpdates();
})();
