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
const fmt = (n, d) => (Math.abs(n) < 0.005 ? 0 : n).toLocaleString('de-DE', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d });
const usd = n => fmt(n) + ' $';
const eur = n => fmt(n) + ' €';
const DE = 'de-DE';

let toastBox = null;
const isAdmin = () => cfg.meId === cfg.admin;

/* --- Installation als App --- */
let installEvent = null;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; render(); });
window.addEventListener('appinstalled', () => { installEvent = null; toast('App installiert 🐷'); render(); });

function installHelp() {
  const steps = isIOS()
    ? `<ol class="steps"><li>Unten in Safari auf <b>Teilen</b> tippen (das Quadrat mit dem Pfeil nach oben).</li>
       <li>In der Liste nach unten scrollen zu <b>Zum Home-Bildschirm</b>.</li>
       <li>Oben rechts auf <b>Hinzufügen</b> tippen.</li></ol>
       <p class="hint">Das geht nur in <b>Safari</b> – nicht in Chrome oder im WhatsApp-Browser.
       Falls du den Link aus WhatsApp geöffnet hast: unten rechts auf das Safari-Symbol tippen.</p>`
    : `<ol class="steps"><li>Oben rechts im Browser auf das <b>Menü</b> (drei Punkte) tippen.</li>
       <li><b>App installieren</b> bzw. <b>Zum Startbildschirm hinzufügen</b> wählen.</li>
       <li>Bestätigen.</li></ol>
       <p class="hint">Am besten in <b>Chrome</b>. Falls du den Link aus WhatsApp geöffnet hast,
       zuerst über das Menü <b>Im Browser öffnen</b>.</p>`;
  const sh = el(`<div class="sheet"><div class="inner">
    <h2 style="margin-top:0">App installieren</h2>
    ${steps}
    <div style="height:10px"></div>
    <button class="btn sec" id="close">Alles klar</button>
  </div></div>`);
  document.body.appendChild(sh);
  sh.querySelector('#close').onclick = () => sh.remove();
  sh.onclick = e => { if (e.target === sh) sh.remove(); };
}

function installCard(compact) {
  if (isStandalone()) return null;
  if (compact && LS.get('hideInstall', 0)) return null;
  const c = el(`<div class="card accent">
    <h2>🐷 App installieren</h2>
    <p class="hint" style="margin-top:0">Leg dir Saustall USA PayMe auf den Home-Bildschirm.
      Dann hast du ein eigenes Symbol, die App startet sofort – und du kannst
      <b>auch ohne Internet</b> eintragen.</p>
    <button class="btn" id="inst">Auf dem Home-Bildschirm ablegen</button>
    ${compact ? '<div style="height:8px"></div><button class="btn sec" id="later">Später</button>' : ''}
  </div>`);
  c.querySelector('#inst').onclick = async () => {
    if (installEvent) {
      installEvent.prompt();
      const res = await installEvent.userChoice;
      installEvent = null;
      if (res && res.outcome !== 'accepted') installHelp();
      render();
    } else installHelp();
  };
  if (compact) c.querySelector('#later').onclick = () => { LS.set('hideInstall', 1); render(); };
  return c;
}

/* --- Verbindung --- */
function connectionBanner() {
  const pend = queue.length;
  const off = !navigator.onLine;
  if (!pend && !off) return null;
  let txt;
  if (off && pend) {
    txt = `<b>Kein Internet.</b> ${pend} ${pend === 1 ? 'Eintrag ist' : 'Einträge sind'} auf diesem Handy
      gespeichert und ${pend === 1 ? 'wird' : 'werden'} automatisch hochgeladen, sobald wieder Verbindung da ist.`;
  } else if (off) {
    txt = `<b>Kein Internet.</b> Du kannst trotzdem alles eintragen – es wird automatisch
      hochgeladen, sobald wieder Verbindung da ist.`;
  } else {
    txt = `<b>${pend} ${pend === 1 ? 'Eintrag wartet' : 'Einträge warten'} auf Upload.</b>
      Wird automatisch erneut versucht.`;
  }
  const b = el(`<div class="banner">${txt}</div>`);
  if (!off) {
    const btn = el('<button class="btn sec sm" style="margin-top:8px">Jetzt versuchen</button>');
    btn.onclick = () => sync();
    b.appendChild(btn);
  }
  return b;
}

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
  toast('Nur auf diesem Handy gespeichert – trag den Gruppen-Code unter Einstellungen ein, damit es alle sehen', 5500);
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
  if (!res.ok) throw new Error('GitHub ' + res.status + ' – ' + (res.status === 401 ? 'Gruppen-Code ungültig' : res.statusText));
  const list = await res.json();
  const fresh = list.filter(f => f.type === 'file' && f.name.endsWith('.json') && !files[f.name]);

  let added = 0;
  const pool = 8;
  for (let i = 0; i < fresh.length; i += pool) {
    const batch = fresh.slice(i, i + pool);
    setSync('busy', `lade ${Math.min(i + pool, fresh.length)}/${fresh.length}`);
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
    setSync('busy', `sende ${queue.length}`);
    await pushOne(e);
    queue.shift();
    LS.set('queue', queue);
  }
}

async function sync(silent) {
  if (busy) return;
  busy = true;
  try {
    setSync('busy', 'synchronisiere');
    if (cfg.token) await flush();
    const n = await pull();
    setSync(cfg.token ? 'ok' : 'warn', (cfg.token ? 'aktuell ' : 'nur lesen ') + new Date().toLocaleTimeString(DE, { hour: '2-digit', minute: '2-digit' }));
    render();
    if (n && !silent) toast(n + (n === 1 ? ' neuer Eintrag' : ' neue Einträge'));
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
    setSync('ok', 'gespeichert');
  } catch (err) {
    setSync('bad', navigator.onLine ? 'wartet' : 'offline');
    // Offline is already explained by the banner — only surprising errors get a toast.
    if (navigator.onLine) toast('Noch nicht hochgeladen: ' + (err.message || err) + ' – wird erneut versucht', 5000);
    render();
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
  const conn = connectionBanner();
  if (conn) v.appendChild(conn);
  if (tab === 'add') {
    const ic = installCard(true);
    if (ic) v.appendChild(ic);
  }
  if (tab === 'add') v.appendChild(viewAdd(st));
  if (tab === 'balance') v.appendChild(viewBalance(st));
  if (tab === 'history') v.appendChild(viewHistory(st));
  if (tab === 'people') v.appendChild(viewPeople(st));
  if (tab === 'settings') v.appendChild(viewSettings(st));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const me = st.byId[cfg.meId];
  $('#whoBtn').textContent = me ? me.name : 'Wer bin ich?';
}

function cfgGuardRender(st) {
  document.title = 'Saustall USA PayMe';
}

function rateNote(st) {
  if (!st.rateSet) {
    return `<div class="banner err"><b>Noch kein Wechselkurs gesetzt.</b> Die Euro-Beträge nutzen
      vorläufig ${fmt(st.rate, 4)}&nbsp;€ pro 1&nbsp;$.
      ${isAdmin() ? 'Setz den echten Kurs unter <b>Einstellungen</b>, bevor die Reise losgeht.'
                  : 'Sag ' + esc((st.byId[cfg.admin] || {}).name || 'dem Administrator') + ' Bescheid, dass der Kurs gesetzt werden muss.'}
      Die Dollar-Beträge sind davon nicht betroffen.</div>`;
  }
  const d = new Date(st.rateTs).toLocaleDateString(DE);
  return `<div class="banner"><b>Fester Wechselkurs:</b> 1 $ = ${fmt(st.rate, 4)} € · gesetzt am ${d}${st.rateLabel ? ' · ' + esc(st.rateLabel) : ''}<br>
    Das ist <b>kein Live-Kurs</b> – ein fester Wert für die ganze Reise.</div>`;
}

/* --- Add --- */
function viewAdd(st) {
  const wrap = el('<div></div>');

  if (!st.people.length) {
    wrap.appendChild(el(`<div class="card"><h2>Zuerst</h2>
      <p class="hint" style="margin-top:0">Noch keine Leute da. Geh auf <b>Leute</b>, trag die Gruppe ein und wähl dann aus, wer du bist.</p>
      <button class="btn" id="goPeople">Leute hinzufügen</button></div>`));
    wrap.querySelector('#goPeople').onclick = () => { tab = 'people'; render(); };
    return wrap;
  }
  if (!cfg.meId) {
    wrap.appendChild(el(`<div class="card"><h2>Wer bist du?</h2>
      <p class="hint" style="margin-top:0">Tipp einmal deinen Namen an – das ist ab dann dein Konto. Die Auswahl bleibt nur auf diesem Handy.</p>
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
    <h2>Neue Ausgabe</h2>
    <label>Wer hat bezahlt?</label>
    <select id="payer"></select>
    <div style="height:12px"></div>
    <label>Für wen? <span class="muted" id="selCount"></span></label>
    <div class="chips" id="forWhom"></div>
    <div class="row" style="margin-top:6px">
      <button class="btn sec sm" id="selAll" type="button">Alle</button>
      <button class="btn sec sm" id="selMe" type="button">Nur ich</button>
      <button class="btn sec sm" id="selNone" type="button">Keiner</button>
    </div>
    <div style="height:14px"></div>
    <label>Betrag in US-Dollar</label>
    <input id="total" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00">
    <div class="hint" id="conv"></div>
    <div style="height:12px"></div>
    <label>Wofür?</label>
    <input id="note" placeholder="z. B. Abendessen bei Joe's">
    <div style="height:12px"></div>
    <div class="split" style="border:none;padding:0">
      <span class="muted" style="font-size:13px">Gleichmäßig teilen</span>
      <button class="btn sec sm" id="eqBtn" type="button"></button>
    </div>
    <div id="customBox"></div>
    <div style="height:14px"></div>
    <button class="btn" id="save">Ausgabe speichern</button>
    <div class="hint" id="preview"></div>
  </div>`);
  wrap.appendChild(card);

  const payer = card.querySelector('#payer');
  st.people.forEach(p => payer.appendChild(el(`<option value="${p.id}">${esc(p.name)}${p.id === cfg.meId ? ' (ich)' : ''}</option>`)));
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
    card.querySelector('#selCount').textContent = draft.sel.length ? `· ${draft.sel.length} ausgewählt` : '';
    card.querySelector('#conv').innerHTML = sum ? `= <b>${eur(sum * st.rate)}</b> zum festen Kurs` : '';
    eqBtn.textContent = draft.equal ? 'Gleich ✓' : 'Einzeln';
    const nm = id => (st.byId[id] || {}).name || '?';
    const others = sh.filter(s => s.p !== draft.payer && s.usd > 0);
    card.querySelector('#preview').innerHTML = others.length
      ? others.map(s => `${esc(nm(s.p))} schuldet ${esc(nm(draft.payer))} <b>${eur(s.usd * st.rate)}</b> <span class="muted">(${usd(s.usd)})</span>`).join('<br>')
      : '<span class="muted">Noch nichts offen – wähl Leute und einen Betrag.</span>';
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
    cb.appendChild(el('<div class="hint">Die Gesamtsumme ergibt sich aus diesen Beträgen.</div>'));
  }

  card.querySelector('#save').onclick = async () => {
    const sh = shares().filter(s => s.usd > 0);
    if (!sh.length) return;
    await add({ type: 'expense', payer: draft.payer, note: draft.note.trim(), shares: sh, rate: st.rate });
    draft = { payer: cfg.meId, sel: [cfg.meId], total: '', note: '', equal: true, custom: {} };
    toast('Ausgabe gespeichert');
    tab = 'balance'; render();
  };

  refresh();
  return wrap;
}

/* --- Balance --- */
function viewBalance(st) {
  const wrap = el('<div></div>');
  if (!st.people.length) return el('<div class="card"><p class="hint">Trag zuerst die Leute ein.</p></div>');

  const nm = id => (st.byId[id] || {}).name || '?';
  const tx = plan(st);
  const me = cfg.meId;

  if (me) {
    const bal = r2(st.net[me] || 0);
    const mine = tx.filter(t => t.from === me || t.to === me);
    const c = el(`<div class="card">
      <h2>Du – ${esc(nm(me))}</h2>
      <div class="big ${bal >= 0 ? 'pos' : 'neg'}">${bal >= 0 ? '+' : '−'}${eur(Math.abs(bal) * st.rate)}</div>
      <div class="sub">${bal >= 0 ? 'bekommst du insgesamt zurück' : 'schuldest du insgesamt'} · ${usd(Math.abs(bal))}</div>
      <div style="height:10px"></div>
      <div class="list" id="mine"></div>
    </div>`);
    const list = c.querySelector('#mine');
    if (!mine.length) list.appendChild(el('<div class="hint" style="margin:0">Alles ausgeglichen.</div>'));
    mine.forEach(t => {
      const out = t.from === me;
      const other = out ? t.to : t.from;
      const row = el(`<div class="item">
        <div class="g"><div class="t">${out ? 'An' : 'Von'} ${esc(nm(other))}</div>
        <div class="s">${out ? 'zahlst du' : 'bekommst du'}</div></div>
        <div class="amt ${out ? 'neg' : 'pos'}">${eur(t.usd * st.rate)}<small>${usd(t.usd)}</small></div>
      </div>`);
      const b = el(`<button class="btn sec sm">Bezahlt</button>`);
      b.onclick = () => settleSheet(st, t.from, t.to, t.usd);
      row.appendChild(b);
      list.appendChild(row);
    });
    wrap.appendChild(c);
  }

  const c2 = el('<div class="card"><h2>Alle</h2><div id="all"></div></div>');
  const a = c2.querySelector('#all');
  st.people.forEach(p => {
    const v = r2(st.net[p.id] || 0);
    a.appendChild(el(`<div class="split">
      <span>${esc(p.name)}${p.id === me ? '<span class="tag">du</span>' : ''}</span>
      <span class="amt ${v > 0.005 ? 'pos' : (v < -0.005 ? 'neg' : 'muted')}">
        ${v >= 0 ? '+' : '−'}${eur(Math.abs(v) * st.rate)}<small>${usd(Math.abs(v))}</small></span>
    </div>`));
  });
  a.appendChild(el('<div class="hint">Plus = bekommt Geld zurück. Minus = schuldet noch.</div>'));
  wrap.appendChild(c2);

  const c3 = el('<div class="card"><h2>Wer zahlt an wen</h2><div class="list" id="tx"></div></div>');
  const t3 = c3.querySelector('#tx');
  if (!tx.length) t3.appendChild(el('<div class="hint" style="margin:0">Nichts offen – alles gleicht sich aus.</div>'));
  tx.forEach(t => {
    const row = el(`<div class="item">
      <div class="g"><div class="t">${esc(nm(t.from))} → ${esc(nm(t.to))}</div>
      <div class="s">${usd(t.usd)} zum festen Kurs</div></div>
      <div class="amt">${eur(t.usd * st.rate)}</div></div>`);
    const b = el('<button class="btn sec sm">Bezahlt</button>');
    b.onclick = () => settleSheet(st, t.from, t.to, t.usd);
    row.appendChild(b);
    t3.appendChild(row);
  });
  c3.appendChild(el('<div class="hint">Alle Schulden in der Gruppe werden zusammengezählt und gegeneinander verrechnet. Das ist die kleinste Anzahl an Zahlungen, mit der alles beglichen ist.</div>'));
  wrap.appendChild(c3);
  wrap.appendChild(el(rateNote(st)));
  return wrap;
}

function settleSheet(st, from, to, amt) {
  const nm = id => (st.byId[id] || {}).name || '?';
  const s = el(`<div class="sheet"><div class="inner">
    <h2 style="margin-top:0">Zahlung eintragen</h2>
    <p class="hint" style="margin-top:0">${esc(nm(from))} gibt ${esc(nm(to))} das Geld – bar oder überwiesen. Es wird nichts gelöscht: die Rückzahlung wird zusätzlich eingetragen.</p>
    <label>Betrag in US-Dollar</label>
    <input id="amt" type="number" inputmode="decimal" step="0.01" value="${amt.toFixed(2)}">
    <div class="hint" id="cv"></div>
    <div style="height:14px"></div>
    <button class="btn" id="ok">Zahlung eintragen</button>
    <div style="height:8px"></div>
    <button class="btn sec" id="cancel">Abbrechen</button>
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
    toast('Zahlung eingetragen');
  };
}

/* --- History --- */
function viewHistory(st) {
  const wrap = el('<div></div>');
  const nm = id => (st.byId[id] || {}).name || '?';
  const c = el('<div class="card"><h2>Alle Einträge</h2><div class="list" id="l"></div></div>');
  const l = c.querySelector('#l');
  const shown = st.all.filter(e => e.type === 'expense' || e.type === 'settle').reverse();
  if (!shown.length) l.appendChild(el('<div class="hint" style="margin:0">Noch nichts eingetragen.</div>'));

  shown.forEach(e => {
    const dead = st.voided.has(e.id);
    const when = new Date(e.ts).toLocaleString(DE, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    let title, sub, amount;
    if (e.type === 'expense') {
      const tot = (e.shares || []).reduce((a, s) => a + s.usd, 0);
      title = esc(e.note || 'Ausgabe');
      sub = `${esc(nm(e.payer))} hat bezahlt · für ${e.shares.map(s => esc(nm(s.p))).join(', ')}`;
      amount = tot;
    } else {
      title = `${esc(nm(e.from))} → ${esc(nm(e.to))}`;
      sub = 'Rückzahlung';
      amount = e.usd;
    }
    const row = el(`<div class="item${dead ? ' void' : ''}">
      <div class="g"><div class="t">${title}${dead ? '<span class="tag">storniert</span>' : ''}</div>
      <div class="s">${sub} · ${when}</div></div>
      <div class="amt">${eur(amount * st.rate)}<small>${usd(amount)}</small></div></div>`);
    if (!dead && (isAdmin() || (e.by && e.by === cfg.meId))) {
      const b = el('<button class="btn danger sm">Stornieren</button>');
      b.onclick = async () => {
        if (!confirm('Diesen Eintrag stornieren?\n\nEs wird nichts gelöscht – die Stornierung wird eingetragen und bleibt für alle sichtbar.')) return;
        await add({ type: 'void', target: e.id });
        toast('Eintrag storniert');
      };
      row.appendChild(b);
    }
    l.appendChild(row);
  });
  c.appendChild(el(`<div class="hint">Einträge können nie gelöscht werden. „Stornieren“ trägt eine Rückbuchung ein, die für alle sichtbar bleibt.
    Stornieren kannst du, was du selbst eingetragen hast${isAdmin() ? '; als Administrator kannst du alles stornieren' : ''}.</div>`));
  wrap.appendChild(c);
  return wrap;
}

/* --- People --- */
function viewPeople(st) {
  const wrap = el('<div></div>');
  const admin = isAdmin();

  const c = el(`<div class="card"><h2>Gruppe (${st.people.length})</h2>
    <div class="list" id="l"></div></div>`);
  const l = c.querySelector('#l');
  if (!st.people.length) l.appendChild(el('<div class="hint" style="margin:0">Noch niemand.</div>'));

  st.people.forEach(p => {
    const v = r2(st.net[p.id] || 0);
    const row = el(`<div class="item"><div class="g">
      <div class="t">${esc(p.name)}${p.id === cfg.meId ? '<span class="tag">du</span>' : ''}${p.id === cfg.admin ? '<span class="tag">admin</span>' : ''}</div>
      <div class="s">${v >= 0 ? 'bekommt zurück' : 'schuldet'} ${eur(Math.abs(v) * st.rate)}</div></div></div>`);
    if (!cfg.meId) {
      const b = el('<button class="btn sec sm">Das bin ich</button>');
      b.onclick = () => { cfg.meId = p.id; saveCfg(); draft.payer = p.id; draft.sel = [p.id]; render(); };
      row.appendChild(b);
    } else if (admin) {
      const b = el('<button class="btn sec sm">Umbenennen</button>');
      b.onclick = async () => {
        const n = prompt('Neuer Name für ' + p.name, p.name);
        if (!n || !n.trim() || n.trim() === p.name) return;
        await add({ type: 'rename', target: p.id, name: n.trim() });
        toast('Umbenannt');
      };
      row.appendChild(b);
    }
    l.appendChild(row);
  });
  wrap.appendChild(c);

  if (!admin) {
    wrap.appendChild(el(`<div class="hint" style="padding:0 2px">Die Gruppenliste verwaltet
      ${esc((st.byId[cfg.admin] || {}).name || 'der Administrator')}. Sag Bescheid, wenn jemand fehlt.</div>`));
    return wrap;
  }

  const ac = el(`<div class="card"><h2>Administrator</h2>
    <p class="hint" style="margin-top:0">Du kannst jederzeit Leute hinzufügen, auch mitten in der Reise.
      Wer später dazukommt, startet bei null und taucht nur in Ausgaben auf, die ab dann eingetragen werden.</p>
    <label>Person hinzufügen</label>
    <div class="row"><input id="nm" placeholder="Name" autocomplete="off">
      <button class="btn sm" id="addBtn" style="flex:0 0 auto">Hinzufügen</button></div>
    <div style="height:12px"></div>
    <details><summary class="muted" style="font-size:13px;cursor:pointer">Mehrere auf einmal</summary>
      <div style="height:8px"></div>
      <textarea id="bulk" rows="5" placeholder="Ein Name pro Zeile"></textarea>
      <div style="height:8px"></div>
      <button class="btn sec" id="bulkBtn">Alle hinzufügen</button>
    </details>
  </div>`);

  const addName = async (name) => {
    name = name.trim();
    if (!name) return;
    if (st.people.some(p => p.name.toLowerCase() === name.toLowerCase())) { toast(name + ' gibt es schon'); return; }
    await add({ type: 'person', name });
  };
  const nmInput = ac.querySelector('#nm');
  ac.querySelector('#addBtn').onclick = async () => { const n = nmInput.value; nmInput.value = ''; await addName(n); };
  nmInput.onkeydown = e => { if (e.key === 'Enter') ac.querySelector('#addBtn').click(); };
  ac.querySelector('#bulkBtn').onclick = async () => {
    const lines = ac.querySelector('#bulk').value.split('\n').map(s => s.trim()).filter(Boolean);
    ac.querySelector('#bulk').value = '';
    for (const n of lines) await addName(n);
    if (lines.length) toast(lines.length + ' hinzugefügt');
  };
  wrap.appendChild(ac);
  return wrap;
}

/* --- Settings --- */
function viewSettings(st) {
  const wrap = el('<div></div>');
  const ic = installCard(false);
  if (ic) wrap.appendChild(ic);

  const c = el(`<div class="card"><h2>Gemeinsame Speicherung</h2>
    <p class="hint" style="margin-top:0">Jeder Eintrag wird als eigene Datei nach
      <code>${esc(cfg.owner)}/${esc(cfg.repo)}</code> unter <code>${esc(cfg.dir)}</code> hochgeladen.
      Nichts wird überschrieben oder gelöscht – zwei Leute können gleichzeitig etwas eintragen, ohne sich in die Quere zu kommen.</p>
    <label>Gruppen-Code</label>
    <input id="tok" type="password" placeholder="github_pat_…" value="${esc(cfg.token || '')}">
    <div class="hint">Zum Anschauen brauchst du ihn nicht. Zum <b>Eintragen</b> schon –
      es ist derselbe Code für alle, der in der WhatsApp-Gruppe rumgeschickt wird.
      Er bleibt nur auf diesem Handy und wird nie in das Repository geschrieben.</div>
    <div style="height:12px"></div>
    <div class="row">
      <div><label>Besitzer</label><input id="own" value="${esc(cfg.owner)}"></div>
      <div><label>Repository</label><input id="rep" value="${esc(cfg.repo)}"></div>
    </div>
    <div style="height:10px"></div>
    <label>Branch</label><input id="br" value="${esc(cfg.branch)}">
    <div style="height:14px"></div>
    <button class="btn" id="saveCfg">Speichern &amp; synchronisieren</button>
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
    wrap.appendChild(el(`<div class="card"><h2>Wechselkurs</h2>
      <div class="split"><span>1 US-Dollar</span><span class="amt">${fmt(st.rate, 4)} €</span></div>
      <div class="hint">Fest für die ganze Reise und <b>kein Live-Kurs</b>. Ändern kann ihn nur
        ${esc((st.byId[cfg.admin] || {}).name || 'der Administrator')}.</div></div>`));
    wrap.appendChild(phoneCard(st));
    return wrap;
  }

  const c2 = el(`<div class="card"><h2>Wechselkurs <span class="tag">admin</span></h2>
    <p class="hint" style="margin-top:0">Ein fester Kurs für die ganze Reise – <b>kein Live-Kurs</b>.
      Einmal am Anfang setzen; über 10 Tage ist die Schwankung zu vernachlässigen.</p>
    <label>Euro pro 1 US-Dollar</label>
    <input id="rate" type="number" step="0.0001" min="0" value="${st.rate}">
    <div style="height:10px"></div>
    <label>Notiz (optional)</label>
    <input id="rlab" placeholder="z. B. EZB-Kurs, 12. Sept." value="${esc(st.rateLabel || '')}">
    <div style="height:12px"></div>
    <button class="btn sec" id="saveRate">Kurs für die ganze Gruppe setzen</button>
    <div class="hint">Das ändert für alle, wie die Beträge in Euro angezeigt werden.
      Die Dollar-Beträge bleiben genau so, wie sie eingetragen wurden.</div>
  </div>`);
  c2.querySelector('#saveRate').onclick = async () => {
    const v = parseFloat(c2.querySelector('#rate').value);
    if (!(v > 0)) { toast('Bitte einen gültigen Kurs eingeben'); return; }
    await add({ type: 'rate', eurPerUsd: v, label: c2.querySelector('#rlab').value.trim() });
    toast('Kurs gesetzt');
  };
  wrap.appendChild(c2);

  wrap.appendChild(phoneCard(st));
  return wrap;
}

function phoneCard(st) {
  const wrap = el('<div></div>');
  const me = st.byId[cfg.meId];
  const c3 = el(`<div class="card"><h2>Dieses Handy</h2>
    <div class="split"><span>Ich bin</span><span>${me ? esc(me.name) : '<span class="muted">nicht gesetzt</span>'}</span></div>
    <div class="split"><span>Bekannte Einträge</span><span>${st.all.length}</span></div>
    <div class="split"><span>Wartet auf Upload</span><span>${queue.length}</span></div>
    <div style="height:12px"></div>
    <div class="row">
      <button class="btn sec" id="resync">Jetzt synchronisieren</button>
      <button class="btn sec" id="changeMe">Anderen Namen wählen</button>
    </div>
    <div style="height:8px"></div>
    <button class="btn sec" id="export">Sicherung herunterladen (JSON)</button>
    <div style="height:8px"></div>
    <button class="btn danger" id="reset">Zwischenspeicher löschen</button>
    <div class="hint">Das leert nur die lokale Kopie – die gemeinsamen Daten im Repository bleiben unberührt und sind nach dem nächsten Synchronisieren wieder da.</div>
  </div>`);
  c3.querySelector('#resync').onclick = () => sync();
  c3.querySelector('#changeMe').onclick = () => { cfg.meId = null; saveCfg(); tab = 'add'; render(); };
  c3.querySelector('#export').onclick = () => {
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), rate: st.rate, entries: st.all }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'saustall-payme-sicherung.json';
    a.click();
  };
  c3.querySelector('#reset').onclick = () => {
    if (!confirm('Zwischenspeicher auf diesem Handy löschen? Die gemeinsamen Daten im Repository sind davon nicht betroffen.')) return;
    if (queue.length && !confirm(queue.length + ' Einträge wurden noch nicht hochgeladen und gehen verloren. Trotzdem fortfahren?')) return;
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
setSync('', 'bereit');
sync(true);
// Retry quickly while something is still waiting to go up, slowly otherwise.
(function loop() {
  const wait = queue.length ? 15000 : 60000;
  setTimeout(() => {
    if (document.visibilityState === 'visible' && navigator.onLine) sync(true);
    loop();
  }, wait);
})();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(true); });
window.addEventListener('online', () => { render(); toast('Wieder online – lade hoch …'); sync(true); });
window.addEventListener('offline', () => { setSync('bad', 'offline'); render(); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
