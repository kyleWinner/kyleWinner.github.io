/* ══════════════════════════════════════════════════════
   BEE.NET — app.js
   Dependencies: none (vanilla JS, fetch API)
   External APIs used:
     postcodes.io   → postcode → lat/lon   (free, no key)
     Overpass API   → nearby bus stops     (free, no key)
     TransportAPI   → live departures      (free tier key)
══════════════════════════════════════════════════════ */

const APP_ID  = '2d9de197';
const APP_KEY = '62a9bae30dd15ebaf5ea0da18150ca44';

let lastLat   = null;
let lastLon   = null;
let autoTimer = null;


/* ── CLOCK ── */
function tick() {
  const t = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('clock').textContent    = t;
  document.getElementById('bb-clock').textContent = t;
}
tick();
setInterval(tick, 10000);


/* ── ENTER KEY on postcode input ── */
document.getElementById('postcode-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); searchPostcode(); }
});


/* ── STATUS HELPERS ── */
function setStatus(type, msg) {
  document.getElementById('led').className        = 'led ' + (type || '');
  document.getElementById('status-msg').textContent = msg;
  const short = msg.length > 18 ? msg.slice(0, 18) + '…' : msg;
  document.getElementById('bb-status').textContent = short;
  document.getElementById('bb-dot').className =
    'bb-dot' + (type === 'green' ? ' on' : '');
}

function showErr(msg) {
  const el = document.getElementById('err-box');
  el.textContent = msg;
  el.style.display = 'block';
  document.getElementById('scroll-area').scrollTop = 0;
  setTimeout(() => { el.style.display = 'none'; }, 8000);
}


/* ── GPS ── */
function useGPS() {
  const btn = document.getElementById('gps-btn');
  btn.classList.add('active');
  document.getElementById('postcode-input').value = '';
  clearAuto();
  setStatus('yellow', 'LOCATING...');
  renderSkeletons();

  if (!navigator.geolocation) {
    setStatus('red', 'GPS NOT SUPPORTED');
    btn.classList.remove('active');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    pos => {
      btn.classList.remove('active');
      lastLat = pos.coords.latitude;
      lastLon = pos.coords.longitude;
      fetchStops(lastLat, lastLon, 'GPS LOCATION');
      startAuto();
    },
    () => {
      btn.classList.remove('active');
      setStatus('red', 'LOCATION DENIED');
      showErr('Location access denied. Allow location access in your browser settings.');
    },
    { enableHighAccuracy: true, timeout: 12000 }
  );
}


/* ── POSTCODE SEARCH ── */
async function searchPostcode() {
  const raw = document.getElementById('postcode-input').value
    .trim().toUpperCase().replace(/\s+/g, '');

  if (!raw) { showErr('ENTER A POSTCODE FIRST'); return; }

  clearAuto();
  setStatus('yellow', 'LOOKING UP ' + raw + '...');
  renderSkeletons();

  try {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(raw)}`);
    const d = await r.json();
    if (!r.ok || d.status !== 200) throw new Error('POSTCODE NOT FOUND: ' + raw);
    lastLat = d.result.latitude;
    lastLon = d.result.longitude;
    fetchStops(lastLat, lastLon, raw);
    startAuto();
  } catch (e) {
    setStatus('red', 'POSTCODE ERROR');
    showErr(e.message || 'Could not look up that postcode.');
  }
}


/* ── AUTO-REFRESH ── */
function startAuto() {
  clearAuto();
  autoTimer = setInterval(() => {
    if (lastLat !== null) fetchStops(lastLat, lastLon);
  }, 60000);
}

function clearAuto() {
  clearInterval(autoTimer);
}


/* ── MANUAL REFRESH ── */
function doRefresh() {
  if (lastLat === null) {
    document.getElementById('postcode-input').focus();
    return;
  }
  fetchStops(lastLat, lastLon);
}


/* ── MAIN FETCH FLOW ── */
async function fetchStops(lat, lon, label) {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  document.getElementById('err-box').style.display = 'none';
  setStatus('yellow', label ? 'SCANNING ' + label + '...' : 'REFRESHING...');

  try {
    const stops = await nearbyStops(lat, lon);

    if (!stops.length) {
      setStatus('red', 'NO STOPS FOUND');
      document.getElementById('stops-container').innerHTML =
        '<div class="no-deps">NO BUS STOPS FOUND<br>WITHIN 800M</div>';
      return;
    }

    setStatus('yellow', 'FETCHING DEPARTURES...');
    const results = await Promise.all(stops.slice(0, 2).map(s => getDeps(s)));
    renderAll(results);
    setStatus('green', 'LIVE ✓');

  } catch (e) {
    console.error(e);
    setStatus('red', 'ERROR');
    showErr(e.message || 'Unexpected error. Try again.');
  } finally {
    btn.disabled = false;
  }
}


/* ── OVERPASS API: find nearby stops ── */
async function nearbyStops(lat, lon, radius = 800) {
  const query = `[out:json][timeout:15];node[highway=bus_stop](around:${radius},${lat},${lon});out body;`;

  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: query,
    headers: { 'Content-Type': 'text/plain' }
  });

  if (!r.ok) throw new Error('OVERPASS API UNREACHABLE');

  const d = await r.json();

  return (d.elements || [])
    .map(n => {
      const atco = n.tags?.['naptan:AtcoCode'] || n.tags?.['ref'];
      if (!atco || !/^\d{4}[A-Z]{2,3}\d+/.test(atco)) return null;
      return {
        atco,
        name: n.tags?.name || n.tags?.['naptan:CommonName'] || 'BUS STOP',
        lat:  n.lat,
        lon:  n.lon,
        dist: haversine(lat, lon, n.lat, n.lon)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.dist - b.dist);
}


/* ── TRANSPORTAPI: live departures for a stop ── */
async function getDeps(stop) {
  const url =
    `https://transportapi.com/v3/uk/bus/stop/${encodeURIComponent(stop.atco)}/live.json` +
    `?app_id=${APP_ID}&app_key=${APP_KEY}&group=no&nextbuses=no&limit=8`;

  const r = await fetch(url);

  if (r.status === 401 || r.status === 403)
    throw new Error('TRANSPORTAPI AUTH FAILED — CHECK API KEYS IN app.js');

  if (!r.ok) return { stop, deps: [] };

  const data = await r.json();
  const deps = [];

  if (data.departures) {
    for (const line of Object.keys(data.departures))
      for (const d of data.departures[line])
        deps.push({ ...d, line_name: line });
  }

  deps.sort((a, b) => minsAway(a) - minsAway(b));
  return { stop, deps: deps.slice(0, 7) };
}


/* ── RENDER: stop cards ── */
function renderAll(results) {
  const container = document.getElementById('stops-container');
  container.innerHTML = '';

  results.forEach(({ stop, deps }) => {
    const dist = stop.dist < 1000
      ? Math.round(stop.dist) + 'M'
      : (stop.dist / 1000).toFixed(1) + 'KM';

    const card = document.createElement('div');
    card.className = 'stop-win';
    card.innerHTML = `
      <div class="win-chrome">
        <div class="win-dots" aria-hidden="true">
          <div class="wd r"></div>
          <div class="wd y"></div>
          <div class="wd g"></div>
        </div>
        <div class="win-stop-name">${esc(stop.name.toUpperCase())}</div>
        <div class="win-dist">${dist}</div>
      </div>
      <div class="win-atco">
        <span class="atco-lbl">ATCO</span>
        <span class="atco-val">${esc(stop.atco)}</span>
      </div>
      ${renderDeps(deps)}
    `;
    container.appendChild(card);
  });

  document.getElementById('scroll-area').scrollTop = 0;
}


/* ── RENDER: departure rows ── */
function renderDeps(deps) {
  if (!deps.length) return '<div class="no-deps">[ NO DEPARTURES FOUND ]</div>';

  return deps.map(dep => {
    const route  = esc(dep.line_name || dep.line || '?');
    const dest   = esc((dep.direction || dep.direction_name || dep.destination_name || 'UNKNOWN').toUpperCase());
    const op     = esc((dep.operator_name || dep.operator || '').toUpperCase());
    const dm     = minsAway(dep);
    const isLive = dep.source === 'Realtime';
    const t      = dep.best_departure_estimate || dep.expected_departure_time || dep.aimed_departure_time || '--:--';

    let display  = t;
    let timeClass = '';
    let statusClass = 'sched';
    let statusLabel = 'SCHD';

    if (dm !== null) {
      if (dm <= 0) {
        display     = 'DUE';
        timeClass   = 'due';
        statusClass = 'due';
        statusLabel = 'DUE';
      } else if (dm < 60) {
        display = dm + ' MIN';
      }

      if (isLive && dm > 0) { statusClass = 'live'; statusLabel = 'LIVE'; }
      if (dm <= 1)          { statusClass = 'due';  statusLabel = 'DUE';  }
    }

    return `
      <div class="dep-row">
        <div class="dep-badge">${route}</div>
        <div class="dep-info">
          <div class="dep-dest">${dest}</div>
          ${op ? `<div class="dep-op">${op}</div>` : ''}
        </div>
        <div class="dep-right">
          <div class="dep-time ${timeClass}">${esc(display)}</div>
          <div class="dep-status ${statusClass}">${statusLabel}</div>
        </div>
      </div>
    `;
  }).join('');
}


/* ── RENDER: skeleton loading state ── */
function renderSkeletons() {
  const skRow = () => `
    <div class="sk-dep-row">
      <div class="sk" style="width:46px;height:30px;flex-shrink:0"></div>
      <div style="flex:1;min-width:0;padding:0 10px">
        <div class="sk" style="width:72%;height:18px;margin-bottom:5px"></div>
        <div class="sk" style="width:42%;height:11px"></div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex-shrink:0">
        <div class="sk" style="width:52px;height:22px"></div>
        <div class="sk" style="width:34px;height:11px"></div>
      </div>
    </div>`;

  document.getElementById('stops-container').innerHTML = [0, 1].map(() => `
    <div class="stop-win" style="margin-bottom:14px">
      <div class="win-chrome">
        <div class="win-dots" aria-hidden="true">
          <div class="wd r"></div><div class="wd y"></div><div class="wd g"></div>
        </div>
        <div class="sk" style="flex:1;height:8px;margin:0 8px"></div>
      </div>
      <div class="win-atco">
        <div class="sk" style="width:110px;height:10px"></div>
      </div>
      ${[0, 1, 2, 3, 4].map(skRow).join('')}
    </div>`).join('');
}


/* ── UTILITY: HTML-escape a string ── */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


/* ── UTILITY: Haversine distance in metres ── */
function haversine(la1, lo1, la2, lo2) {
  const R = 6371000;
  const r = Math.PI / 180;
  const a =
    Math.sin((la2 - la1) * r / 2) ** 2 +
    Math.cos(la1 * r) * Math.cos(la2 * r) *
    Math.sin((lo2 - lo1) * r / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


/* ── UTILITY: minutes until a HH:MM departure ── */
function minsAway(dep) {
  const s = dep.best_departure_estimate || dep.expected_departure_time || dep.aimed_departure_time;
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const now = new Date();
  let diff = (parseInt(m[1]) * 60 + parseInt(m[2])) -
             (now.getHours()  * 60 + now.getMinutes());
  if (diff < -720) diff += 1440; // handle midnight rollover
  return diff;
}