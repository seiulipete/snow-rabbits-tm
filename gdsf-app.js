// ── GDSF CHECK-IN: APP LOGIC v3.7 ────────────────────────────────────────────
// Wird von gdsf-checkin.html eingebunden. Benötigt: gdsf-config.js + XLSX.js

// ── STATE ────────────────────────────────────
let currentUser = null;
let currentEventId = null;
let allGuests = [];
let filteredGuests = [];
let events = [];
let pendingCheckin = null;
let importData = null;
let importSheetIndex = 0;
let importEventId = null;
let addGuestEventId = null;
let realtimeChannel = null;

// ════════════════════════════════════════════
// BATCH 1: THEME (Dark/Light mit localStorage)
// ════════════════════════════════════════════
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('gdsf_theme'); } catch(e) {}
  if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');
})();

function toggleTheme() {
  const html = document.documentElement;
  const isLight = html.getAttribute('data-theme') === 'light';
  if (isLight) {
    html.removeAttribute('data-theme');
    try { localStorage.setItem('gdsf_theme', 'dark'); } catch(e) {}
  } else {
    html.setAttribute('data-theme', 'light');
    try { localStorage.setItem('gdsf_theme', 'light'); } catch(e) {}
  }
  updateThemeToggleIcon();
}

function updateThemeToggleIcon() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  btn.textContent = isLight ? '☀️' : '🌙';
  btn.title = isLight ? 'Zu Dunkel wechseln' : 'Zu Hell wechseln';
}

// ════════════════════════════════════════════
// BATCH 1: TON-FEEDBACK (Web Audio API)
// success = normaler Check-in, vip = VIP-Gast,
// already = Gast war schon eingecheckt
// ════════════════════════════════════════════
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) { return null; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playTone(type) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const notes = {
    success: [{f: 660, t: 0,    d: 0.12}, {f: 880, t: 0.13, d: 0.18}],
    vip:     [{f: 660, t: 0,    d: 0.11}, {f: 830, t: 0.12, d: 0.11}, {f: 990, t: 0.24, d: 0.22}],
    already: [{f: 220, t: 0,    d: 0.15}, {f: 196, t: 0.18, d: 0.22}]
  }[type] || [];
  notes.forEach(n => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type === 'already' ? 'square' : 'sine';
    osc.frequency.value = n.f;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + n.t);
    gain.gain.exponentialRampToValueAtTime(type === 'already' ? 0.08 : 0.18, ctx.currentTime + n.t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + n.t + n.d);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + n.t);
    osc.stop(ctx.currentTime + n.t + n.d + 0.05);
  });
}

// ════════════════════════════════════════════
// BATCH 1: LAST-CHECK-IN-BAR (mit Live-Zähler)
// ════════════════════════════════════════════
let lastCheckin = null; // { name, at (ms), entrance }
let lastCheckinTimer = null;

function setLastCheckin(name, entrance, atMs) {
  lastCheckin = { name, entrance, at: atMs || Date.now() };
  updateLastCheckinBar();
  if (!lastCheckinTimer) lastCheckinTimer = setInterval(updateLastCheckinBar, 5000);
}

function updateLastCheckinBar() {
  const bar = document.getElementById('last-checkin-bar');
  if (!bar || !lastCheckin) return;
  bar.classList.add('show');
  document.getElementById('lc-name').textContent =
    lastCheckin.name + (lastCheckin.entrance ? ' · ' + lastCheckin.entrance : '');
  const sec = Math.max(0, Math.round((Date.now() - lastCheckin.at) / 1000));
  let txt;
  if (sec < 60) txt = `vor ${sec} s`;
  else if (sec < 3600) txt = `vor ${Math.floor(sec / 60)} min`;
  else txt = `vor ${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min`;
  document.getElementById('lc-time').textContent = txt;
}

// ════════════════════════════════════════════
// BATCH 1: FILTER "NOCH NICHT DA"
// ════════════════════════════════════════════
let pendingOnly = false;

function togglePendingFilter() {
  pendingOnly = !pendingOnly;
  const btn = document.getElementById('filter-pending-btn');
  if (btn) {
    btn.classList.toggle('active', pendingOnly);
    btn.textContent = pendingOnly ? '✓ Zeige nur "Noch nicht da"' : '⏳ Nur "Noch nicht da" anzeigen';
  }
  applySearch();
}

// ════════════════════════════════════════════
// BATCH 1: A–Z SCHNELLNAVIGATION
// ════════════════════════════════════════════
function renderAZSidebar() {
  const sidebar = document.getElementById('az-sidebar');
  if (!sidebar) return;
  const q = document.getElementById('search-input').value.trim();
  // Sidebar nur zeigen wenn keine Suche aktiv & genug Gäste
  if (q || filteredGuests.length < 15) {
    sidebar.classList.add('hidden');
    return;
  }
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const available = new Set(
    filteredGuests.map(g => ((g.nachname || g.vorname || '')[0] || '').toUpperCase())
  );
  sidebar.innerHTML = letters.map(l =>
    `<button class="${available.has(l) ? 'available' : ''}" onclick="scrollToLetter('${l}')">${l}</button>`
  ).join('');
  sidebar.classList.remove('hidden');
}

function scrollToLetter(letter) {
  const card = document.querySelector(`.guest-card[data-letter="${letter}"]`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ════════════════════════════════════════════
// WAKE LOCK – Display bleibt am Eingang an
// ════════════════════════════════════════════
let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch(e) { /* z.B. Energiesparmodus – kein Problem */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentUser) requestWakeLock();
});


// ── API HELPERS ──────────────────────────────
async function api(method, path, body) {
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };
  if (method === 'POST' || method === 'PATCH') {
    headers['Prefer'] = 'return=representation';
  }
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  if (!r.ok) {
    const txt = await r.text();
    let msg = txt;
    try { msg = JSON.parse(txt).message || JSON.parse(txt).hint || txt; } catch(e) {}
    console.error('[API Error]', method, path, r.status, msg);
    throw new Error(msg);
  }
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

async function testConnection() {
  const ind = document.getElementById('conn-indicator');
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/events?select=id&limit=1', {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
    });
    if (r.ok) {
      ind && ind.classList.add('connected');
    } else {
      const t = await r.text();
      console.error('[DB] Connection failed:', r.status, t);
      ind && ind.classList.add('error');
    }
  } catch(e) {
    console.error('[DB] Network error:', e.message);
    ind && ind.classList.add('error');
  }
}

async function get(path) { return api('GET', path); }
async function post(path, body) { return api('POST', path, body); }
async function patch(path, body) { return api('PATCH', path, body); }
async function del(path) { return api('DELETE', path); }

// ── LOGIN ────────────────────────────────────
async function doLogin() {
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  try {
    const rows = await get(`entrances?username=eq.${encodeURIComponent(user)}&is_active=eq.true&select=*`);
    if (!rows || rows.length === 0 || rows[0].password_hash !== pass) {
      errEl.style.display = 'block';
      return;
    }
    currentUser = rows[0];

    // ── MAGIC LINK: Erstlogin-Check ──────────
    // Wenn must_register = true → Registrierungs-Modal zeigen
    if (currentUser.must_register) {
      showRegisterModal();
      return;
    }
    // ─────────────────────────────────────────

    sessionStorage.setItem('gdsf_user', JSON.stringify(currentUser));
    showApp();
  } catch(e) {
    errEl.textContent = 'Verbindungsfehler: ' + e.message;
    errEl.style.display = 'block';
  }
}

// ── MAGIC LINK: Registrierungs-Modal ─────────────────────────────────────────
function showRegisterModal() {
  // Modal dynamisch erstellen falls nicht vorhanden
  let modal = document.getElementById('magic-register-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'magic-register-modal';
    modal.className = 'modal-overlay show';
    modal.innerHTML = `
      <div class="modal-box" style="text-align:center;max-width:360px">
        <div style="font-size:2.5rem;margin-bottom:0.5rem">🔐</div>
        <div class="modal-title" style="text-align:center">Persönlichen Zugang einrichten</div>
        <p style="font-size:0.85rem;color:var(--muted);margin:0.75rem 0 1.25rem;line-height:1.5">
          Willkommen <strong>${currentUser.name}</strong>!<br>
          Bitte gib deine E-Mail-Adresse ein. Du erhältst einen Magic Link zum sicheren Einloggen.
        </p>
        <input type="email" id="register-email" placeholder="deine@email.de"
          style="width:100%;box-sizing:border-box;background:var(--card);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:0.65rem 0.85rem;font-family:inherit;font-size:0.9rem;margin-bottom:0.75rem">
        <div id="register-error" style="display:none;color:#f87171;font-size:0.82rem;margin-bottom:0.75rem"></div>
        <button class="btn" onclick="sendMagicLinkRegistration()" style="width:100%">
          ✉️ Magic Link senden
        </button>
        <p style="font-size:0.75rem;color:var(--muted);margin-top:0.75rem">
          Du erhältst eine E-Mail mit einem Link. Beim nächsten Login verwendest du immer diesen Magic Link.
        </p>
      </div>`;
    document.body.appendChild(modal);
  } else {
    modal.classList.add('show');
    modal.querySelector('p strong') && (modal.querySelector('p strong').textContent = currentUser.name);
  }
}

async function sendMagicLinkRegistration() {
  const email = document.getElementById('register-email').value.trim().toLowerCase();
  const errEl = document.getElementById('register-error');
  errEl.style.display = 'none';
  if (!email || !email.includes('@')) {
    errEl.textContent = 'Bitte eine gültige E-Mail-Adresse eingeben.';
    errEl.style.display = 'block';
    return;
  }
  const btn = document.querySelector('#magic-register-modal .btn');
  btn.disabled = true;
  btn.textContent = 'Wird gesendet…';
  try {
    // 1. E-Mail in accounts-Eintrag speichern + must_register auf false setzen
    await patch(`entrances?id=eq.${currentUser.id}`, {
      email: email,
      must_register: false
    });
    // 2. Magic Link über Supabase Auth senden
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/magiclink`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: email,
        data: { entrance_id: currentUser.id, entrance_name: currentUser.name }
      })
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(t);
    }
    // Erfolg: Modal ersetzen durch Bestätigung
    document.getElementById('magic-register-modal').innerHTML = `
      <div class="modal-box" style="text-align:center;max-width:360px">
        <div style="font-size:3rem;margin-bottom:0.75rem">✉️</div>
        <div class="modal-title" style="text-align:center">E-Mail gesendet!</div>
        <p style="font-size:0.85rem;color:var(--muted);margin:0.75rem 0 0;line-height:1.5">
          Wir haben einen Magic Link an <strong>${email}</strong> gesendet.<br><br>
          Bitte öffne dein E-Mail-Postfach und tippe auf den Link — du wirst dann automatisch eingeloggt.
        </p>
        <p style="font-size:0.75rem;color:var(--muted);margin-top:1rem">
          Du kannst dieses Fenster schließen und die E-Mail öffnen.
        </p>
      </div>`;
  } catch(e) {
    btn.disabled = false;
    btn.textContent = '✉️ Magic Link senden';
    errEl.textContent = 'Fehler: ' + e.message;
    errEl.style.display = 'block';
  }
}

// ── MAGIC LINK: Login per Link (Callback) ────────────────────────────────────
// Wird aufgerufen wenn Supabase einen Magic Link in der URL hat
async function handleMagicLinkCallback() {
  const hash = window.location.hash;
  if (!hash.includes('access_token')) return false;
  try {
    // Token aus URL parsen
    const params = new URLSearchParams(hash.slice(1));
    const accessToken = params.get('access_token');
    if (!accessToken) return false;
    // User-Daten aus JWT holen
    const payload = JSON.parse(atob(accessToken.split('.')[1]));
    const email = payload.email;
    // Entrance per E-Mail suchen
    const rows = await get(`entrances?email=eq.${encodeURIComponent(email)}&is_active=eq.true&select=*`);
    if (!rows || rows.length === 0) {
      showToast('Kein Account für diese E-Mail gefunden.', 'error');
      return false;
    }
    currentUser = rows[0];
    sessionStorage.setItem('gdsf_user', JSON.stringify(currentUser));
    // URL bereinigen (Token aus URL entfernen)
    history.replaceState(null, '', window.location.pathname + window.location.search);
    showApp();
    return true;
  } catch(e) {
    console.error('Magic Link Callback Fehler:', e);
    return false;
  }
}

// ── MAGIC LINK: Login-Tab "Per E-Mail" ───────────────────────────────────────
function showMagicLoginTab() {
  let tab = document.getElementById('magic-login-section');
  if (!tab) {
    tab = document.createElement('div');
    tab.id = 'magic-login-section';
    tab.style.cssText = 'margin-top:1.25rem;padding-top:1.25rem;border-top:1px solid var(--border)';
    tab.innerHTML = `
      <p style="font-size:0.78rem;text-align:center;color:var(--muted);margin-bottom:0.75rem">
        — oder per Magic Link —
      </p>
      <input type="email" id="magic-email-input" placeholder="Deine E-Mail-Adresse"
        style="width:100%;box-sizing:border-box;background:var(--card);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:0.65rem 0.85rem;font-family:inherit;font-size:0.9rem;margin-bottom:0.65rem">
      <div id="magic-login-msg" style="display:none;font-size:0.82rem;margin-bottom:0.65rem"></div>
      <button class="btn secondary" onclick="sendMagicLoginLink()" style="width:100%;font-size:0.85rem">
        📧 Magic Link anfordern
      </button>`;
    // Nach dem Login-Button einfügen
    const loginBtn = document.querySelector('#login-screen .btn');
    if (loginBtn && loginBtn.parentNode) {
      loginBtn.parentNode.insertBefore(tab, loginBtn.nextSibling);
    }
  }
}

async function sendMagicLoginLink() {
  const email = document.getElementById('magic-email-input').value.trim().toLowerCase();
  const msgEl = document.getElementById('magic-login-msg');
  msgEl.style.display = 'none';
  if (!email || !email.includes('@')) {
    msgEl.textContent = 'Bitte eine gültige E-Mail-Adresse eingeben.';
    msgEl.style.color = '#f87171';
    msgEl.style.display = 'block';
    return;
  }
  // Prüfen ob E-Mail im System bekannt ist
  const rows = await get(`entrances?email=eq.${encodeURIComponent(email)}&is_active=eq.true&select=id`);
  if (!rows || rows.length === 0) {
    msgEl.textContent = 'Diese E-Mail ist nicht registriert.';
    msgEl.style.color = '#f87171';
    msgEl.style.display = 'block';
    return;
  }
  const btn = document.querySelector('#magic-login-section .btn');
  btn.disabled = true;
  btn.textContent = 'Wird gesendet…';
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/magiclink`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    msgEl.textContent = `✓ Magic Link gesendet an ${email} — bitte E-Mail prüfen.`;
    msgEl.style.color = 'var(--green)';
    msgEl.style.display = 'block';
    btn.textContent = '✓ Gesendet';
  } catch(e) {
    btn.disabled = false;
    btn.textContent = '📧 Magic Link anfordern';
    msgEl.textContent = 'Fehler: ' + e.message;
    msgEl.style.color = '#f87171';
    msgEl.style.display = 'block';
  }
}

document.getElementById('login-pass').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});
document.getElementById('login-user').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('login-pass').focus();
});

function genMagicCode(inputId) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  document.getElementById(inputId).value = code;
  document.getElementById(inputId).select();
  try { document.execCommand('copy'); toast('Code kopiert: ' + code, 'success'); } catch(e) {}
}

function doLogout() {
  if (!confirm('Wirklich abmelden?')) return;
  if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }
  if (typeof sheetsAutoSyncTimer !== 'undefined' && sheetsAutoSyncTimer) { clearInterval(sheetsAutoSyncTimer); sheetsAutoSyncTimer = null; }
  sessionStorage.removeItem('gdsf_user');
  localStorage.removeItem('gdsf_offline_queue');
  currentUser = null;
  currentEventId = null;
  allGuests = [];
  events = [];
  document.getElementById('app').classList.remove('visible');
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('tab-admin-btn').style.display = 'none';
  document.querySelectorAll('.tab-btn').forEach((b,i) => b.classList.toggle('active', i===0));
  document.getElementById('view-checkin').style.display = 'flex';
  document.getElementById('view-dashboard').style.display = 'none';
  document.getElementById('view-admin').style.display = 'none';
  document.getElementById('view-admin').classList.remove('active');
  const logoutFooter = document.getElementById('app-footer');
  if (logoutFooter) logoutFooter.style.display = 'none';
}

// ── SHOW APP ─────────────────────────────────
async function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  document.getElementById('header-entrance').textContent = currentUser.name;
  document.getElementById('view-admin').style.display = 'none';
  document.getElementById('view-admin').classList.remove('active');
  document.getElementById('view-dashboard').style.display = 'none';
  document.getElementById('view-checkin').style.display = 'flex';
  // Show footer
  const footer = document.getElementById('app-footer');
  if (footer) footer.style.display = 'block';
  if (currentUser.is_admin) {
    document.getElementById('tab-admin-btn').style.display = '';
  } else {
    document.getElementById('tab-admin-btn').style.display = 'none';
  }
  await loadEvents();
  setupRealtime();
  requestWakeLock();
  updateThemeToggleIcon();
  if (typeof startSheetsAutoSync === 'function') startSheetsAutoSync();
}

// ── EVENTS ───────────────────────────────────
// BUG FIX: sort_order Spalte könnte fehlen → query ohne sort_order,
// Sortierung passiert nur im JS (mit null-check)
// Events dienen nur noch der Tages-Statistik (Dashboard) und der internen
// Zuordnung von Check-in-Log-Einträgen — die Gästeliste selbst ist global
// und wird nicht mehr nach Event gefiltert.
async function loadEvents() {
  let rawEvents = [];
  try {
    rawEvents = await get('events?select=*') || [];
  } catch(e) {
    console.error('loadEvents error:', e);
    toast('Fehler beim Laden der Events: ' + e.message, 'error');
    return;
  }
  events = rawEvents.sort(function(a, b) {
    // sort_order wenn vorhanden, sonst nach Datum
    if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
    if (a.sort_order != null) return -1;
    if (b.sort_order != null) return 1;
    return (a.event_date || '').localeCompare(b.event_date || '');
  });
  if (events.length > 0 && !currentEventId) {
    // Nur intern zur Zuordnung von checkin_log-Einträgen — betrifft nicht,
    // welche Gäste sichtbar/eincheckbar sind.
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const matching = events.find(e => e.event_date === today.toISOString().slice(0,10));
    currentEventId = (matching || events[0]).id;
  }
  document.getElementById('header-event-name').textContent = 'Gästeliste';
  await loadGuests();
  if (currentUser.is_admin) {
    renderAdminEventPills();
    renderEventsList();
    loadAdminStats();
    loadAccounts();
  }
}

// Ein Event gilt als "vorbei", sobald der Kalendertag (event_date) verstrichen ist (ab 0:00 Uhr).
// Wird noch für die Admin-Ansicht/Statistik verwendet, nicht mehr für den Check-in selbst.
function isPastEvent_(ev) {
  if (!ev || !ev.event_date) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(ev.event_date + 'T00:00:00');
  return d < today;
}

function renderAdminEventPills() {
  const containers = ['event-pills-admin','event-pills-import','event-pills-addguest'];
  containers.forEach(id => {
    const c = document.getElementById(id);
    if (!c) return;
    c.innerHTML = events.map(e =>
      `<div class="event-pill ${e.id===currentEventId?'active':''}" onclick="selectAdminEvent('${e.id}','${id}')">${e.name}</div>`
    ).join('');
  });
  if (events.length > 0 && !importEventId) importEventId = events[0].id;
  if (events.length > 0 && !addGuestEventId) addGuestEventId = events[0].id;
}

function selectAdminEvent(id, fromPillsId) {
  const pills = document.querySelectorAll('#' + fromPillsId + ' .event-pill');
  pills.forEach(p => p.classList.remove('active'));
  pills.forEach(p => {
    if (p.getAttribute('onclick') && p.getAttribute('onclick').includes("'" + id + "'")) p.classList.add('active');
  });
  if (fromPillsId === 'event-pills-import') {
    importEventId = id;
  } else if (fromPillsId === 'event-pills-addguest') {
    addGuestEventId = id;
  } else {
    currentEventId = id;
    loadAdminStats();
  }
}

// ── GUESTS ───────────────────────────────────
// Globale Gästeliste — gilt für beide Tage, kein Tages-Filter mehr.
async function loadGuests() {
  try {
    allGuests = await get(`guests?order=nachname.asc&select=*`) || [];
    updateStats();
    applySearch();
    if (typeof renderAdminGuestList === 'function') renderAdminGuestList();
  } catch(e) {
    toast('Fehler beim Laden: ' + e.message, 'error');
  }
}

function updateStats() {
  const checked = allGuests.filter(g => g.checked_in).length;
  const vip = allGuests.filter(g => g.vip).length;
  document.getElementById('stat-checked').textContent = checked;
  document.getElementById('stat-total').textContent = allGuests.length;
  document.getElementById('stat-vip').textContent = vip;
  document.getElementById('stat-remaining').textContent = allGuests.length - checked;
  document.getElementById('header-stat').textContent = `${checked}/${allGuests.length}`;
}

// ── SEARCH ───────────────────────────────────
function onSearch() {
  const q = document.getElementById('search-input').value;
  document.getElementById('search-clear').style.display = q ? 'block' : 'none';
  applySearch();
}

function clearSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').style.display = 'none';
  applySearch();
}

function applySearch() {
  const q = document.getElementById('search-input').value.toLowerCase().trim();
  if (!q) {
    filteredGuests = [...allGuests];
  } else {
    filteredGuests = allGuests.filter(g => {
      const haystack = [g.vorname, g.nachname, g.firma, g.kategorie].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }
  // BATCH 1: Filter "Noch nicht da"
  if (pendingOnly) {
    filteredGuests = filteredGuests.filter(g => !g.checked_in);
  }
  filteredGuests.sort((a, b) => {
    if (a.checked_in !== b.checked_in) return a.checked_in ? 1 : -1;
    if (a.vip !== b.vip) return a.vip ? -1 : 1;
    return (a.nachname || '').localeCompare(b.nachname || '');
  });
  renderGuestList();
  renderAZSidebar();
}

// ── RENDER GUESTS ────────────────────────────
function renderGuestList() {
  const el = document.getElementById('guest-list');
  if (filteredGuests.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="icon">🔍</div><p>Keine Gäste gefunden.</p></div>`;
    return;
  }
  el.innerHTML = filteredGuests.map(g => {
    const initials = [(g.vorname||'').charAt(0), (g.nachname||'').charAt(0)].join('').toUpperCase();
    const fullName = [g.vorname, g.nachname].filter(Boolean).join(' ');
    const letter = ((g.nachname || g.vorname || '')[0] || '').toUpperCase();
    const meta = [g.firma, g.kategorie].filter(Boolean).join(' · ');
    const checkedTime = g.checked_in_at ? new Date(g.checked_in_at).toLocaleString('de-AT', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
    return `<div class="guest-card ${g.checked_in?'checked':''} ${g.vip?'vip':''}" data-letter="${letter}">
      <div class="guest-avatar">
        ${initials}
        ${g.vip ? '<div class="vip-star">★</div>' : ''}
      </div>
      <div class="guest-info">
        <div class="guest-name">
          ${g.vip ? '<span class="guest-badge">VIP</span>' : ''}
          ${escHtml(fullName)}
        </div>
        <div class="guest-meta">${escHtml(meta)}</div>
        ${g.notiz ? `<div class="guest-meta" style="color:var(--accent);margin-top:0.1rem">📝 ${escHtml(g.notiz)}</div>` : ''}
      </div>
      <div class="guest-right">
        ${g.checked_in
          ? `<div class="checked-badge">✓ OK<div class="checked-time">${checkedTime}</div></div>
             ${currentUser && currentUser.is_admin ? `<button class="icon-btn" title="Check-in rückgängig machen" onclick="undoCheckin('${g.id}')" style="margin-left:0.4rem">↩</button>` : ''}
             ${currentUser && currentUser.is_admin ? `<button class="icon-btn del" title="Gast löschen" onclick="deleteGuestAdmin('${g.id}')" style="margin-left:0.2rem">🗑</button>` : ''}`
          : `<button class="checkin-btn" onclick="openConfirm('${g.id}')">Check-In</button>
             ${currentUser && currentUser.is_admin ? `<button class="icon-btn del" title="Gast löschen" onclick="deleteGuestAdmin('${g.id}')" style="margin-left:0.4rem">🗑</button>` : ''}`
        }
      </div>
    </div>`;
  }).join('');
}

function escHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── CHECKIN FLOW ─────────────────────────────
// Admin-only: einzelnen Check-in rückgängig machen (z.B. bei Fehl-Check-in am Eingang)
async function undoCheckin(guestId) {
  if (!currentUser || !currentUser.is_admin) return;
  const g = allGuests.find(x => x.id === guestId);
  if (!g) return;
  if (!confirm('Check-in von "' + [g.vorname, g.nachname].filter(Boolean).join(' ') + '" wirklich rückgängig machen?')) return;
  try {
    await patch('guests?id=eq.' + guestId, { checked_in: false, checked_in_at: null, checked_in_by: null });
    toast('✓ Check-in rückgängig gemacht');
    await loadGuests();
    if (typeof pushCheckinToSheets === 'function') {
      pushCheckinToSheets({ vorname: g.vorname, nachname: g.nachname }, '', '', false).catch(() => {});
    }
  } catch(e) {
    toast('Fehler: ' + e.message, 'error');
  }
}

function openConfirm(guestId) {
  const g = allGuests.find(x => x.id === guestId);
  if (!g || g.checked_in) return;
  pendingCheckin = g;
  const fullName = [g.vorname, g.nachname].filter(Boolean).join(' ');
  document.getElementById('overlay-name').textContent = fullName;
  document.getElementById('overlay-meta').textContent = [g.firma, g.kategorie, g.notiz].filter(Boolean).join(' · ');
  document.getElementById('overlay-vip-badge').style.display = g.vip ? 'inline-flex' : 'none';
  document.getElementById('confirm-overlay').classList.add('show');
}

function closeConfirm() {
  document.getElementById('confirm-overlay').classList.remove('show');
  pendingCheckin = null;
}

async function confirmCheckin() {
  if (!pendingCheckin) return;
  const g = pendingCheckin;
  closeConfirm();
  const now = new Date().toISOString();
  const fullName = [g.vorname, g.nachname].filter(Boolean).join(' ');
  const idx = allGuests.findIndex(x => x.id === g.id);
  if (idx !== -1) {
    allGuests[idx].checked_in = true;
    allGuests[idx].checked_in_at = now;
    allGuests[idx].checked_in_by = currentUser.name;
  }
  updateStats();
  applySearch();
  showSuccessFlash(fullName, g.vip);
  addLiveFeedItem(g, currentUser.name);
  setLastCheckin(fullName, currentUser.name);
  if (!isOnline) {
    offlineQueue.push({ guest_id: g.id, event_id: currentEventId, vorname: g.vorname, nachname: g.nachname, checked_in_at: now, entrance: currentUser.name });
    saveOfflineQueue();
    updateOfflineBadge();
    toast('📵 Offline gespeichert – wird synchronisiert sobald Verbindung besteht');
    return;
  }
  try {
    // RACE-CONDITION-FIX: Bedingtes Update – greift nur, wenn der Gast
    // noch NICHT eingecheckt ist. Kommt ein leeres Array zurück, war ein
    // anderer Eingang schneller.
    const res = await patch(`guests?id=eq.${g.id}&checked_in=eq.false`, {
      checked_in: true, checked_in_at: now, checked_in_by: currentUser.name
    });
    if (!res || res.length === 0) {
      // Konflikt: Gast wurde bereits anderswo eingecheckt → echten Stand laden
      try {
        const rows = await get(`guests?id=eq.${g.id}&select=*`);
        if (rows && rows[0] && idx !== -1) allGuests[idx] = rows[0];
      } catch(e) {}
      updateStats();
      applySearch();
      playTone('already');
      const by = (idx !== -1 && allGuests[idx].checked_in_by) ? allGuests[idx].checked_in_by : 'einem anderen Eingang';
      toast(`⚠ ${fullName} wurde bereits von ${by} eingecheckt`);
      return;
    }
    await post('checkin_log', {
      guest_id: g.id, event_id: currentEventId, entrance_name: currentUser.name, action: 'checkin'
    });
    if (typeof pushCheckinToSheets === 'function') {
      pushCheckinToSheets(g, currentUser.name, now).catch(()=>{});
    }
  } catch(e) {
    offlineQueue.push({ guest_id: g.id, event_id: currentEventId, vorname: g.vorname, nachname: g.nachname, checked_in_at: now, entrance: currentUser.name });
    saveOfflineQueue();
    setOnlineState(false);
    updateOfflineBadge();
    toast('📵 Verbindung unterbrochen – lokal gespeichert');
  }
}

function showSuccessFlash(name, isVip) {
  const el = document.getElementById('success-flash');
  document.getElementById('success-name').textContent = name;
  el.classList.add('show');
  playTone(isVip ? 'vip' : 'success');
  if (navigator.vibrate) navigator.vibrate(isVip ? [50, 30, 50, 30, 80] : [50, 30, 50]);
  setTimeout(() => el.classList.remove('show'), 1200);
}

// ── LIVE FEED ────────────────────────────────
function addLiveFeedItem(guest, entrance) {
  const feed = document.getElementById('live-feed');
  const items = document.getElementById('live-feed-items');
  feed.style.display = 'block';
  const name = [guest.vorname, guest.nachname].filter(Boolean).join(' ');
  const time = new Date().toLocaleTimeString('de-AT', {hour:'2-digit',minute:'2-digit'});
  const div = document.createElement('div');
  div.className = 'live-item';
  div.innerHTML = `<span style="color:var(--green)">✓</span><span class="name">${escHtml(name)}</span><span class="entrance">${escHtml(entrance)} · ${time}</span>`;
  items.insertBefore(div, items.firstChild);
  while (items.children.length > 5) items.removeChild(items.lastChild);
}

// ── OFFLINE QUEUE ────────────────────────────
let offlineQueue = [];
try { offlineQueue = JSON.parse(localStorage.getItem('gdsf_offline_queue') || '[]'); } catch(e) {}
let isOnline = true;

function setOnlineState(online) {
  if (isOnline === online) return;
  isOnline = online;
  const banner = document.getElementById('offline-banner');
  const ind = document.getElementById('conn-indicator');
  if (online) {
    banner.classList.remove('show');
    ind.classList.remove('error');
    ind.classList.add('connected');
    flushOfflineQueue();
  } else {
    banner.classList.add('show');
    ind.classList.remove('connected');
    ind.classList.add('error');
  }
  updateOfflineBadge();
}

function updateOfflineBadge() {
  const badge = document.getElementById('offline-count');
  if (offlineQueue.length > 0) {
    badge.textContent = offlineQueue.length;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

function saveOfflineQueue() {
  try { localStorage.setItem('gdsf_offline_queue', JSON.stringify(offlineQueue)); } catch(e) {}
}

async function flushOfflineQueue() {
  if (offlineQueue.length === 0) return;
  const toSync = [...offlineQueue];
  for (const item of toSync) {
    try {
      // Bedingtes Update – falls der Gast inzwischen anderswo eingecheckt
      // wurde, NICHT überschreiben und keinen Log-Eintrag doppeln.
      const res = await patch(`guests?id=eq.${item.guest_id}&checked_in=eq.false`, {
        checked_in: true, checked_in_at: item.checked_in_at, checked_in_by: item.entrance
      });
      if (res && res.length > 0) {
        await post('checkin_log', {
          guest_id: item.guest_id, event_id: item.event_id,
          entrance_name: item.entrance, action: 'checkin'
        });
        if (typeof pushCheckinToSheets === 'function') {
          pushCheckinToSheets({ vorname: item.vorname, nachname: item.nachname, event_id: item.event_id }, item.entrance, item.checked_in_at).catch(()=>{});
        }
      }
      offlineQueue = offlineQueue.filter(x => x.guest_id !== item.guest_id);
      saveOfflineQueue();
    } catch(e) { break; }
  }
  updateOfflineBadge();
  if (offlineQueue.length === 0) toast('✓ Offline Check-ins synchronisiert!', 'success');
}

// ── REALTIME (Polling) ───────────────────────
function setupRealtime() {
  const indicator = document.getElementById('conn-indicator');
  let lastPoll = Date.now();
  indicator.classList.add('connected');
  let pollInterval = 6000;
  let failCount = 0;
  flushOfflineQueue();

  async function doPoll() {
    if (!currentEventId) { setTimeout(doPoll, pollInterval); return; }
    try {
      const since = new Date(lastPoll - 8000).toISOString();
      const updated = await get(`guests?event_id=eq.${currentEventId}&checked_in=eq.true&checked_in_at=gt.${since}&select=*`);
      lastPoll = Date.now();
      failCount = 0;
      pollInterval = 6000;
      if (updated && updated.length > 0) {
        let changed = false;
        updated.forEach(g => {
          const idx = allGuests.findIndex(x => x.id === g.id);
          if (idx !== -1 && !allGuests[idx].checked_in) {
            allGuests[idx] = g;
            changed = true;
            addLiveFeedItem(g, g.checked_in_by || '–');
            // Last-Check-in-Bar auch bei Check-ins anderer Eingänge updaten
            const nm = [g.vorname, g.nachname].filter(Boolean).join(' ');
            const atMs = g.checked_in_at ? new Date(g.checked_in_at).getTime() : Date.now();
            if (!lastCheckin || atMs >= lastCheckin.at) setLastCheckin(nm, g.checked_in_by || '', atMs);
          } else if (idx !== -1) {
            allGuests[idx] = g;
          }
        });
        if (changed) { updateStats(); applySearch(); }
      }
      setOnlineState(true);
    } catch(e) {
      failCount++;
      setOnlineState(false);
      pollInterval = Math.min(30000, 6000 * Math.pow(1.5, failCount));
    }
    setTimeout(doPoll, pollInterval);
  }

  setTimeout(doPoll, pollInterval);
  window.addEventListener('online',  () => { pollInterval = 6000; doPoll(); });
  window.addEventListener('offline', () => setOnlineState(false));
}

// ── ADMIN: STATS + CHARTS ────────────────────
async function loadAdminStats() {
  if (!currentEventId) return;
  const ev = events.find(e => e.id === currentEventId);
  document.getElementById('admin-event-label').textContent = ev ? ev.name : '–';
  try {
    const guests = await get(`guests?event_id=eq.${currentEventId}&select=id,checked_in,vip,kategorie,checked_in_by,checked_in_at`) || [];
    const total = guests.length;
    const checked = guests.filter(g => g.checked_in).length;
    const vip = guests.filter(g => g.vip).length;
    const pct = total > 0 ? Math.round(checked/total*100) : 0;
    document.getElementById('a-total').textContent = total;
    document.getElementById('a-checked').textContent = checked;
    document.getElementById('a-vip').textContent = vip;
    document.getElementById('a-pending').textContent = total - checked;
    document.getElementById('a-pct').textContent = pct + '%';
    document.getElementById('a-progress').style.width = pct + '%';
    const circ = 2 * Math.PI * 35;
    const arc = (checked / (total || 1)) * circ;
    document.getElementById('donut-arc').setAttribute('stroke-dasharray', `${arc.toFixed(1)} ${circ.toFixed(1)}`);
    document.getElementById('donut-pct').textContent = pct + '%';
    const byEntrance = {};
    guests.filter(g => g.checked_in && g.checked_in_by).forEach(g => {
      byEntrance[g.checked_in_by] = (byEntrance[g.checked_in_by] || 0) + 1;
    });
    const entranceEl = document.getElementById('entrance-chart');
    const maxE = Math.max(...Object.values(byEntrance), 1);
    if (Object.keys(byEntrance).length === 0) {
      entranceEl.innerHTML = '<div style="color:var(--muted);font-size:0.75rem;text-align:center;padding:0.5rem">Noch keine Check-ins</div>';
    } else {
      entranceEl.innerHTML = Object.entries(byEntrance).sort((a,b) => b[1]-a[1]).map(([name, count]) => {
        const pctBar = Math.round(count/maxE*100);
        return `<div>
          <div style="display:flex;justify-content:space-between;font-size:0.7rem;margin-bottom:0.2rem">
            <span style="color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%">${escHtml(name)}</span>
            <span style="color:var(--accent);font-weight:600">${count}</span>
          </div>
          <div style="background:var(--border);border-radius:4px;height:5px">
            <div style="background:var(--accent);height:5px;border-radius:4px;width:${pctBar}%;transition:width 0.4s ease"></div>
          </div>
        </div>`;
      }).join('');
    }
    const byCat = {};
    guests.forEach(g => {
      const cat = g.kategorie || 'Sonstige';
      if (!byCat[cat]) byCat[cat] = { total: 0, checked: 0 };
      byCat[cat].total++;
      if (g.checked_in) byCat[cat].checked++;
    });
    const catEl = document.getElementById('category-chart');
    catEl.innerHTML = Object.entries(byCat).sort((a,b) => b[1].total - a[1].total).map(([cat, d]) => {
      const p = Math.round(d.checked/d.total*100);
      return `<div>
        <div style="display:flex;justify-content:space-between;font-size:0.7rem;margin-bottom:0.2rem">
          <span style="color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%">${escHtml(cat)}</span>
          <span style="color:var(--muted)">${d.checked}/${d.total} <span style="color:var(--green)">${p}%</span></span>
        </div>
        <div style="background:var(--border);border-radius:4px;height:5px">
          <div style="background:var(--green);height:5px;border-radius:4px;width:${p}%;transition:width 0.4s ease"></div>
        </div>
      </div>`;
    }).join('');
    renderTimelineChart(guests.filter(g => g.checked_in && g.checked_in_at));
  } catch(e) { console.error('loadAdminStats:', e); }
}

function renderTimelineChart(checkedGuests) {
  const svg = document.getElementById('timeline-chart');
  if (!svg) return;
  if (checkedGuests.length === 0) {
    svg.innerHTML = '<text x="50%" y="35" text-anchor="middle" font-family="DM Sans,sans-serif" font-size="11" fill="#6b6b80">Noch keine Check-ins</text>';
    return;
  }
  const buckets = {};
  checkedGuests.forEach(g => {
    const d = new Date(g.checked_in_at);
    const key = `${d.getHours()}:${d.getMinutes() < 30 ? '00' : '30'}`;
    buckets[key] = (buckets[key] || 0) + 1;
  });
  const keys = Object.keys(buckets).sort();
  const vals = keys.map(k => buckets[k]);
  const maxV = Math.max(...vals, 1);
  const W = 260, H = 50, pad = 4;
  const bw = Math.max(8, Math.floor((W - pad*(keys.length+1)) / keys.length));
  let bars = '';
  keys.forEach((k, i) => {
    const bh = Math.round((vals[i]/maxV) * (H-14));
    const x = pad + i*(bw+pad);
    const y = H - bh - 12;
    bars += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="2" fill="url(#barGrad)" opacity="0.9"/>`;
    if (i % 2 === 0 || keys.length <= 6) {
      bars += `<text x="${x+bw/2}" y="${H}" text-anchor="middle" font-family="DM Sans,sans-serif" font-size="8" fill="#6b6b80">${k}</text>`;
    }
    bars += `<text x="${x+bw/2}" y="${y-2}" text-anchor="middle" font-family="DM Sans,sans-serif" font-size="8" fill="var(--accent)" font-weight="bold">${vals[i]}</text>`;
  });
  svg.innerHTML = `<defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#f0c040"/><stop offset="100%" stop-color="#e05a00"/>
  </linearGradient></defs>${bars}`;
}

// ── ADMIN: EVENTS LIST ───────────────────────
function renderEventsList() {
  const el = document.getElementById('events-list');
  if (!events.length) { el.innerHTML = '<div style="color:var(--muted);font-size:0.85rem">Noch keine Events.</div>'; return; }
  const sorted = [...events].sort((a,b) => {
    if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
    if (a.sort_order != null) return -1;
    if (b.sort_order != null) return 1;
    return (a.event_date||'').localeCompare(b.event_date||'');
  });
  el.innerHTML = '';
  sorted.forEach(function(e, idx) {
    const row = document.createElement('div');
    row.className = 'account-row';
    const sortDiv = document.createElement('div');
    sortDiv.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin-right:0.4rem';
    const btnUp = document.createElement('button');
    btnUp.className = 'icon-btn';
    btnUp.textContent = '▲';
    btnUp.style.cssText = 'padding:0.15rem 0.4rem;font-size:0.7rem';
    if (idx === 0) btnUp.disabled = true;
    btnUp.onclick = function() { moveEvent(e.id, -1); };
    const btnDown = document.createElement('button');
    btnDown.className = 'icon-btn';
    btnDown.textContent = '▼';
    btnDown.style.cssText = 'padding:0.15rem 0.4rem;font-size:0.7rem';
    if (idx === sorted.length - 1) btnDown.disabled = true;
    btnDown.onclick = function() { moveEvent(e.id, 1); };
    sortDiv.appendChild(btnUp);
    sortDiv.appendChild(btnDown);
    row.appendChild(sortDiv);
    const info = document.createElement('div');
    info.className = 'account-info';
    const nameDiv = document.createElement('div');
    nameDiv.className = 'account-name';
    nameDiv.textContent = e.name;
    const dateDiv = document.createElement('div');
    dateDiv.className = 'account-user';
    dateDiv.textContent = e.event_date ? new Date(e.event_date).toLocaleDateString('de-AT') : '–';
    info.appendChild(nameDiv);
    info.appendChild(dateDiv);
    row.appendChild(info);
    const badge = document.createElement('span');
    badge.className = 'account-badge ' + (e.is_active ? 'badge-door' : 'badge-admin');
    badge.textContent = e.is_active ? 'Aktiv' : 'Inaktiv';
    row.appendChild(badge);
    const actions = document.createElement('div');
    actions.className = 'account-actions';
    const btnDel = document.createElement('button');
    btnDel.className = 'icon-btn del';
    btnDel.textContent = '🗑';
    btnDel.onclick = function() { deleteEvent(e.id); };
    actions.appendChild(btnDel);
    row.appendChild(actions);
    el.appendChild(row);
  });
}

async function moveEvent(id, direction) {
  const sorted = [...events].sort((a,b) => {
    if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
    if (a.sort_order != null) return -1;
    if (b.sort_order != null) return 1;
    return (a.event_date||'').localeCompare(b.event_date||'');
  });
  const idx = sorted.findIndex(e => e.id === id);
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= sorted.length) return;
  sorted.forEach((e, i) => e.sort_order = i * 10);
  const tmp = sorted[idx].sort_order;
  sorted[idx].sort_order = sorted[swapIdx].sort_order;
  sorted[swapIdx].sort_order = tmp;
  try {
    await Promise.all([
      patch(`events?id=eq.${sorted[idx].id}`, { sort_order: sorted[idx].sort_order }),
      patch(`events?id=eq.${sorted[swapIdx].id}`, { sort_order: sorted[swapIdx].sort_order })
    ]);
    await loadEvents();
  } catch(e) { toast('Fehler beim Speichern: ' + e.message, 'error'); }
}

async function deleteEvent(id) {
  if (!confirm('Event und alle Gäste löschen?')) return;
  await del(`events?id=eq.${id}`);
  toast('Event gelöscht');
  await loadEvents();
}

function showNewEventModal() {
  const modal = document.getElementById('event-modal');
  modal.classList.add('show');
  document.getElementById('new-evt-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('event-modal-error').style.display = 'none';
}
function closeEventModal() { document.getElementById('event-modal').classList.remove('show'); }

async function saveNewEvent() {
  const name = document.getElementById('new-evt-name').value.trim();
  const date = document.getElementById('new-evt-date').value;
  const errEl = document.getElementById('event-modal-error');
  errEl.style.display = 'none';
  if (!name || !date) { errEl.textContent = 'Name und Datum sind Pflichtfelder.'; errEl.style.display = 'block'; return; }
  const createBtn = document.getElementById('create-event-btn');
  if (createBtn) { createBtn.textContent = '…'; createBtn.disabled = true; }
  try {
    const response = await fetch(SUPABASE_URL + '/rest/v1/events', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=representation'
      },
      body: JSON.stringify({ name, event_date: date, is_active: true })
    });
    const responseText = await response.text();
    if (!response.ok) { throw new Error('HTTP ' + response.status + ': ' + responseText); }
    closeEventModal();
    document.getElementById('new-evt-name').value = '';
    toast('Event erstellt ✓', 'success');
    await loadEvents();
  } catch(e) {
    errEl.textContent = 'Fehler: ' + e.message;
    errEl.style.display = 'block';
  } finally {
    if (createBtn) { createBtn.textContent = 'Erstellen'; createBtn.disabled = false; }
  }
}

// ── ADMIN: ACCOUNTS ──────────────────────────
let editingAccountId = null;

function makeInput(idStr, valStr, phStr, accent) {
  var inp = document.createElement('input');
  inp.id = idStr;
  if (valStr !== null) inp.value = valStr;
  inp.placeholder = phStr;
  var border = accent ? 'var(--accent)' : 'var(--border)';
  inp.style.cssText = 'flex:1;background:var(--card);border:1px solid ' + border + ';border-radius:6px;color:var(--text);padding:0.45rem 0.6rem;font-family:inherit;font-size:0.85rem';
  return inp;
}

async function loadAccounts() {
  const rows = await get('entrances?order=is_admin.desc,name.asc&select=*') || [];
  // Check-ins pro Account zählen (gesamte Gästeliste, beide Tage) — für die Anzeige
  // neben jedem Eingangs-Account.
  const checkinCounts = {};
  try {
    const checkedGuests = await get('guests?checked_in=eq.true&select=checked_in_by') || [];
    checkedGuests.forEach(g => {
      if (!g.checked_in_by) return;
      checkinCounts[g.checked_in_by] = (checkinCounts[g.checked_in_by] || 0) + 1;
    });
  } catch(e) { console.warn('Check-in-Zähler konnte nicht geladen werden:', e); }
  const el = document.getElementById('accounts-list');
  el.innerHTML = '';
  rows.forEach(function(r) {
    if (editingAccountId === r.id) {
      const row = document.createElement('div');
      row.className = 'account-row';
      row.id = 'acc-edit-' + r.id;
      row.style.cssText = 'flex-direction:column;align-items:stretch;gap:0.5rem';
      const row1 = document.createElement('div');
      row1.style.cssText = 'display:flex;gap:0.5rem';
      row1.appendChild(makeInput('en-' + r.id, r.name, 'Name', true));
      row1.appendChild(makeInput('eu-' + r.id, r.username, 'Username', false));
      const row2 = document.createElement('div');
      row2.style.cssText = 'display:flex;gap:0.5rem;align-items:center';
      const inPass = makeInput('ep-' + r.id, null, 'Neues Passwort (leer = unverändert)', false);
      const btnM = document.createElement('button');
      btnM.className = 'icon-btn';
      btnM.title = 'Magic Code';
      btnM.textContent = '🎲';
      btnM.style.cssText = 'padding:0.4rem 0.6rem;font-size:1rem';
      btnM.setAttribute('data-pid', r.id);
      btnM.addEventListener('click', function() { genMagicCode('ep-' + this.getAttribute('data-pid')); });
      row2.appendChild(inPass);
      row2.appendChild(btnM);
      const row3 = document.createElement('div');
      row3.style.cssText = 'display:flex;gap:0.5rem;align-items:center';
      const sel = document.createElement('select');
      sel.id = 'er-' + r.id;
      sel.style.cssText = 'background:var(--card);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:0.4rem 0.5rem;font-family:inherit;font-size:0.82rem';
      const optTuer = document.createElement('option');
      optTuer.value = 'false'; optTuer.textContent = 'Türpersonal';
      if (!r.is_admin) optTuer.selected = true;
      const optAdmin = document.createElement('option');
      optAdmin.value = 'true'; optAdmin.textContent = 'Admin';
      if (r.is_admin) optAdmin.selected = true;
      sel.appendChild(optTuer);
      sel.appendChild(optAdmin);
      const btnSave = document.createElement('button');
      btnSave.className = 'btn green';
      btnSave.textContent = '✓ Speichern';
      btnSave.style.cssText = 'flex:1;font-size:0.8rem;padding:0.4rem 0.75rem';
      btnSave.setAttribute('data-rid', r.id);
      btnSave.addEventListener('click', function() { saveAccountEdit(this.getAttribute('data-rid')); });
      const btnCan = document.createElement('button');
      btnCan.className = 'btn secondary';
      btnCan.textContent = '✕';
      btnCan.style.cssText = 'width:auto;font-size:0.8rem;padding:0.4rem 0.75rem';
      btnCan.addEventListener('click', cancelAccountEdit);
      row3.appendChild(sel);
      row3.appendChild(btnSave);
      row3.appendChild(btnCan);
      row.appendChild(row1);
      row.appendChild(row2);
      row.appendChild(row3);
      el.appendChild(row);
    } else {
      const row = document.createElement('div');
      row.className = 'account-row';
      const info = document.createElement('div');
      info.className = 'account-info';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'account-name';
      nameDiv.textContent = r.name;
      const userDiv = document.createElement('div');
      userDiv.className = 'account-user';
      // E-Mail und Registrierungsstatus anzeigen
      const emailInfo = r.email ? `📧 ${r.email}` : (r.must_register ? '⏳ Wartet auf Erstlogin' : '—');
      userDiv.textContent = '@' + r.username + ' · ' + emailInfo;
      info.appendChild(nameDiv);
      info.appendChild(userDiv);
      row.appendChild(info);
      const badge = document.createElement('span');
      badge.className = 'account-badge ' + (r.is_admin ? 'badge-admin' : 'badge-door');
      badge.textContent = r.is_admin ? 'Admin' : 'Tür';
      row.appendChild(badge);
      if (!r.is_admin) {
        const count = checkinCounts[r.name] || 0;
        const countSpan = document.createElement('span');
        countSpan.title = 'Check-ins durch diesen Account (gesamt, beide Tage)';
        countSpan.style.cssText = 'font-size:0.75rem;color:var(--muted);white-space:nowrap;padding:0 0.25rem';
        countSpan.textContent = '✓ ' + count;
        row.appendChild(countSpan);
      }
      const actions = document.createElement('div');
      actions.className = 'account-actions';
      const btnEdit = document.createElement('button');
      btnEdit.className = 'icon-btn';
      btnEdit.title = 'Bearbeiten';
      btnEdit.textContent = '✏️';
      btnEdit.setAttribute('data-rid', r.id);
      btnEdit.addEventListener('click', function() { startAccountEdit(this.getAttribute('data-rid')); });
      const btnDel = document.createElement('button');
      btnDel.className = 'icon-btn del';
      btnDel.textContent = '🗑';
      btnDel.disabled = (r.username === 'admin');
      btnDel.setAttribute('data-rid', r.id);
      btnDel.setAttribute('data-user', r.username);
      btnDel.addEventListener('click', function() { deleteAccount(this.getAttribute('data-rid'), this.getAttribute('data-user')); });
      actions.appendChild(btnEdit);
      actions.appendChild(btnDel);
      row.appendChild(actions);
      el.appendChild(row);
    }
  });
}

function startAccountEdit(id) { editingAccountId = id; loadAccounts(); }
function cancelAccountEdit() { editingAccountId = null; loadAccounts(); }

async function saveAccountEdit(id) {
  const name = document.getElementById(`en-${id}`).value.trim();
  const username = document.getElementById(`eu-${id}`).value.trim().toLowerCase();
  const pass = document.getElementById(`ep-${id}`).value.trim();
  const is_admin = document.getElementById(`er-${id}`).value === 'true';
  if (!name || !username) { toast('Name und Benutzername erforderlich', 'error'); return; }
  const update = { name, username, is_admin };
  if (pass) update.password_hash = pass;
  try {
    await patch(`entrances?id=eq.${id}`, update);
    editingAccountId = null;
    toast('Account gespeichert ✓', 'success');
    loadAccounts();
  } catch(e) { toast('Fehler: ' + e.message, 'error'); }
}

function showNewAccountModal() { document.getElementById('account-modal').classList.add('show'); }
function closeAccountModal() { document.getElementById('account-modal').classList.remove('show'); }

async function saveNewAccount() {
  const name = document.getElementById('new-acc-name').value.trim();
  const username = document.getElementById('new-acc-user').value.trim().toLowerCase();
  const pass = document.getElementById('new-acc-pass').value.trim();
  const is_admin = document.getElementById('new-acc-role').value === 'true';
  if (!name || !username || !pass) { toast('Alle Felder erforderlich', 'error'); return; }
  try {
    // must_register = true für Türpersonal (nicht für Admins)
    // Türpersonal muss sich beim Erstlogin per Magic Link registrieren
    await post('entrances', {
      name, username, password_hash: pass, is_admin, is_active: true,
      must_register: !is_admin  // Admins brauchen kein Magic Link
    });
    closeAccountModal();
    document.getElementById('new-acc-name').value = '';
    document.getElementById('new-acc-user').value = '';
    document.getElementById('new-acc-pass').value = '';
    toast('Account erstellt ✓', 'success');
    loadAccounts();
  } catch(e) { toast('Fehler: ' + e.message, 'error'); }
}

async function deleteAccount(id, username) {
  if (!confirm(`Account "@${username}" löschen?`)) return;
  await del(`entrances?id=eq.${id}`);
  toast('Account gelöscht');
  loadAccounts();
}

// ── GÄSTELISTE VERWALTEN (Admin: bearbeiten / löschen) ──────
let editingGuestId = null;

function renderAdminGuestList() {
  const el = document.getElementById('admin-guestlist');
  if (!el) return; // Admin-Bereich noch nicht gerendert
  const countEl = document.getElementById('adm-guest-count');
  const searchInput = document.getElementById('adm-guest-search');
  const q = (searchInput ? searchInput.value : '').toLowerCase().trim();

  let list = allGuests || [];
  if (q) {
    list = list.filter(g => {
      const haystack = [g.vorname, g.nachname, g.firma, g.kategorie].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }
  list = [...list].sort((a, b) => (a.nachname || '').localeCompare(b.nachname || ''));

  if (countEl) countEl.textContent = list.length + ' / ' + (allGuests || []).length;
  el.innerHTML = '';

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--muted);font-size:0.8rem;padding:0.5rem 0.2rem';
    empty.textContent = 'Keine Gäste gefunden.';
    el.appendChild(empty);
    return;
  }

  list.forEach(function(g) {
    if (editingGuestId === g.id) {
      const row = document.createElement('div');
      row.className = 'account-row';
      row.style.cssText = 'flex-direction:column;align-items:stretch;gap:0.5rem';

      const row1 = document.createElement('div');
      row1.style.cssText = 'display:flex;gap:0.5rem';
      row1.appendChild(makeInput('gv-' + g.id, g.vorname || '', 'Vorname', false));
      row1.appendChild(makeInput('gn-' + g.id, g.nachname || '', 'Nachname *', true));

      const row2 = document.createElement('div');
      row2.style.cssText = 'display:flex;gap:0.5rem';
      row2.appendChild(makeInput('gf-' + g.id, g.firma || '', 'Firma / Organisation', false));
      row2.appendChild(makeInput('gk-' + g.id, g.kategorie || '', 'Kategorie', false));

      const row3 = document.createElement('div');
      row3.style.cssText = 'display:flex;gap:0.5rem';
      row3.appendChild(makeInput('gnt-' + g.id, g.notiz || '', 'Notiz', false));

      const row4 = document.createElement('div');
      row4.style.cssText = 'display:flex;align-items:center;gap:0.6rem';
      const vipLabel = document.createElement('label');
      vipLabel.style.cssText = 'display:flex;align-items:center;gap:0.4rem;font-size:0.8rem;color:var(--muted)';
      const vipCheck = document.createElement('input');
      vipCheck.type = 'checkbox';
      vipCheck.id = 'gvip-' + g.id;
      vipCheck.checked = !!g.vip;
      vipLabel.appendChild(vipCheck);
      vipLabel.appendChild(document.createTextNode('VIP'));
      row4.appendChild(vipLabel);

      const btnSave = document.createElement('button');
      btnSave.className = 'btn green';
      btnSave.textContent = '✓ Speichern';
      btnSave.style.cssText = 'flex:1;font-size:0.8rem;padding:0.4rem 0.75rem';
      btnSave.addEventListener('click', function() { saveGuestEditAdmin(g.id); });

      const btnCan = document.createElement('button');
      btnCan.className = 'btn secondary';
      btnCan.textContent = '✕';
      btnCan.style.cssText = 'width:auto;font-size:0.8rem;padding:0.4rem 0.75rem';
      btnCan.addEventListener('click', cancelGuestEdit);

      row4.appendChild(btnSave);
      row4.appendChild(btnCan);

      row.appendChild(row1);
      row.appendChild(row2);
      row.appendChild(row3);
      row.appendChild(row4);
      el.appendChild(row);
    } else {
      const row = document.createElement('div');
      row.className = 'account-row';

      const info = document.createElement('div');
      info.className = 'account-info';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'account-name';
      nameDiv.textContent = (g.vip ? '★ ' : '') + [g.vorname, g.nachname].filter(Boolean).join(' ');
      const metaDiv = document.createElement('div');
      metaDiv.className = 'account-user';
      metaDiv.textContent = [g.firma, g.kategorie].filter(Boolean).join(' · ') || '—';
      info.appendChild(nameDiv);
      info.appendChild(metaDiv);
      row.appendChild(info);

      if (g.checked_in) {
        const badge = document.createElement('span');
        badge.className = 'account-badge badge-admin';
        badge.textContent = '✓ Eingecheckt';
        badge.style.whiteSpace = 'nowrap';
        row.appendChild(badge);
      }

      const actions = document.createElement('div');
      actions.className = 'account-actions';
      const btnEdit = document.createElement('button');
      btnEdit.className = 'icon-btn';
      btnEdit.title = 'Bearbeiten';
      btnEdit.textContent = '✏️';
      btnEdit.addEventListener('click', function() { startGuestEdit(g.id); });
      const btnDel = document.createElement('button');
      btnDel.className = 'icon-btn del';
      btnDel.title = 'Löschen';
      btnDel.textContent = '🗑';
      btnDel.addEventListener('click', function() { deleteGuestAdmin(g.id); });
      actions.appendChild(btnEdit);
      actions.appendChild(btnDel);
      row.appendChild(actions);

      el.appendChild(row);
    }
  });
}

function startGuestEdit(id) { editingGuestId = id; renderAdminGuestList(); }
function cancelGuestEdit() { editingGuestId = null; renderAdminGuestList(); }

async function saveGuestEditAdmin(id) {
  const vorname = document.getElementById('gv-' + id).value.trim();
  const nachname = document.getElementById('gn-' + id).value.trim();
  const firma = document.getElementById('gf-' + id).value.trim();
  const kategorie = document.getElementById('gk-' + id).value.trim();
  const notiz = document.getElementById('gnt-' + id).value.trim();
  const vip = document.getElementById('gvip-' + id).checked;

  if (!nachname) { toast('Nachname ist Pflichtfeld', 'error'); return; }

  try {
    await patch(`guests?id=eq.${id}`, { vorname, nachname, firma, kategorie, notiz, vip });
    toast('Gast gespeichert');
    editingGuestId = null;
    await loadGuests();
    renderAdminGuestList();
  } catch(e) {
    toast('Fehler beim Speichern: ' + e.message, 'error');
  }
}

async function deleteGuestAdmin(id) {
  const g = (allGuests || []).find(x => x.id === id);
  const name = g ? [g.vorname, g.nachname].filter(Boolean).join(' ') : 'diesen Gast';
  let msg = `"${name}" endgültig aus der Gästeliste löschen? (wird auch im Google Sheet entfernt)`;
  if (g && g.checked_in) {
    msg = `⚠️ "${name}" ist bereits eingecheckt!\n\n` + msg + '\n\nDer Check-in geht dabei verloren.';
  }
  if (!confirm(msg)) return;
  try {
    await del(`guests?id=eq.${id}`);
    if (g && typeof pushDeleteToSheets === 'function') {
      pushDeleteToSheets(g).catch(() => {});
    }
    toast('Gast gelöscht');
    await loadGuests();
    renderAdminGuestList();
  } catch(e) {
    toast('Fehler beim Löschen: ' + e.message, 'error');
  }
}

// ── IMPORT ───────────────────────────────────
let importParsed = {};
let importSheets = [];

function handleFileImport(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
    importParsed = {};
    importSheets = wb.SheetNames;
    wb.SheetNames.forEach(name => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null });
      importParsed[name] = rows;
    });
    importSheetIndex = 0;
    renderImportPreview();
  };
  reader.readAsArrayBuffer(file);
}

function renderImportPreview() {
  const preview = document.getElementById('import-preview');
  const tabs = document.getElementById('import-sheet-tabs');
  const info = document.getElementById('import-info');
  preview.classList.add('show');
  tabs.innerHTML = importSheets.map((name, i) =>
    `<span class="import-sheet-tab ${i===importSheetIndex?'active':''}" onclick="selectImportSheet(${i})">${name}</span>`
  ).join('');
  const sheet = importSheets[importSheetIndex];
  const rows = importParsed[sheet] || [];
  info.textContent = `${rows.length} Gäste in Sheet "${sheet}"`;
}

function selectImportSheet(i) { importSheetIndex = i; renderImportPreview(); }

async function confirmImport() {
  if (!importEventId) { toast('Bitte zuerst ein Ziel-Event auswählen', 'error'); return; }
  const sheet = importSheets[importSheetIndex];
  const rows = importParsed[sheet] || [];
  if (rows.length === 0) { toast('Keine Daten', 'error'); return; }
  toast(`Importiere ${rows.length} Gäste…`);
  const guests = rows.map(r => ({
    event_id: importEventId,
    gl: r['GL'] ? true : false,
    vip: r['VIP'] ? true : false,
    vorname: r['Vorname'] || null,
    nachname: r['Nachname'] || '',
    firma: r['Firma / Organisation / Beschreibung'] || null,
    kategorie: r['Kategorie'] || null,
    notiz: r['Notiz'] || null,
    checked_in: false
  }));
  try {
    for (let i = 0; i < guests.length; i += 100) {
      await post('guests', guests.slice(i, i+100));
    }
    toast(`✓ ${guests.length} Gäste importiert!`, 'success');
    document.getElementById('import-preview').classList.remove('show');
    if (currentEventId === importEventId) await loadGuests();
    loadAdminStats();
  } catch(e) { toast('Import-Fehler: ' + e.message, 'error'); }
}

// ── ADD GUEST ────────────────────────────────
let agBegleitCount = 0;

function agBegleitChange(delta) {
  agBegleitCount = Math.max(0, Math.min(20, agBegleitCount + delta));
  document.getElementById('ag-begleit-count').textContent = agBegleitCount;
}

async function saveNewGuest() {
  const errEl = document.getElementById('ag-error');
  errEl.style.display = 'none';
  const targetEventId = addGuestEventId || currentEventId;
  if (!targetEventId) { errEl.textContent = 'Bitte zuerst ein Event auswählen.'; errEl.style.display = 'block'; return; }
  const nachname = document.getElementById('ag-nachname').value.trim();
  if (!nachname) { errEl.textContent = 'Nachname ist ein Pflichtfeld.'; errEl.style.display = 'block'; return; }
  const vorname = document.getElementById('ag-vorname').value.trim() || null;
  const baseFields = {
    event_id: targetEventId,
    firma: document.getElementById('ag-firma').value.trim() || null,
    kategorie: document.getElementById('ag-kategorie').value.trim() || null,
    notiz: document.getElementById('ag-notiz').value.trim() || null,
    vip: document.getElementById('ag-vip').checked,
    gl: document.getElementById('ag-gl').checked,
    checked_in: false
  };
  const hauptname = (vorname ? vorname + ' ' : '') + nachname;
  const guestsToSave = [
    { ...baseFields, vorname, nachname }
  ];
  for (let i = 1; i <= agBegleitCount; i++) {
    guestsToSave.push({
      ...baseFields,
      vorname: null,
      nachname: `${hauptname} - Begleitperson ${i}`
    });
  }
  const btn = document.querySelector('[onclick="saveNewGuest()"]');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const created = await post('guests', guestsToSave.length === 1 ? guestsToSave[0] : guestsToSave);
    const createdArr = Array.isArray(created) ? created : [created];
    if (typeof pushNewGuestsToSheets === 'function') {
      pushNewGuestsToSheets(createdArr).catch(e => console.warn('[Sheets] Push neuer Gäste fehlgeschlagen (nicht blockierend):', e));
    }
    ['ag-vorname','ag-nachname','ag-firma','ag-kategorie','ag-notiz'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('ag-vip').checked = false;
    document.getElementById('ag-gl').checked = true;
    const companionCount = guestsToSave.length - 1;
    agBegleitCount = 0;
    document.getElementById('ag-begleit-count').textContent = '0';
    const ev = events.find(e => e.id === targetEventId);
    const countSuffix = companionCount > 0 ? ` + ${companionCount} Begleitperson(en)` : '';
    toast(`✓ ${hauptname}${countSuffix} hinzugefügt${ev ? ' (' + ev.name + ')' : ''}`, 'success');
    loadAdminStats();
    if (currentEventId === targetEventId) await loadGuests();
  } catch(e) {
    errEl.textContent = 'Fehler: ' + e.message;
    errEl.style.display = 'block';
  } finally {
    if (btn) { btn.textContent = '👤 Gast speichern'; btn.disabled = false; }
  }
}

// ── EXPORT ───────────────────────────────────
async function exportCSV() {
  if (!currentEventId) return;
  const guests = await get(`guests?event_id=eq.${currentEventId}&order=nachname.asc&select=*`) || [];
  const ev = events.find(e => e.id === currentEventId);
  const headers = ['Vorname','Nachname','Firma','Kategorie','VIP','GL','Eingecheckt','Uhrzeit','Eingang','Notiz'];
  const rows = guests.map(g => [
    g.vorname||'', g.nachname||'', g.firma||'', g.kategorie||'',
    g.vip?'Ja':'Nein', g.gl?'Ja':'Nein',
    g.checked_in?'Ja':'Nein',
    g.checked_in_at ? new Date(g.checked_in_at).toLocaleTimeString('de-AT') : '',
    g.checked_in_by||'', g.notiz||''
  ]);
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob(['\ufeff'+csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `GDSF_${(ev?.name||'Export').replace(/\s/g,'_')}.csv`;
  a.click();
}

// Setzt NUR die Check-ins zurück, die vor dem eigentlichen Festival-Start liegen
// (also alles, was aktuell im "Test"-Tab im Dashboard gezählt wird). Echte
// Check-ins vom 28./29. bleiben unangetastet.
async function resetTestCheckins() {
  const sorted = events.slice().sort((a,b) => (a.event_date||'').localeCompare(b.event_date||''));
  if (sorted.length < 2) {
    toast('Es gibt kein zweites (echtes) Event zum Vergleich — bitte "Alle Check-ins zurücksetzen" verwenden.', 'error');
    return;
  }
  const cutoff = sorted[1].event_date; // Datum des ersten "echten" Festival-Tages
  if (!confirm('Alle Check-ins VOR dem ' + sorted[1].name + ' zurücksetzen? (Test-Check-ins)')) return;
  try {
    const toReset = allGuests.filter(g => g.checked_in && g.checked_in_at && localDateStr_(g.checked_in_at) < cutoff);
    if (toReset.length === 0) { toast('Keine Test-Check-ins gefunden.'); return; }
    for (const g of toReset) {
      await patch('guests?id=eq.' + g.id, { checked_in: false, checked_in_at: null, checked_in_by: null });
    }
    toast('✓ ' + toReset.length + ' Test-Check-ins zurückgesetzt');
    await loadGuests();
    loadAdminStats();
    if (typeof pushCheckinToSheets === 'function') {
      toReset.forEach(g => {
        pushCheckinToSheets({ vorname: g.vorname, nachname: g.nachname }, '', '', false).catch(() => {});
      });
    }
  } catch(e) {
    toast('Fehler beim Zurücksetzen: ' + e.message, 'error');
  }
}

async function resetCheckins() {
  if (!confirm('Wirklich ALLE Check-ins zurücksetzen (komplette Gästeliste, beide Tage)?')) return;
  try {
    // Vorher merken, wer eingecheckt war, um den Reset auch ins Sheet zu schreiben
    const previouslyChecked = allGuests.filter(g => g.checked_in);
    await patch('guests?checked_in=eq.true', { checked_in: false, checked_in_at: null, checked_in_by: null });
    toast('✓ ' + previouslyChecked.length + ' Check-ins zurückgesetzt');
    await loadGuests();
    loadAdminStats();
    if (typeof pushCheckinToSheets === 'function') {
      previouslyChecked.forEach(g => {
        pushCheckinToSheets({ vorname: g.vorname, nachname: g.nachname }, '', '', false).catch(() => {});
      });
    }
  } catch(e) {
    toast('Fehler beim Zurücksetzen: ' + e.message, 'error');
  }
}

// ── TAB SWITCHING ────────────────────────────
let dashboardTimer = null;
let dashboardEventId = null;

function switchTab(tab) {
  if (tab === 'admin' && (!currentUser || !currentUser.is_admin)) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const tabMap = { checkin: 0, dashboard: 1, admin: 2 };
  const allBtns = document.querySelectorAll('.tab-btn');
  if (allBtns[tabMap[tab]]) allBtns[tabMap[tab]].classList.add('active');
  document.getElementById('view-checkin').style.display = tab === 'checkin' ? 'flex' : 'none';
  document.getElementById('view-dashboard').style.display = tab === 'dashboard' ? 'flex' : 'none';
  const adminView = document.getElementById('view-admin');
  adminView.style.display = tab === 'admin' ? 'flex' : 'none';
  adminView.classList.toggle('active', tab === 'admin');
  if (tab === 'admin') {
    renderAdminEventPills();
    loadAdminStats();
    loadAccounts();
    renderEventsList();
    renderAdminGuestList();
    if (events.length > 0 && !addGuestEventId) addGuestEventId = events[0].id;
    if (dashboardTimer) clearInterval(dashboardTimer);
    dashboardTimer = setInterval(() => {
      if (document.getElementById('view-admin').classList.contains('active')) loadAdminStats();
    }, 15000);
  } else if (tab === 'dashboard') {
    renderDashboardEventPills();
    loadDashboardStats();
    if (dashboardTimer) clearInterval(dashboardTimer);
    dashboardTimer = setInterval(() => {
      if (document.getElementById('view-dashboard').style.display !== 'none') loadDashboardStats();
    }, 15000);
  } else {
    if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }
  }
}

function renderDashboardEventPills() {
  const c = document.getElementById('event-pills-dashboard');
  if (!c) return;
  if (events.length > 0 && !dashboardEventId) dashboardEventId = events[0].id;
  c.innerHTML = events.map(e =>
    `<div class="event-pill ${e.id===dashboardEventId?'active':''}" onclick="selectDashboardEvent('${e.id}')">${e.name}</div>`
  ).join('');
  const ev = events.find(e => e.id === dashboardEventId);
  document.getElementById('dash-event-label').textContent = ev ? ev.name : '–';
}

function selectDashboardEvent(id) {
  dashboardEventId = id;
  document.querySelectorAll('#event-pills-dashboard .event-pill').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('#event-pills-dashboard .event-pill').forEach(p => {
    if (p.getAttribute('onclick') && p.getAttribute('onclick').includes("'" + id + "'")) p.classList.add('active');
  });
  const ev = events.find(e => e.id === id);
  document.getElementById('dash-event-label').textContent = ev ? ev.name : '–';
  loadDashboardStats();
}

function localDateStr_(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function loadDashboardStats() {
  // events ist bereits chronologisch sortiert (loadEvents()). Das früheste Event
  // (z.B. ein "Test"-Tab vor dem eigentlichen Festival) sammelt ALLE Check-ins
  // bis einschließlich seinem Datum — spätere Tabs (28./29.) zählen nur exakt
  // an diesem einen Kalendertag.
  const idx = events.findIndex(e => e.id === dashboardEventId);
  const ev = idx >= 0 ? events[idx] : events[0];
  const isFirstEvent = idx <= 0;
  const dayDate = ev ? ev.event_date : null; // 'YYYY-MM-DD', Tag für den diese Statistik gilt
  try {
    // Globale Gästeliste — gilt für beide Tage, kein event_id-Filter mehr.
    const guests = await get(`guests?select=id,checked_in,vip,kategorie,checked_in_by,checked_in_at`) || [];
    const total = guests.length;
    const totalCheckedEver = guests.filter(g => g.checked_in).length;
    const pending = total - totalCheckedEver; // noch gar nicht eingecheckt, unabhängig vom Tag

    const checkedThisDay = dayDate ? guests.filter(g => {
      if (!g.checked_in) return false;
      const d = localDateStr_(g.checked_in_at);
      if (!d) return false;
      return isFirstEvent ? (d <= dayDate) : (d === dayDate);
    }) : [];
    const checked = checkedThisDay.length;
    const checkedNormal = checkedThisDay.filter(g => !g.vip).length; // "Eingecheckt"-Kachel: nur normale Gästeliste
    const vip = checkedThisDay.filter(g => g.vip).length;
    const pct = total > 0 ? Math.round(checked / total * 100) : 0;

    document.getElementById('d-total').textContent = total;
    document.getElementById('d-checked').textContent = checkedNormal;
    document.getElementById('d-vip').textContent = vip;
    document.getElementById('d-pending').textContent = pending;
    document.getElementById('d-pct').textContent = pct + '%';
    document.getElementById('d-progress').style.width = pct + '%';
    const circ = 2 * Math.PI * 35;
    const arc = (checked / (total || 1)) * circ;
    document.getElementById('d-donut-arc').setAttribute('stroke-dasharray', `${arc.toFixed(1)} ${circ.toFixed(1)}`);
    document.getElementById('d-donut-pct').textContent = pct + '%';
    const byEntrance = {};
    checkedThisDay.filter(g => g.checked_in_by).forEach(g => {
      byEntrance[g.checked_in_by] = (byEntrance[g.checked_in_by] || 0) + 1;
    });
    const entranceEl = document.getElementById('d-entrance-chart');
    const maxE = Math.max(...Object.values(byEntrance), 1);
    if (Object.keys(byEntrance).length === 0) {
      entranceEl.innerHTML = '<div style="color:var(--muted);font-size:0.75rem;text-align:center;padding:0.5rem">Noch keine Check-ins</div>';
    } else {
      entranceEl.innerHTML = Object.entries(byEntrance).sort((a,b) => b[1]-a[1]).map(([name, count]) => {
        const pctBar = Math.round(count/maxE*100);
        return `<div><div style="display:flex;justify-content:space-between;font-size:0.7rem;margin-bottom:0.2rem">
          <span style="color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%">${escHtml(name)}</span>
          <span style="color:var(--accent);font-weight:600">${count}</span></div>
          <div style="background:var(--border);border-radius:4px;height:5px">
            <div style="background:var(--accent);height:5px;border-radius:4px;width:${pctBar}%;transition:width 0.4s ease"></div>
          </div></div>`;
      }).join('');
    }
    // Kategorie-Übersicht: "total" bleibt global (ändert sich nicht pro Tag),
    // "checked" bezieht sich nur auf die Check-ins dieses Tages.
    const checkedIdsThisDay = new Set(checkedThisDay.map(g => g.id));
    const byCat = {};
    guests.forEach(g => {
      const cat = g.kategorie || 'Sonstige';
      if (!byCat[cat]) byCat[cat] = { total: 0, checked: 0 };
      byCat[cat].total++;
      if (checkedIdsThisDay.has(g.id)) byCat[cat].checked++;
    });
    document.getElementById('d-category-chart').innerHTML = Object.entries(byCat)
      .sort((a,b) => b[1].total - a[1].total).map(([cat, d]) => {
        const p = Math.round(d.checked/d.total*100);
        return `<div><div style="display:flex;justify-content:space-between;font-size:0.7rem;margin-bottom:0.2rem">
          <span style="color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%">${escHtml(cat)}</span>
          <span style="color:var(--muted)">${d.checked}/${d.total} <span style="color:var(--green)">${p}%</span></span></div>
          <div style="background:var(--border);border-radius:4px;height:5px">
            <div style="background:var(--green);height:5px;border-radius:4px;width:${p}%;transition:width 0.4s ease"></div>
          </div></div>`;
      }).join('');
    renderDashboardTimeline(checkedThisDay);
  } catch(e) { console.error('loadDashboardStats:', e); }
}

function renderDashboardTimeline(checkedGuests) {
  const svg = document.getElementById('d-timeline-chart');
  if (!svg) return;
  if (checkedGuests.length === 0) {
    svg.innerHTML = '<text x="50%" y="35" text-anchor="middle" font-family="DM Sans,sans-serif" font-size="11" fill="#6b6b80">Noch keine Check-ins</text>';
    return;
  }
  const buckets = {};
  checkedGuests.forEach(g => {
    const d = new Date(g.checked_in_at);
    const key = `${d.getHours()}:${d.getMinutes() < 30 ? '00' : '30'}`;
    buckets[key] = (buckets[key] || 0) + 1;
  });
  const keys = Object.keys(buckets).sort();
  const vals = keys.map(k => buckets[k]);
  const maxV = Math.max(...vals, 1);
  const W = 260, H = 50, pad = 4;
  const bw = Math.max(8, Math.floor((W - pad*(keys.length+1)) / keys.length));
  let bars = '';
  keys.forEach((k, i) => {
    const bh = Math.round((vals[i]/maxV) * (H-14));
    const x = pad + i*(bw+pad);
    const y = H - bh - 12;
    bars += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="2" fill="url(#dBarGrad)" opacity="0.9"/>`;
    if (i % 2 === 0 || keys.length <= 6) {
      bars += `<text x="${x+bw/2}" y="${H}" text-anchor="middle" font-family="DM Sans,sans-serif" font-size="8" fill="#6b6b80">${k}</text>`;
    }
    bars += `<text x="${x+bw/2}" y="${y-2}" text-anchor="middle" font-family="DM Sans,sans-serif" font-size="8" fill="var(--accent)" font-weight="bold">${vals[i]}</text>`;
  });
  svg.innerHTML = `<defs><linearGradient id="dBarGrad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#f0c040"/><stop offset="100%" stop-color="#e05a00"/>
  </linearGradient></defs>${bars}`;
}

// ── TOASTS ───────────────────────────────────
function toast(msg, type='') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── DRAG & DROP ──────────────────────────────
const dz = document.getElementById('drop-zone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragging'); });
dz.addEventListener('dragleave', () => dz.classList.remove('dragging'));
dz.addEventListener('drop', e => {
  e.preventDefault();
  dz.classList.remove('dragging');
  const file = e.dataTransfer.files[0];
  if (file) handleFileImport({target:{files:[file]}});
});

// ── CLOSE OVERLAYS ON BACKDROP ───────────────
document.getElementById('confirm-overlay').addEventListener('click', function(e) { if (e.target === this) closeConfirm(); });
document.getElementById('account-modal').addEventListener('click', function(e) { if (e.target === this) closeAccountModal(); });
document.getElementById('event-modal').addEventListener('click', function(e) { if (e.target === this) closeEventModal(); });
document.getElementById('ios-install-modal').addEventListener('click', function(e) { if (e.target === this) this.classList.remove('show'); });

// ── AUTO-LOGIN ───────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  // Logo → Home: touch + click für Mobile
  const logo = document.getElementById('logo-home-btn');
  if (logo) {
    function goHome(e) {
      e.preventDefault();
      if (currentUser) switchTab('checkin');
    }
    logo.addEventListener('click', goHome);
    logo.addEventListener('touchend', goHome, { passive: false });
  }

  // ── MAGIC LINK: Callback prüfen (URL-Hash mit access_token) ──
  const magicHandled = await handleMagicLinkCallback();
  if (magicHandled) return; // Magic Link hat übernommen

  // ── Session wiederherstellen oder Login zeigen ────────────────
  const saved = sessionStorage.getItem('gdsf_user');
  if (saved) { try { currentUser = JSON.parse(saved); showApp(); } catch(e) {} }

  // ── Magic Login Tab einblenden (immer sichtbar im Login-Screen) ──
  showMagicLoginTab();
});

// ── PWA INSTALL (BUG FIX: kein ipwhois durch start_url) ─────────────────────
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isInStandaloneMode = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
let pwaInstallPrompt = null;

function showPWAButtons(visible) {
  // Header install button — toggle visible class
  const hdr = document.getElementById('pwa-install-btn');
  if (hdr) {
    if (visible) hdr.classList.add('visible');
    else hdr.classList.remove('visible');
  }
  // Login banner
  const ban = document.getElementById('login-pwa-banner');
  if (ban) ban.style.display = visible ? 'block' : 'none';
  // Footer install button (oben, immer sichtbar)
  const ftw = document.getElementById('footer-install-wrap');
  if (ftw) ftw.style.display = visible ? 'block' : 'none';
  // Footer install link unter Kurzanleitung
  const fgi = document.getElementById('footer-guide-install');
  if (fgi) fgi.style.display = visible ? 'block' : 'none';
}

function toggleGuide() {
  const content = document.getElementById('guide-content');
  const arrow = document.getElementById('guide-arrow');
  if (!content) return;
  const open = content.style.display === 'flex';
  content.style.display = open ? 'none' : 'flex';
  content.style.flexDirection = 'column';
  if (arrow) arrow.style.transform = open ? '' : 'rotate(180deg)';
}

if (isIOS && !isInStandaloneMode) { showPWAButtons(true); }

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  pwaInstallPrompt = e;
  if (!isInStandaloneMode) { showPWAButtons(true); }
});
window.addEventListener('appinstalled', () => {
  showPWAButtons(false);
  pwaInstallPrompt = null;
});

function triggerPWAInstall() {
  if (isIOS) {
    document.getElementById('ios-install-modal').classList.add('show');
  } else if (pwaInstallPrompt) {
    pwaInstallPrompt.prompt();
    pwaInstallPrompt.userChoice.then(() => { pwaInstallPrompt = null; showPWAButtons(false); });
  }
}

// ════════════════════════════════════════════
// SERVICE WORKER – macht die App offline-fähig
// und auf Android/Chrome installierbar
// ════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(e =>
      console.warn('[SW] Registrierung fehlgeschlagen:', e.message)
    );
  });
}
