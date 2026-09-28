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

/* ---------- IndexedDB (all data stays on this device) ---------- */
const STORES = ['rifles', 'bullets', 'powders', 'primers', 'cases', 'groups', 'hist'];
let db;
const S = {};
const rp = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const store = (s, m) => db.transaction(s, m).objectStore(s);
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('loadtracker', 1);
    r.onupgradeneeded = () => { for (const s of STORES) r.result.createObjectStore(s, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function loadAll() { for (const s of STORES) S[s] = await rp(store(s, 'readonly').getAll()); }
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
  const blob = new Blob([JSON.stringify({ app: '308-load-dev-tracker', version: 1, exported: new Date().toISOString(), data }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `load-dev-backup-${today()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
const ckey = (g) => [g.bulletId, g.powderId, Number(g.charge), g.primerId, Number(g.jump)].join('|');
function combos(groups) {
  const m = new Map();
  for (const g of groups) {
    if (g.include === false) continue;
    if (!m.has(ckey(g))) m.set(ckey(g), { key: ckey(g), bulletId: g.bulletId, powderId: g.powderId, charge: g.charge, primerId: g.primerId, jump: g.jump, groups: [] });
    m.get(ckey(g)).groups.push(g);
  }
  return [...m.values()].map((c) => {
    const st = c.groups.map(gstats);
    const mrs = st.filter((s) => s.mr !== null);
    const wn = mrs.reduce((a, s) => a + s.n, 0);
    const ess = st.filter((s) => s.es !== null);
    const vs = st.filter((s) => s.vavg !== null);
    const vn = vs.reduce((a, s) => a + s.vn, 0);
    return {
      ...c,
      nGroups: c.groups.length,
      nShots: c.groups.reduce((a, g) => a + g.shots.length, 0),
      mr: wn ? mrs.reduce((a, s) => a + s.mr * s.n, 0) / wn : null,
      es: ess.length ? ess.reduce((a, s) => a + s.es, 0) / ess.length : null,
      vel: vn ? vs.reduce((a, s) => a + s.vavg * s.vn, 0) / vn : null
    };
  }).sort((a, b) => (a.mr ?? 9e9) - (b.mr ?? 9e9));
}
function sessionOrder(rid, date) {
  return S.groups.filter((g) => g.rifleId === rid && g.date === date).sort((a, b) => a.ts - b.ts);
}
function sessionFouling(rid, date, excludeId) {
  const gs = sessionOrder(rid, date).filter((g) => g.id !== excludeId);
  const f = gs.find((g) => fin(g.fouling));
  return f ? f.fouling : null;
}
function roundsSinceClean(g) {
  const gs = sessionOrder(g.rifleId, g.date);
  let acc = sessionFouling(g.rifleId, g.date) ?? 0;
  for (const x of gs) { if (x.id === g.id) return acc; acc += x.shots.length; }
  return null;
}
function rifleTotals(rid) {
  const gs = S.groups.filter((g) => g.rifleId === rid);
  const shots = gs.reduce((a, g) => a + g.shots.length, 0);
  const dates = [...new Set(gs.map((g) => g.date))];
  const fouling = dates.reduce((a, d) => a + (sessionFouling(rid, d) ?? 0), 0);
  const r = byId('rifles', rid);
  const start = r && fin(r.startRounds) ? r.startRounds : 0;
  return { shots, fouling, start, barrel: start + shots + fouling };
}

/* ---------- labels ---------- */
const bl = (id) => { const b = byId('bullets', id); return b ? b.name + (fin(b.weight) ? ' ' + b.weight + ' gn' : '') : '?'; };
const nm = (s, id) => (byId(s, id) || {}).name || '?';
const comboLabel = (c) => `${bl(c.bulletId)} · ${nm('powders', c.powderId)} ${c.charge} gn · ${nm('primers', c.primerId)} · ${c.jump} thou`;

/* ---------- UI plumbing ---------- */
const bar = (left, title, right = '') => { $('#bar').innerHTML = `${left || '<span style="min-width:64px"></span>'}<div class="t">${esc(title)}</div>${right || '<span style="min-width:64px"></span>'}`; };
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
        : `<input class="in ${f.type === 'num' ? 'm' : ''}" id="d-${f.k}" type="text" ${f.type === 'num' ? 'inputmode="decimal"' : ''} value="${esc(vals[f.k] ?? '')}" autocomplete="off">`}</div>`).join('')}
    <div class="grid2"><button class="btn pri" value="ok">Save</button><button class="btn" value="cancel" type="button" id="d-x">Cancel</button></div>
    ${onDelete ? '<button class="btn danger sm" type="button" id="d-del">Delete</button>' : ''}</form>`;
  document.body.appendChild(d);
  const close = () => { d.close(); d.remove(); };
  $('#d-x', d).onclick = close;
  d.addEventListener('cancel', () => setTimeout(() => d.remove(), 0));
  if (onDelete) $('#d-del', d).onclick = async () => { if (await onDelete()) close(); };
  $('form', d).onsubmit = async (e) => {
    e.preventDefault();
    const out = {};
    for (const f of fields) {
      const raw = $('#d-' + f.k, d).value.trim();
      out[f.k] = f.type === 'num' ? num(raw) : raw;
      if (f.req && (out[f.k] === null || out[f.k] === '')) { toast(`${f.label} is required`); return; }
    }
    await onSave(out);
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
    return `<a class="item" href="#/rifle/${r.id}"><div><b style="font-size:20px">${esc(r.name)}</b><small>${esc(r.caliber || '')}${r.barrel ? ' · ' + r.barrel + ' in' : ''}</small></div><div style="text-align:right"><div class="mono v">${t.barrel}</div><small>barrel rounds</small></div></a>`;
  }).join('');
  main(`<h1>Rifles</h1>${rows || '<div class="card muted">No rifles yet. Add one to start logging.</div>'}
    <button class="btn pri" data-act="new-rifle">+ Add New Rifle</button>
    <a class="btn" href="#/settings">Settings · Components</a>
    <div class="muted">Stored on this device only. Use Export in Settings to back up.</div>`);
}

function rifleForm(r) {
  formDialog(r ? 'Edit rifle' : 'New rifle', [
    { k: 'name', label: 'Name / label', req: true },
    { k: 'caliber', label: 'Caliber' },
    { k: 'barrel', label: 'Barrel length (in)', type: 'num' },
    { k: 'startRounds', label: 'Rounds already through barrel', type: 'num' }
  ], r || { caliber: '.308 Win' }, async (v) => {
    await put('rifles', { ...(r || { id: uid() }), name: v.name, caliber: v.caliber, barrel: v.barrel, startRounds: v.startRounds ?? 0 });
  }, r ? async () => {
    if (!confirm(`Delete "${r.name}" and ALL its groups? This cannot be undone.`)) return false;
    for (const g of S.groups.filter((g2) => g2.rifleId === r.id)) await del('groups', g.id);
    for (const h of S.hist.filter((h2) => h2.rifleId === r.id)) await del('hist', h.id);
    await del('rifles', r.id);
    location.hash = '#/';
    return true;
  } : null);
}

function comboRow(c, best) {
  const ranked = c.nGroups >= 2;
  return `<div class="card" ${best ? 'style="border:2px solid var(--green)"' : ''}>
    <b>${esc(comboLabel(c))}</b>
    <div class="grid4"><div><div class="lbl">Grp</div><span class="mono v">${c.nGroups}</span></div><div><div class="lbl">Shots</div><span class="mono v">${c.nShots}</span></div>
    <div><div class="lbl">MR</div><span class="mono v">${fmt(c.mr)}</span></div><div><div class="lbl">Vel</div><span class="mono v">${fin(c.vel) ? Math.round(c.vel) : '—'}</span></div></div>
    <div class="muted">ES ${fmt(c.es)}" (average of each group's calculated ES) · MR weighted by shots</div>
    ${ranked ? '' : '<div class="warn">Not enough data yet — needs 2+ groups</div>'}</div>`;
}

function viewRifle(rid) {
  const r = byId('rifles', rid);
  if (!r) return viewHome();
  bar(back('#/', 'Rifles'), r.name, `<button class="r" data-act="edit-rifle" data-id="${rid}">Edit</button>`);
  const gs = S.groups.filter((g) => g.rifleId === rid);
  const cs = combos(gs);
  const best = cs.find((c) => c.nGroups >= 2 && c.mr !== null);
  const t = rifleTotals(rid);
  main(`<div class="muted">${esc(r.caliber || '')}${r.barrel ? ' · ' + r.barrel + ' in barrel' : ''}</div>
    <div class="hero"><div class="lbl">Current best load</div>
    ${best ? `<div style="font-size:19px;font-weight:600">${esc(bl(best.bulletId))} · ${esc(nm('powders', best.powderId))}</div>
      <div class="mono">${best.charge} gn · ${esc(nm('primers', best.primerId))} · ${best.jump} thou jump</div>
      <div class="big mono">${fmt(best.mr)}"</div><div>pooled mean radius · ${best.nGroups} groups · ${best.nShots} shots</div>`
      : `<div style="font-size:19px;font-weight:600">Not enough data yet</div><div>Needs 2+ groups at the exact same Bullet + Powder + Charge + Primer + Jump.</div>`}</div>
    <div class="grid2"><div class="card"><div class="lbl">Shots logged</div><div class="mono v" style="font-size:30px">${t.shots}</div></div>
    <div class="card"><div class="lbl">Barrel total</div><div class="mono v" style="font-size:30px">${t.barrel}</div><div class="muted">${t.start} start + ${t.shots} logged + ${t.fouling} fouling</div></div></div>
    <a class="btn dark" href="#/add/${rid}">+ Add New Group</a>
    <a class="btn" href="#/all/${rid}">View All Data</a>
    ${cs.length ? `<h2>Combos · pooled (Include = Y only)</h2>${cs.map((c) => comboRow(c, c === best)).join('')}` : ''}`);
}

function viewAll(rid) {
  const r = byId('rifles', rid);
  if (!r) return viewHome();
  if (F.rid !== rid) F = { rid, powder: '', bullet: '', primer: '', charge: '', jump: '' };
  bar(back('#/rifle/' + rid, r.name), 'All Data');
  const all = S.groups.filter((g) => g.rifleId === rid);
  const gs = all.filter((g) => (!F.powder || g.powderId === F.powder) && (!F.bullet || g.bulletId === F.bullet) && (!F.primer || g.primerId === F.primer) &&
    (!F.charge || String(Number(g.charge)) === F.charge) && (!F.jump || String(Number(g.jump)) === F.jump));
  const used = (k, s) => S[s].filter((x) => all.some((g) => g[k] === x.id));
  const dist = (k) => [...new Set(all.map((g) => String(Number(g[k]))))].sort((a, b) => a - b);
  const sel = (key, label, inner) => `<div class="f"><label class="lbl" for="F-${key}">${label}</label><select class="in" style="min-height:48px;font-size:16px" id="F-${key}" data-filter="${key}">${inner}</select></div>`;
  const list = gs.slice().sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts).map((g) => {
    const s = gstats(g);
    return `<a class="card ${g.include === false ? 'excl' : ''}" href="#/group/${g.id}">
      <div class="row sb"><b>${esc(g.date)} · ${esc(nm('powders', g.powderId))} ${g.charge} gn</b>${g.include === false ? '<span class="tag a">Excluded</span>' : g.reference ? '<span class="tag g">Ref</span>' : ''}</div>
      <div class="muted">${esc(bl(g.bulletId))} · ${esc(nm('primers', g.primerId))} · ${g.jump} thou · RSC ${roundsSinceClean(g) ?? '—'}</div>
      <div class="grid3"><div><div class="lbl">MR</div><span class="mono v">${fmt(s.mr)}</span></div><div><div class="lbl">ES</div><span class="mono v">${fmt(s.es)}</span></div><div><div class="lbl">Shots</div><span class="mono v">${s.total}</span></div></div></a>`;
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
    ${sel('jump', 'Jump', '<option value="">All</option>' + dist('jump').map((c) => `<option${c === F.jump ? ' selected' : ''}>${c}</option>`).join(''))}</div>
    <div class="muted">${gs.length} of ${all.length} groups shown · newest first</div>
    ${list || '<div class="card muted">No groups match.</div>'}
    ${cs.length ? `<h2>Pooled combos (filtered)</h2>${cs.map((c) => comboRow(c, false)).join('')}` : ''}
    <h2>Historical · manual ES only</h2>
    <div class="muted">Pre-existing data without X/Y. Kept separate — never mixed into mean-radius stats.</div>
    ${[...hmap.values()].map((arr) => { const es = arr.filter((h) => fin(h.es)); const avg = es.length ? es.reduce((a, h) => a + h.es, 0) / es.length : null;
      return `<div class="card"><b>${esc(bl(arr[0].bulletId))} · ${esc(nm('powders', arr[0].powderId))} ${arr[0].charge} gn</b><div class="kv"><span>Reference avg ES (${es.length} entr${es.length === 1 ? 'y' : 'ies'})</span><b>${fmt(avg)}"</b></div>
      ${arr.map((h) => `<div class="row sb muted"><span>${esc(h.note || '—')} · ES ${fmt(h.es)}</span><button class="btn sm" data-act="edit-hist" data-id="${h.id}">Edit</button></div>`).join('')}</div>`; }).join('')}
    <button class="btn" data-act="new-hist" data-id="${rid}">+ Add historical entry</button>`);
}

function histForm(rid, h) {
  if (!S.bullets.length || !S.powders.length) { toast('Add a bullet and powder in Settings first'); return; }
  formDialog(h ? 'Edit historical entry' : 'Historical entry', [
    { k: 'bulletId', label: 'Bullet', type: 'select', opts: S.bullets.map((b) => [b.id, bl(b.id)]) },
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
    ${rings.map((r) => `<circle cx="0" cy="0" r="${r}" fill="none" stroke="#d5d2c6" stroke-width="${E / 200}"/>`).join('')}
    <line x1="${-E}" y1="0" x2="${E}" y2="0" stroke="#b9b6a8" stroke-width="${E / 200}"/><line x1="0" y1="${-E}" x2="0" y2="${E}" stroke="#b9b6a8" stroke-width="${E / 200}"/>
    ${pts.map((p, i) => `<circle cx="${p.x}" cy="${-p.y}" r="${rad}" fill="rgba(63,91,46,.45)" stroke="#3f5b2e" stroke-width="${E / 250}"/><text x="${p.x}" y="${-p.y + E / 60}" font-size="${E / 22}" text-anchor="middle" fill="#1b1f1a">${g.shots.indexOf(p) + 1}</text>`).join('')}
    ${s.cx !== null ? `<path d="M${s.cx - E / 25} ${-s.cy}H${s.cx + E / 25}M${s.cx} ${-s.cy - E / 25}V${-s.cy + E / 25}" stroke="#a12b1f" stroke-width="${E / 90}"/>` : ''}
    <circle cx="0" cy="0" r="${E / 60}" fill="#1b1f1a"/></svg>
    <div class="muted">Plot: rings every 0.25" from point of aim · red cross = group center · circles drawn at bullet diameter.</div>`;
}

function viewGroup(gid) {
  const g = byId('groups', gid);
  if (!g) return viewHome();
  const s = gstats(g);
  bar(back('#/all/' + g.rifleId, 'All Data'), g.date, `<a class="r" href="#/edit/${gid}">Edit</a>`);
  const sess = sessionOrder(g.rifleId, g.date);
  main(`<div><h1 style="font-size:24px">${esc(g.date)} · Group ${sess.findIndex((x) => x.id === g.id) + 1}</h1>
    <div class="muted">${esc(bl(g.bulletId))} · ${esc(nm('powders', g.powderId))} ${g.charge} gn · ${esc(nm('primers', g.primerId))} · ${g.jump} thou</div>
    <div class="muted">${fin(g.temp) ? g.temp + ' F · ' : ''}${esc(g.wind || '')}</div>
    <div class="row" style="margin-top:6px">${g.include === false ? '<span class="tag a">Excluded from analysis</span>' : '<span class="tag g">Included</span>'}${g.reference ? '<span class="tag g">Reference group</span>' : ''}</div></div>
    <div class="hero"><div class="grid2"><div><div class="lbl">Mean radius</div><div class="big mono">${fmt(s.mr)}"</div></div><div><div class="lbl">ES (center)</div><div class="big mono">${fmt(s.es)}"</div></div></div></div>
    ${plotSVG(g, s)}
    <div class="card"><div class="lbl">Extreme spread</div>
      <div class="kv"><span>Calculated, center-to-center</span><b>${fmt(s.es)}"</b></div>
      <div class="kv"><span>+ bullet dia ${fmt(s.dia)} = outside-to-outside</span><b>${fmt(s.esOO)}"</b></div>
      <div class="kv"><span>Manual caliper reading</span><b>${fin(g.esManual) ? fmt(g.esManual) + '"' : '—'}</b></div></div>
    <div class="card"><div class="lbl">Group center &amp; POA offset</div>
      <div class="kv"><span>Center X / Y</span><b>${sfmt(s.cx)} / ${sfmt(s.cy)}</b></div>
      <div class="kv"><span>Distance from POA</span><b>${fmt(s.poa)}"</b></div></div>
    <div class="card"><div class="lbl">Velocity · ${s.vn} of ${s.total} shots</div>
      <div class="kv"><span>Average</span><b>${fin(s.vavg) ? s.vavg.toFixed(0) + ' fps' : '—'}</b></div>
      <div class="kv"><span>Std dev (sample)</span><b>${fmt(s.vsd, 1)}</b></div>
      <div class="kv"><span>Extreme spread</span><b>${fmt(s.ves, 0)}</b></div></div>
    <div class="card"><div class="lbl">Session</div>
      <div class="kv"><span>Rounds since clean (at start of group)</span><b>${roundsSinceClean(g) ?? '—'}</b></div>
      <div class="kv"><span>COAL / trimmed length</span><b>${fin(g.coal) ? g.coal : '—'} / ${fin(g.trim) ? g.trim : '—'}</b></div></div>
    <div class="card"><div class="lbl">Shots</div><table><thead><tr><th>#</th><th>Vel</th><th>X</th><th>Y</th><th>Rad</th></tr></thead><tbody>
      ${g.shots.map((p, i) => `<tr><td>${i + 1}</td><td>${fin(p.v) ? p.v : '—'}</td><td>${sfmt(p.x)}</td><td>${sfmt(p.y)}</td><td>${fin(p.x) && fin(p.y) && s.cx !== null ? fmt(Math.hypot(p.x - s.cx, p.y - s.cy)) : '—'}</td></tr>`).join('')}</tbody></table></div>
    ${g.notes ? `<div class="card"><div class="lbl">Notes</div>${esc(g.notes)}</div>` : ''}
    <a class="btn dark" href="#/add/${g.rifleId}?from=${g.id}">+ Add another group (same load)</a>
    <button class="btn danger" data-act="del-group" data-id="${g.id}">Delete group</button>`);
}

function shotRow(i, p = {}) {
  const c = (cls, val, lab, sign) => `<td class="cell"><input class="in m ${cls}" inputmode="decimal" aria-label="Shot ${i + 1} ${lab}" value="${fin(val) ? val : ''}" autocomplete="off">${sign ? '<button type="button" class="sg" data-act="sign" aria-label="Toggle sign">±</button>' : ''}</td>`;
  return `<tr><td class="mono" style="width:24px;padding:0"><b>${i + 1}</b></td>${c('sv', p.v, 'velocity', false)}${c('sx', p.x, 'X', true)}${c('sy', p.y, 'Y', true)}</tr>`;
}

function viewGroupForm(rid, gid, fromId) {
  const r = byId('rifles', rid);
  if (!r) return viewHome();
  const g0 = gid ? byId('groups', gid) : null;
  const src = g0 || (fromId && byId('groups', fromId)) || S.groups.filter((g) => g.rifleId === rid).sort((a, b) => b.ts - a.ts)[0] || {};
  const missing = !S.bullets.length || !S.powders.length || !S.primers.length;
  bar(back(g0 ? '#/group/' + gid : '#/rifle/' + rid, g0 ? 'Group' : r.name), g0 ? 'Edit Group' : 'New Group');
  const date = g0 ? g0.date : (fromId && src.date) || today();
  const nShots = g0 ? g0.shots.length : 5;
  const sec = (t) => `<h2 style="color:var(--green);border-color:var(--green)">${t}</h2>`;
  const fld = (id, label, val, cls = 'm', extra = '') => `<div class="f"><label class="lbl" for="${id}">${label}</label><input class="in ${cls}" id="${id}" type="text" ${cls === 'm' ? 'inputmode="decimal"' : ''} value="${esc(val ?? '')}" autocomplete="off" ${extra}></div>`;
  const yn = (name, on) => `<div class="seg"><label><input type="radio" name="${name}" value="1"${on ? ' checked' : ''}><span>Y</span></label><label><input type="radio" name="${name}" value="0"${on ? '' : ' checked'}><span>N</span></label></div>`;
  main(`${missing ? '<div class="card warn">Add at least one Bullet, Powder and Primer in <a href="#/settings" style="text-decoration:underline">Settings</a> first.</div>' : ''}
    <form id="gform" autocomplete="off">
    ${sec('SESSION')}
    ${fld('f-date', 'Session date', date, '', 'inputmode="numeric"')}
    <div class="grid2">${fld('f-temp', 'Temp (F)', g0 ? g0.temp : '')}<div id="foulbox"></div></div>
    ${fld('f-wind', 'Wind / conditions', g0 ? g0.wind : (fromId ? src.wind : ''), '')}
    ${sec('LOAD')}
    <div class="f"><label class="lbl" for="f-bullet">Bullet</label><select class="in" id="f-bullet">${opts(S.bullets, src.bulletId, (x) => x.name + (fin(x.weight) ? ' ' + x.weight + ' gn' : ''))}</select></div>
    <div class="f"><label class="lbl" for="f-powder">Powder</label><select class="in" id="f-powder">${opts(S.powders, src.powderId, (x) => x.name)}</select></div>
    <div class="grid2">${fld('f-charge', 'Charge (gn)', src.charge)}${fld('f-jump', 'Jump (thou off lands)', src.jump)}</div>
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
  const foul = () => {
    const d = $('#f-date').value.trim();
    const inh = sessionFouling(rid, d, gid);
    $('#foulbox').innerHTML = inh !== null
      ? `<div class="f"><span class="lbl">Fouling shots</span><div class="muted">Session already has ${inh} fouling shots — inherited.</div></div>`
      : fld('f-foul', 'Fouling shots', g0 && fin(g0.fouling) ? g0.fouling : '');
  };
  foul();
  form.addEventListener('input', (e) => { if (e.target.id === 'f-date') foul(); preview(); });
  form.addEventListener('change', preview);
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
    <div class="muted">${s.n} shot${s.n === 1 ? '' : 's'} with X/Y · ${s.vn} with velocity${s.n === 1 ? ' · mean radius needs 2+ shots' : ''}</div>`;
}
async function saveGroup(rid, gid, g0) {
  const date = $('#f-date').value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('Date must be YYYY-MM-DD');
  const charge = num($('#f-charge').value), jump = num($('#f-jump').value);
  if (charge === null) return toast('Charge weight is required');
  if (jump === null) return toast('Jump / seating depth is required');
  const shots = readShots();
  if (!shots.length) return toast('Enter at least one shot');
  const foulEl = $('#f-foul');
  const inherited = sessionFouling(rid, date, gid) !== null;
  const g = {
    id: gid || uid(), rifleId: rid, ts: g0 ? g0.ts : Date.now(), date,
    bulletId: $('#f-bullet').value, powderId: $('#f-powder').value, primerId: $('#f-primer').value,
    charge, jump, coal: num($('#f-coal').value), trim: num($('#f-trim').value),
    wind: $('#f-wind').value.trim(), temp: num($('#f-temp').value),
    fouling: inherited ? null : (foulEl ? num(foulEl.value) ?? 0 : 0),
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
  if (fin(g.fouling)) { // hand the session's fouling count to the next-earliest remaining group
    const nxt = sessionOrder(g.rifleId, g.date)[0];
    if (nxt) await put('groups', { ...nxt, fouling: g.fouling });
  }
  location.hash = '#/rifle/' + g.rifleId;
}

function viewSettings() {
  bar(back('#/', 'Rifles'), 'Settings');
  const lib = (title, s, sub) => `<h2 class="row sb" style="align-items:center">${title}<button class="btn sm" data-act="lib-new" data-s="${s}">+ Add</button></h2>
    ${S[s].slice().sort((a, b) => a.name.localeCompare(b.name)).map((x) => `<div class="item" role="button" tabindex="0" data-act="lib-edit" data-s="${s}" data-id="${x.id}"><div>${esc(x.name)}${sub(x) ? `<small>${esc(sub(x))}</small>` : ''}</div><span class="muted">Edit</span></div>`).join('') || '<div class="muted">None yet.</div>'}`;
  main(`<h1>Components</h1>
    ${lib('RIFLES', 'rifles', (x) => `${x.caliber || ''}${x.barrel ? ' · ' + x.barrel + ' in' : ''} · start ${x.startRounds || 0} rds`).replace('data-act="lib-new" data-s="rifles"', 'data-act="new-rifle"')}
    ${lib('BULLETS', 'bullets', (x) => `${fin(x.weight) ? x.weight + ' gn' : ''}${fin(x.diameter) ? ' · dia ' + x.diameter + ' in' : ''}`)}
    ${lib('POWDERS', 'powders', () => '')}
    ${lib('PRIMERS', 'primers', () => '')}
    ${lib('CASES · optional', 'cases', () => '')}
    <h2>BACKUP</h2>
    <div class="muted">Data lives only on this device. Export a JSON file to back up or move it to another device.</div>
    <div class="grid2"><button class="btn dark" data-act="export">Export data</button><button class="btn" data-act="import">Import data</button></div>
    <input type="file" id="imp" accept="application/json,.json" hidden>
    <div class="muted" id="persist"></div>`);
  $('#imp').onchange = (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; };
  if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then((p) => { const el = $('#persist'); if (el) el.textContent = p ? 'Storage: persistent.' : 'Storage: browser-managed. Export backups occasionally.'; });
}

const LIBS = {
  bullets: [{ k: 'name', label: 'Manufacturer / name', req: true }, { k: 'weight', label: 'Weight (gn)', type: 'num' }, { k: 'diameter', label: 'Diameter (in)', type: 'num', req: true }],
  powders: [{ k: 'name', label: 'Name', req: true }],
  primers: [{ k: 'name', label: 'Name', req: true }],
  cases: [{ k: 'name', label: 'Manufacturer / name', req: true }]
};
const USE = { bullets: 'bulletId', powders: 'powderId', primers: 'primerId' };
function libForm(s, x) {
  formDialog(x ? 'Edit' : 'Add', LIBS[s], x || (s === 'bullets' ? { diameter: 0.308 } : {}), async (v) => { await put(s, { ...(x || { id: uid() }), ...v }); },
    x ? async () => {
      if (USE[s] && S.groups.some((g) => g[USE[s]] === x.id)) { toast('In use by logged groups — cannot delete'); return false; }
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
    else if (p[0] === 'add') viewGroupForm(p[1], null, q.get('from'));
    else if (p[0] === 'edit') { const g = byId('groups', p[1]); g ? viewGroupForm(g.rifleId, g.id) : viewHome(); }
    else if (p[0] === 'group') viewGroup(p[1]);
    else if (p[0] === 'settings') viewSettings();
    else viewHome();
  } catch (e) { console.error(e); main(`<div class="card"><b>Something went wrong showing this page.</b><div class="muted">${esc(e.message)}</div></div><a class="btn" href="#/">Home</a>`); }
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
});
function viewAllKeepScroll() { const y = window.scrollY; render(); window.scrollTo(0, y); }

(async function init() {
  try {
    db = await openDB();
    await loadAll();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) {
    main(`<div class="card"><b>Storage unavailable.</b><div class="muted">${esc(e.message)}. This app needs IndexedDB (not private-browsing mode).</div></div>`);
    return;
  }
  render();
})();
