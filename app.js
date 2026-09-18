/* Trip Split — append-only group expense splitter backed by a GitHub repo.
   Every entry is written as its own immutable file under data/entries/,
   so concurrent writers never conflict and nothing is ever overwritten. */

const DEFAULTS = {
  owner: 'janheitzmann0-svg',
  repo: 'Bruno_derPanda',
  branch: 'main',
  dir: 'data/entries',
  admin: 'p_jan',        // Jan — may add/rename people, set the rate and undo anything
  rate: 0.92,            // EUR per USD, static for the whole trip
  rateLabel: 'set at setup'
};

const LS = {
  get(k, d) { try { const v = localStorage.getItem('ts_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('ts_' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('ts_' + k); } catch (e) {} }
};

const cfg = Object.assign({}, DEFAULTS, LS.get('cfg', {}));
const saveCfg = () => LS.set('cfg', cfg);

let entries = LS.get('entries', {});      // id -> entry
let files = LS.get('files', {});          // filename -> entry id (immutable, so cacheable)
let queue = LS.get('queue', []);          // entries written offline, awaiting push
let tab = 'add';
let busy = false;

const $ = s => document.querySelector(s);
const el = (h) => { const d = document.createElement('div'); d.innerHTML = h.trim(); return d.firstElementChild; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const r2 = n => Math.round(n * 100) / 100;
const usd = n => '$' + (Math.abs(n) < 0.005 ? 0 : n).toFixed(2);
const eur = n => '€' + (Math.abs(n) < 0.005 ? 0 : n).toFixed(2);

let toastBox = null;
const isAdmin = () => cfg.meId === cfg.admin;

function toast(msg, ms) {
  if (!toastBox) { toastBox = el('<div class="toasts"></div>'); document.body.appendChild(toastBox); }
  const t = el('<div class="toast">' + esc(msg) + '</div>');
  toastBox.appendChild(t);
  setTimeout(() => t.remove(), ms || 2600);
}

// Nag about the missing token at most once a minute, not once per entry.
let nagged = 0;
function nagToken() {
  if (Date.now() - nagged < 60000) return;
  nagged = Date.now();
  toast('Saved on this phone only — paste the group code in Settings so everyone sees it', 5000);
}

/* ---------------- derived state ---------------- */

function derive() {
  const all = Object.values(entries).sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : 1));
  const voided = new Set();
  for (const e of all) if (e.type === 'void' && e.target) voided.add(e.target);

  const live = all.filter(e => !voided.has(e.id));
  const people = [];
  const byId = {};
  let rate = cfg.rate, rateLabel = cfg.rateLabel, rateTs = 0;

  for (const e of live) {
    if (e.type === 'person') { const p = { id: e.id, name: e.name, ts: e.ts }; people.push(p); byId[e.id] = p; }
    if (e.type === 'rate' && e.eurPerUsd > 0) { rate = e.eurPerUsd; rateLabel = e.label || ''; rateTs = e.ts; }
    if (e.type === 'rename' && byId[e.target]) byId[e.target].name = e.name;
  }
  people.sort((a, b) => a.name.localeCompare(b.name));

  const net = {};                 // >0 => others owe them
  const pair = {};                // "debtor|creditor" -> gross usd
  for (const p of people) net[p.id] = 0;
  const bump = (d, c, amt) => {
    net[d] = (net[d] || 0) - amt;
    net[c] = (net[c] || 0) + amt;
    const k = d + '|' + c;
    pair[k] = (pair[k] || 0) + amt;
  };

  for (const e of live) {
    if (e.type === 'expense') {
      for (const s of (e.shares || [])) {
        if (!s.usd || s.p === e.payer) continue;
        bump(s.p, e.payer, s.usd);
      }
    } else if (e.type === 'settle' && e.usd) {
      bump(e.to, e.from, e.usd);  // `from` hands cash to `to`: reduces from's debt
    }
  }

  return { all, live, voided, people, byId, net, pair, rate, rateLabel, rateTs, rateSet: rateTs > 0 };
}

/* Net every pair off against each other, then minimise the number of transfers. */
function plan(st) {
  const owed = [];
  for (const p of st.people) {
    const v = r2(st.net[p.id] || 0);
    if (Math.abs(v) >= 0.01) owed.push({ id: p.id, v });
  }
  const debt = owed.filter(o => o.v < 0).map(o => ({ id: o.id, v: -o.v })).sort((a, b) => b.v - a.v);
  const cred = owed.filter(o => o.v > 0).map(o => ({ id: o.id, v: o.v })).sort((a, b) => b.v - a.v);
  const tx = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const amt = r2(Math.min(debt[i].v, cred[j].v));
    if (amt >= 0.01) tx.push({ from: debt[i].id, to: cred[j].id, usd: amt });
    debt[i].v = r2(debt[i].v - amt);
    cred[j].v = r2(cred[j].v - amt);
    if (debt[i].v < 0.01) i++;
    if (cred[j].v < 0.01) j++;
  }
  return tx;
}

/* ---------------- GitHub sync ---------------- */

function api(path, opts) {
  const o = Object.assign({ headers: {} }, opts || {});
  o.headers['Accept'] = 'application/vnd.github+json';
  o.headers['X-GitHub-Api-Version'] = '2022-11-28';
  if (cfg.token) o.headers['Authorization'] = 'Bearer ' + cfg.token;
  return fetch('https://api.github.com' + path, o);
}

function setSync(state, text) {
  if (!$('#dot')) return;
  $('#dot').className = 'dot ' + state;
  $('#syncTxt').textContent = text;
}

async function pull() {
  const url = `/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.dir}?ref=${encodeURIComponent(cfg.branch)}&t=${Date.now()}`;
  const res = await api(url, { cache: 'no-store' });
  if (res.status === 404) return 0;                 // folder not created yet
  if (!res.ok) throw new Error('GitHub ' + res.status + ' — ' + (res.status === 401 ? 'bad token' : res.statusText));
  const list = await res.json();
  const fresh = list.filter(f => f.type === 'file' && f.name.endsWith('.json') && !files[f.name]);

  let added = 0;
  const pool = 8;
  for (let i = 0; i < fresh.length; i += pool) {
    const batch = fresh.slice(i, i + pool);
    setSync('busy', `loading ${Math.min(i + pool, fresh.length)}/${fresh.length}`);
    await Promise.all(batch.map(async f => {
      try {
        const r = await fetch(f.download_url, { cache: 'no-store' });
        if (!r.ok) return;
        const e = await r.json();
        if (e && e.id) { entries[e.id] = e; files[f.name] = e.id; added++; }
      } catch (err) { /* skip unreadable file */ }
    }));
  }
  if (added) { LS.set('entries', entries); LS.set('files', files); }
  return added;
}

function fileName(e) {
  return new Date(e.ts).toISOString().replace(/[:.]/g, '-') + '_' + e.id + '.json';
}

async function pushOne(e) {
  const body = JSON.stringify(e, null, 2) + '\n';
  const res = await api(`/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.dir}/${fileName(e)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `${e.type}: ${summaryLine(e)}`.slice(0, 90),
      content: btoa(unescape(encodeURIComponent(body))),
      branch: cfg.branch
    })
  });
  if (res.status === 422) return true;   // already exists — treat as done
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('GitHub ' + res.status + ': ' + txt.slice(0, 160));
  }
  return true;
}

async function flush() {
  while (queue.length) {
    const e = queue[0];
    setSync('busy', `saving ${queue.length}`);
    await pushOne(e);
    queue.shift();
    LS.set('queue', queue);
  }
}

async function sync(silent) {
  if (busy) return;
  busy = true;
  try {
    setSync('busy', 'syncing');
    if (cfg.token) await flush();
    const n = await pull();
    setSync(cfg.token ? 'ok' : 'warn', (cfg.token ? 'synced ' : 'read-only ') + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    render();
    if (n && !silent) toast(n + ' new entr' + (n === 1 ? 'y' : 'ies'));
  } catch (err) {
    setSync('bad', 'offline');
    if (!silent) toast(String(err.message || err), 5000);
  } finally { busy = false; }
}

/* Record locally first (instant + offline-safe), then push. */
async function add(e) {
  e.id = e.id || uid();
  e.ts = e.ts || Date.now();
  e.by = cfg.meId || null;
  entries[e.id] = e;
  files[fileName(e)] = e.id;
  queue.push(e);
  LS.set('entries', entries); LS.set('files', files); LS.set('queue', queue);
  render();
  try {
    if (!cfg.token) { nagToken(); return; }
    await flush();
    setSync('ok', 'saved');
  } catch (err) {
    setSync('bad', 'queued');
    toast('Not uploaded yet: ' + (err.message || err) + ' — will retry', 5000);
  }
}

function summaryLine(e) {
  const st = derive();
  const nm = id => (st.byId[id] || {}).name || '?';
  if (e.type === 'person') return e.name;
  if (e.type === 'rate') return e.eurPerUsd + ' EUR/USD';
  if (e.type === 'void') return 'undo ' + e.target;
  if (e.type === 'rename') return 'renamed to ' + e.name;
  if (e.type === 'settle') return `${nm(e.from)} paid ${nm(e.to)} ${usd(e.usd)}`;
  if (e.type === 'expense') {
    const tot = (e.shares || []).reduce((a, s) => a + s.usd, 0);
    return `${nm(e.payer)} paid ${usd(tot)} — ${e.note || 'expense'}`;
  }
  return e.type;
}

/* ---------------- views ---------------- */

let draft = { payer: null, sel: [], total: '', note: '', equal: true, custom: {} };

function render() {
  const st = derive();
  cfgGuardRender(st);
  const v = $('#view');
  v.innerHTML = '';
  if (tab === 'add') v.appendChild(viewAdd(st));
  if (tab === 'balance') v.appendChild(viewBalance(st));
  if (tab === 'history') v.appendChild(viewHistory(st));
  if (tab === 'people') v.appendChild(viewPeople(st));
  if (tab === 'settings') v.appendChild(viewSettings(st));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const me = st.byId[cfg.meId];
  $('#whoBtn').textContent = me ? me.name : 'Who am I?';
}

function cfgGuardRender(st) {
  document.title = 'Saustall USA PayMe';
}

function rateNote(st) {
  if (!st.rateSet) {
    return `<div class="banner err"><b>No exchange rate set yet.</b> Euro amounts are shown with a
      placeholder of ${st.rate.toFixed(4)} €&nbsp;per&nbsp;$1.
      ${isAdmin() ? 'Set the real rate in <b>Settings</b> before the trip starts.'
                  : 'Ask ' + esc((st.byId[cfg.admin] || {}).name || 'the administrator') + ' to set it in the app.'}
      Dollar amounts are unaffected.</div>`;
  }
  const d = new Date(st.rateTs).toLocaleDateString();
  return `<div class="banner"><b>Fixed exchange rate:</b> $1 = ${st.rate.toFixed(4)} € · set on ${d}${st.rateLabel ? ' · ' + esc(st.rateLabel) : ''}<br>
    This is <b>not a live rate</b> — one fixed value for the whole trip.</div>`;
}

/* --- Add --- */
function viewAdd(st) {
  const wrap = el('<div></div>');

  if (!st.people.length) {
    wrap.appendChild(el(`<div class="card"><h2>First things first</h2>
      <p class="hint" style="margin-top:0">No people yet. Go to <b>People</b> and add everyone in the group, then pick who you are.</p>
      <button class="btn" id="goPeople">Add people</button></div>`));
    wrap.querySelector('#goPeople').onclick = () => { tab = 'people'; render(); };
    return wrap;
  }
  if (!cfg.meId) {
    wrap.appendChild(el(`<div class="card"><h2>Who are you?</h2>
      <p class="hint" style="margin-top:0">Pick your name once. It is stored on this phone only.</p>
      <div class="chips" id="pick"></div></div>`));
    const c = wrap.querySelector('#pick');
    st.people.forEach(p => {
      const b = el(`<div class="chip">${esc(p.name)}</div>`);
      b.onclick = () => { cfg.meId = p.id; saveCfg(); draft.payer = null; render(); };
      c.appendChild(b);
    });
    return wrap;
  }

  if (draft.payer === null) draft.payer = cfg.meId;
  if (!draft.sel.length) draft.sel = [cfg.meId];

  wrap.appendChild(el(rateNote(st)));

  const card = el(`<div class="card">
    <h2>New expense</h2>
    <label>Who paid the bill?</label>
    <select id="payer"></select>
    <div style="height:12px"></div>
    <label>Who is it for? <span class="muted" id="selCount"></span></label>
    <div class="chips" id="forWhom"></div>
    <div class="row" style="margin-top:6px">
      <button class="btn sec sm" id="selAll" type="button">Everyone</button>
      <button class="btn sec sm" id="selMe" type="button">Only me</button>
      <button class="btn sec sm" id="selNone" type="button">Clear</button>
    </div>
    <div style="height:14px"></div>
    <label>Amount in US dollars</label>
    <input id="total" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00">
    <div class="hint" id="conv"></div>
    <div style="height:12px"></div>
    <label>What for?</label>
    <input id="note" placeholder="e.g. Dinner at Joe's">
    <div style="height:12px"></div>
    <div class="split" style="border:none;padding:0">
      <span class="muted" style="font-size:13px">Split equally</span>
      <button class="btn sec sm" id="eqBtn" type="button"></button>
    </div>
    <div id="customBox"></div>
    <div style="height:14px"></div>
    <button class="btn" id="save">Save expense</button>
    <div class="hint" id="preview"></div>
  </div>`);
  wrap.appendChild(card);

  const payer = card.querySelector('#payer');
  st.people.forEach(p => payer.appendChild(el(`<option value="${p.id}">${esc(p.name)}${p.id === cfg.meId ? ' (me)' : ''}</option>`)));
  payer.value = draft.payer;
  payer.onchange = () => { draft.payer = payer.value; refresh(); };

  const fw = card.querySelector('#forWhom');
  st.people.forEach(p => {
    const b = el(`<div class="chip${draft.sel.includes(p.id) ? ' on' : ''}${p.id === cfg.meId ? ' me' : ''}">${esc(p.name)}</div>`);
    b.onclick = () => {
      const i = draft.sel.indexOf(p.id);
      if (i < 0) draft.sel.push(p.id); else draft.sel.splice(i, 1);
      render();
    };
    fw.appendChild(b);
  });
  card.querySelector('#selAll').onclick = () => { draft.sel = st.people.map(p => p.id); render(); };
  card.querySelector('#selMe').onclick = () => { draft.sel = [cfg.meId]; render(); };
  card.querySelector('#selNone').onclick = () => { draft.sel = []; render(); };

  const total = card.querySelector('#total');
  total.value = draft.total;
  total.oninput = () => { draft.total = total.value; refresh(); };
  const note = card.querySelector('#note');
  note.value = draft.note;
  note.oninput = () => { draft.note = note.value; };

  const eqBtn = card.querySelector('#eqBtn');
  eqBtn.onclick = () => { draft.equal = !draft.equal; render(); };

  function shares() {
    const sel = draft.sel;
    if (!sel.length) return [];
    if (draft.equal) {
      const t = Math.round((parseFloat(draft.total) || 0) * 100);
      const base = Math.floor(t / sel.length);
      let rest = t - base * sel.length;
      return sel.map((p, i) => ({ p, usd: (base + (i < rest ? 1 : 0)) / 100 }));
    }
    return sel.map(p => ({ p, usd: r2(parseFloat(draft.custom[p]) || 0) }));
  }

  function refresh() {
    const sh = shares();
    const sum = sh.reduce((a, s) => a + s.usd, 0);
    card.querySelector('#selCount').textContent = draft.sel.length ? `· ${draft.sel.length} selected` : '';
    card.querySelector('#conv').innerHTML = sum ? `= <b>${eur(sum * st.rate)}</b> at the fixed rate` : '';
    eqBtn.textContent = draft.equal ? 'Equal ✓' : 'Custom';
    const nm = id => (st.byId[id] || {}).name || '?';
    const others = sh.filter(s => s.p !== draft.payer && s.usd > 0);
    card.querySelector('#preview').innerHTML = others.length
      ? others.map(s => `${esc(nm(s.p))} owes ${esc(nm(draft.payer))} <b>${eur(s.usd * st.rate)}</b> <span class="muted">(${usd(s.usd)})</span>`).join('<br>')
      : '<span class="muted">Nobody owes anything yet — pick people and an amount.</span>';
    card.querySelector('#save').disabled = !(sum > 0 && draft.sel.length && draft.payer);
  }

  const cb = card.querySelector('#customBox');
  if (!draft.equal) {
    cb.appendChild(el('<div style="height:6px"></div>'));
    draft.sel.forEach(pid => {
      const row = el(`<div class="shareRow"><span class="nm">${esc((st.byId[pid] || {}).name || '?')}</span>
        <input type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00"></div>`);
      const inp = row.querySelector('input');
      inp.value = draft.custom[pid] || '';
      inp.oninput = () => { draft.custom[pid] = inp.value; refresh(); };
      cb.appendChild(row);
    });
    cb.appendChild(el('<div class="hint">Total is the sum of these amounts.</div>'));
  }

  card.querySelector('#save').onclick = async () => {
    const sh = shares().filter(s => s.usd > 0);
    if (!sh.length) return;
    await add({ type: 'expense', payer: draft.payer, note: draft.note.trim(), shares: sh, rate: st.rate });
    draft = { payer: cfg.meId, sel: [cfg.meId], total: '', note: '', equal: true, custom: {} };
    toast('Expense saved');
    tab = 'balance'; render();
  };

  refresh();
  return wrap;
}

/* --- Balance --- */
function viewBalance(st) {
  const wrap = el('<div></div>');
  if (!st.people.length) return el('<div class="card"><p class="hint">Add people first.</p></div>');

  const nm = id => (st.byId[id] || {}).name || '?';
  const tx = plan(st);
  const me = cfg.meId;

  if (me) {
    const bal = r2(st.net[me] || 0);
    const mine = tx.filter(t => t.from === me || t.to === me);
    const c = el(`<div class="card">
      <h2>You — ${esc(nm(me))}</h2>
      <div class="big ${bal >= 0 ? 'pos' : 'neg'}">${bal >= 0 ? '+' : '−'}${eur(Math.abs(bal) * st.rate)}</div>
      <div class="sub">${bal >= 0 ? 'you get back in total' : 'you owe in total'} · ${usd(Math.abs(bal))}</div>
      <div style="height:10px"></div>
      <div class="list" id="mine"></div>
    </div>`);
    const list = c.querySelector('#mine');
    if (!mine.length) list.appendChild(el('<div class="hint" style="margin:0">All settled up.</div>'));
    mine.forEach(t => {
      const out = t.from === me;
      const other = out ? t.to : t.from;
      const row = el(`<div class="item">
        <div class="g"><div class="t">${out ? 'Pay' : 'Get from'} ${esc(nm(other))}</div>
        <div class="s">${out ? 'you owe them' : 'they owe you'}</div></div>
        <div class="amt ${out ? 'neg' : 'pos'}">${eur(t.usd * st.rate)}<small>${usd(t.usd)}</small></div>
      </div>`);
      const b = el(`<button class="btn sec sm">Settle</button>`);
      b.onclick = () => settleSheet(st, t.from, t.to, t.usd);
      row.appendChild(b);
      list.appendChild(row);
    });
    wrap.appendChild(c);
  }

  const c2 = el('<div class="card"><h2>Everyone</h2><div id="all"></div></div>');
  const a = c2.querySelector('#all');
  st.people.forEach(p => {
    const v = r2(st.net[p.id] || 0);
    a.appendChild(el(`<div class="split">
      <span>${esc(p.name)}${p.id === me ? '<span class="tag">you</span>' : ''}</span>
      <span class="amt ${v > 0.005 ? 'pos' : (v < -0.005 ? 'neg' : 'muted')}">
        ${v >= 0 ? '+' : '−'}${eur(Math.abs(v) * st.rate)}<small>${usd(Math.abs(v))}</small></span>
    </div>`));
  });
  a.appendChild(el('<div class="hint">Plus = gets money back. Minus = still owes.</div>'));
  wrap.appendChild(c2);

  const c3 = el('<div class="card"><h2>Who pays whom</h2><div class="list" id="tx"></div></div>');
  const t3 = c3.querySelector('#tx');
  if (!tx.length) t3.appendChild(el('<div class="hint" style="margin:0">Nothing outstanding — everything cancels out.</div>'));
  tx.forEach(t => {
    const row = el(`<div class="item">
      <div class="g"><div class="t">${esc(nm(t.from))} → ${esc(nm(t.to))}</div>
      <div class="s">${usd(t.usd)} at the fixed rate</div></div>
      <div class="amt">${eur(t.usd * st.rate)}</div></div>`);
    const b = el('<button class="btn sec sm">Settle</button>');
    b.onclick = () => settleSheet(st, t.from, t.to, t.usd);
    row.appendChild(b);
    t3.appendChild(row);
  });
  c3.appendChild(el('<div class="hint">All debts between the group are added up and cancelled out, so this is the smallest number of payments that settles everything.</div>'));
  wrap.appendChild(c3);
  wrap.appendChild(el(rateNote(st)));
  return wrap;
}

function settleSheet(st, from, to, amt) {
  const nm = id => (st.byId[id] || {}).name || '?';
  const s = el(`<div class="sheet"><div class="inner">
    <h2 style="margin-top:0">Record a payment</h2>
    <p class="hint" style="margin-top:0">${esc(nm(from))} hands cash (or a transfer) to ${esc(nm(to))}. This does not delete anything — it is recorded as a repayment.</p>
    <label>Amount in US dollars</label>
    <input id="amt" type="number" inputmode="decimal" step="0.01" value="${amt.toFixed(2)}">
    <div class="hint" id="cv"></div>
    <div style="height:14px"></div>
    <button class="btn" id="ok">Record payment</button>
    <div style="height:8px"></div>
    <button class="btn sec" id="cancel">Cancel</button>
  </div></div>`);
  document.body.appendChild(s);
  const inp = s.querySelector('#amt');
  const cv = s.querySelector('#cv');
  const upd = () => cv.innerHTML = '= <b>' + eur((parseFloat(inp.value) || 0) * st.rate) + '</b>';
  inp.oninput = upd; upd();
  s.querySelector('#cancel').onclick = () => s.remove();
  s.onclick = e => { if (e.target === s) s.remove(); };
  s.querySelector('#ok').onclick = async () => {
    const v = r2(parseFloat(inp.value) || 0);
    if (v <= 0) return;
    s.remove();
    await add({ type: 'settle', from, to, usd: v });
    toast('Payment recorded');
  };
}

/* --- History --- */
function viewHistory(st) {
  const wrap = el('<div></div>');
  const nm = id => (st.byId[id] || {}).name || '?';
  const c = el('<div class="card"><h2>All entries</h2><div class="list" id="l"></div></div>');
  const l = c.querySelector('#l');
  const shown = st.all.filter(e => e.type === 'expense' || e.type === 'settle').reverse();
  if (!shown.length) l.appendChild(el('<div class="hint" style="margin:0">Nothing logged yet.</div>'));

  shown.forEach(e => {
    const dead = st.voided.has(e.id);
    const when = new Date(e.ts).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    let title, sub, amount;
    if (e.type === 'expense') {
      const tot = (e.shares || []).reduce((a, s) => a + s.usd, 0);
      title = esc(e.note || 'Expense');
      sub = `${esc(nm(e.payer))} paid · for ${e.shares.map(s => esc(nm(s.p))).join(', ')}`;
      amount = tot;
    } else {
      title = `${esc(nm(e.from))} → ${esc(nm(e.to))}`;
      sub = 'repayment';
      amount = e.usd;
    }
    const row = el(`<div class="item${dead ? ' void' : ''}">
      <div class="g"><div class="t">${title}${dead ? '<span class="tag">undone</span>' : ''}</div>
      <div class="s">${sub} · ${when}</div></div>
      <div class="amt">${eur(amount * st.rate)}<small>${usd(amount)}</small></div></div>`);
    if (!dead && (isAdmin() || (e.by && e.by === cfg.meId))) {
      const b = el('<button class="btn danger sm">Undo</button>');
      b.onclick = async () => {
        if (!confirm('Undo this entry?\n\nNothing is deleted — a reversal is recorded and stays visible in the history.')) return;
        await add({ type: 'void', target: e.id });
        toast('Entry undone');
      };
      row.appendChild(b);
    }
    l.appendChild(row);
  });
  c.appendChild(el(`<div class="hint">Entries can never be deleted. "Undo" writes a reversal that stays visible to everyone.
    You can undo what you entered yourself${isAdmin() ? '; as administrator you can undo anything' : ''}.</div>`));
  wrap.appendChild(c);
  return wrap;
}

/* --- People --- */
function viewPeople(st) {
  const wrap = el('<div></div>');
  const admin = isAdmin();

  const c = el(`<div class="card"><h2>Group (${st.people.length})</h2>
    <div class="list" id="l"></div></div>`);
  const l = c.querySelector('#l');
  if (!st.people.length) l.appendChild(el('<div class="hint" style="margin:0">Nobody yet.</div>'));

  st.people.forEach(p => {
    const v = r2(st.net[p.id] || 0);
    const row = el(`<div class="item"><div class="g">
      <div class="t">${esc(p.name)}${p.id === cfg.meId ? '<span class="tag">you</span>' : ''}${p.id === cfg.admin ? '<span class="tag">admin</span>' : ''}</div>
      <div class="s">${v >= 0 ? 'gets back' : 'owes'} ${eur(Math.abs(v) * st.rate)}</div></div></div>`);
    if (!cfg.meId) {
      const b = el('<button class="btn sec sm">That\u2019s me</button>');
      b.onclick = () => { cfg.meId = p.id; saveCfg(); draft.payer = p.id; draft.sel = [p.id]; render(); };
      row.appendChild(b);
    } else if (admin) {
      const b = el('<button class="btn sec sm">Rename</button>');
      b.onclick = async () => {
        const n = prompt('New name for ' + p.name, p.name);
        if (!n || !n.trim() || n.trim() === p.name) return;
        await add({ type: 'rename', target: p.id, name: n.trim() });
        toast('Renamed');
      };
      row.appendChild(b);
    }
    l.appendChild(row);
  });
  wrap.appendChild(c);

  if (!admin) {
    wrap.appendChild(el(`<div class="hint" style="padding:0 2px">The group list is managed by
      ${esc((st.byId[cfg.admin] || {}).name || 'the administrator')}. Ask them if somebody is missing.</div>`));
    return wrap;
  }

  const ac = el(`<div class="card"><h2>Administrator</h2>
    <p class="hint" style="margin-top:0">You can add people at any time — also in the middle of the trip.
      A person added later starts at zero and only appears in expenses logged from then on.</p>
    <label>Add a person</label>
    <div class="row"><input id="nm" placeholder="Name" autocomplete="off">
      <button class="btn sm" id="addBtn" style="flex:0 0 auto">Add</button></div>
    <div style="height:12px"></div>
    <details><summary class="muted" style="font-size:13px;cursor:pointer">Add several at once</summary>
      <div style="height:8px"></div>
      <textarea id="bulk" rows="5" placeholder="One name per line"></textarea>
      <div style="height:8px"></div>
      <button class="btn sec" id="bulkBtn">Add all</button>
    </details>
  </div>`);

  const addName = async (name) => {
    name = name.trim();
    if (!name) return;
    if (st.people.some(p => p.name.toLowerCase() === name.toLowerCase())) { toast(name + ' already exists'); return; }
    await add({ type: 'person', name });
  };
  const nmInput = ac.querySelector('#nm');
  ac.querySelector('#addBtn').onclick = async () => { const n = nmInput.value; nmInput.value = ''; await addName(n); };
  nmInput.onkeydown = e => { if (e.key === 'Enter') ac.querySelector('#addBtn').click(); };
  ac.querySelector('#bulkBtn').onclick = async () => {
    const lines = ac.querySelector('#bulk').value.split('\n').map(s => s.trim()).filter(Boolean);
    ac.querySelector('#bulk').value = '';
    for (const n of lines) await addName(n);
    if (lines.length) toast(lines.length + ' added');
  };
  wrap.appendChild(ac);
  return wrap;
}

/* --- Settings --- */
function viewSettings(st) {
  const wrap = el('<div></div>');

  const c = el(`<div class="card"><h2>Shared storage</h2>
    <p class="hint" style="margin-top:0">Every entry is uploaded as its own file to
      <code>${esc(cfg.owner)}/${esc(cfg.repo)}</code> under <code>${esc(cfg.dir)}</code>.
      Nothing is ever overwritten or deleted, so two people can enter things at the same time without clashing.</p>
    <label>Group code</label>
    <input id="tok" type="password" placeholder="github_pat_…" value="${esc(cfg.token || '')}">
    <div class="hint">Reading works without it. You need the code to <b>add</b> anything —
      it is the same code for everyone, sent round in the WhatsApp group.
      It is stored on this phone only and is never written into the repository.</div>
    <div style="height:12px"></div>
    <div class="row">
      <div><label>Owner</label><input id="own" value="${esc(cfg.owner)}"></div>
      <div><label>Repository</label><input id="rep" value="${esc(cfg.repo)}"></div>
    </div>
    <div style="height:10px"></div>
    <label>Branch</label><input id="br" value="${esc(cfg.branch)}">
    <div style="height:14px"></div>
    <button class="btn" id="saveCfg">Save &amp; sync now</button>
  </div>`);
  c.querySelector('#saveCfg').onclick = async () => {
    cfg.token = c.querySelector('#tok').value.trim();
    cfg.owner = c.querySelector('#own').value.trim();
    cfg.repo = c.querySelector('#rep').value.trim();
    cfg.branch = c.querySelector('#br').value.trim() || 'main';
    saveCfg();
    await sync();
  };
  wrap.appendChild(c);

  if (!isAdmin()) {
    wrap.appendChild(el(`<div class="card"><h2>Exchange rate</h2>
      <div class="split"><span>1 US dollar</span><span class="amt">${st.rate.toFixed(4)} €</span></div>
      <div class="hint">Fixed for the whole trip and <b>not live</b>. Only
        ${esc((st.byId[cfg.admin] || {}).name || 'the administrator')} can change it.</div></div>`));
    wrap.appendChild(phoneCard(st));
    return wrap;
  }

  const c2 = el(`<div class="card"><h2>Exchange rate <span class="tag">admin</span></h2>
    <p class="hint" style="margin-top:0">One fixed rate for the whole trip — <b>not live</b>.
      Set it once at the start; over 10 days the drift is negligible.</p>
    <label>Euro per 1 US dollar</label>
    <input id="rate" type="number" step="0.0001" min="0" value="${st.rate}">
    <div style="height:10px"></div>
    <label>Note (optional)</label>
    <input id="rlab" placeholder="e.g. ECB rate, 12 Sept" value="${esc(st.rateLabel || '')}">
    <div style="height:12px"></div>
    <button class="btn sec" id="saveRate">Set rate for the whole group</button>
    <div class="hint">Changing this changes how every amount is shown in euros, for everyone.
      Dollar amounts stay exactly as entered.</div>
  </div>`);
  c2.querySelector('#saveRate').onclick = async () => {
    const v = parseFloat(c2.querySelector('#rate').value);
    if (!(v > 0)) { toast('Enter a valid rate'); return; }
    await add({ type: 'rate', eurPerUsd: v, label: c2.querySelector('#rlab').value.trim() });
    toast('Rate set');
  };
  wrap.appendChild(c2);

  wrap.appendChild(phoneCard(st));
  return wrap;
}

function phoneCard(st) {
  const wrap = el('<div></div>');
  const me = st.byId[cfg.meId];
  const c3 = el(`<div class="card"><h2>This phone</h2>
    <div class="split"><span>I am</span><span>${me ? esc(me.name) : '<span class="muted">not set</span>'}</span></div>
    <div class="split"><span>Entries known</span><span>${st.all.length}</span></div>
    <div class="split"><span>Waiting to upload</span><span>${queue.length}</span></div>
    <div style="height:12px"></div>
    <div class="row">
      <button class="btn sec" id="resync">Sync now</button>
      <button class="btn sec" id="changeMe">Change who I am</button>
    </div>
    <div style="height:8px"></div>
    <button class="btn sec" id="export">Download backup (JSON)</button>
    <div style="height:8px"></div>
    <button class="btn danger" id="reset">Clear this phone's cache</button>
    <div class="hint">Clearing only empties the local copy — the shared data in the repository is untouched and comes straight back on the next sync.</div>
  </div>`);
  c3.querySelector('#resync').onclick = () => sync();
  c3.querySelector('#changeMe').onclick = () => { cfg.meId = null; saveCfg(); tab = 'add'; render(); };
  c3.querySelector('#export').onclick = () => {
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), rate: st.rate, entries: st.all }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'saustall-payme-backup.json';
    a.click();
  };
  c3.querySelector('#reset').onclick = () => {
    if (!confirm('Clear the local cache on this phone? Shared data in the repository is not affected.')) return;
    if (queue.length && !confirm(queue.length + ' entries have not been uploaded yet and will be lost. Continue?')) return;
    entries = {}; files = {}; queue = [];
    LS.set('entries', entries); LS.set('files', files); LS.set('queue', queue);
    sync();
  };
  wrap.appendChild(c3);
  return wrap;
}

/* ---------------- boot ---------------- */

document.querySelectorAll('nav button').forEach(b => {
  b.onclick = () => { tab = b.dataset.tab; window.scrollTo(0, 0); render(); };
});
$('#whoBtn').onclick = () => { tab = cfg.meId ? 'settings' : 'add'; window.scrollTo(0, 0); render(); };

render();
setSync('', 'idle');
sync(true);
setInterval(() => { if (document.visibilityState === 'visible') sync(true); }, 45000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(true); });
window.addEventListener('online', () => sync(true));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
