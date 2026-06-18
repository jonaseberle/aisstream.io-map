import { map, updateHash } from './map.js';
import { ships } from './state.js';
import { applyVisibility } from './visibility.js';
import { refreshIcon, updateShip } from './messages.js';
import { incrementMsgCount } from './stats.js';

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
let activeWs = null;

// Outline of the bounding box currently subscribed to on aisstream.io —
// drawn (and redrawn) every time we actually send a new one to the server,
// so it always reflects what the upstream subscription is using right now.
// Can be frozen via the checkbox below to inspect a past box without it
// jumping to the current view — the actual subscription keeps updating either way.
// `bounds` is kept here (and persisted via settings.js) so the outline can be
// redrawn immediately on page load, before the websocket even connects.
let boundsRect = null;
export const boundsRectState = { frozen: false, bounds: null };

function drawBoundsRect(bounds) {
  const [[s, w], [n, e]] = bounds;
  if (!boundsRect) {
    boundsRect = L.rectangle([[s, w], [n, e]], {
      color: '#fbbf24', weight: 1.5, opacity: 0.8, fill: false, dashArray: '6,4', interactive: false,
    }).addTo(map);
  } else {
    boundsRect.setBounds([[s, w], [n, e]]);
  }
}

function showSubscribedBounds(bounds) {
  if (boundsRectState.frozen) return; // don't move the outline, or overwrite the persisted snapshot, while frozen
  boundsRectState.bounds = bounds;
  drawBoundsRect(bounds);
}

function sendBounds(ws) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  let bounds;
  if (boundsRectState.frozen && boundsRectState.bounds) {
    // Freezing pins the actual subscription too, not just the outline —
    // otherwise the drawn rect (e.g. restored from the settings cookie)
    // would silently disagree with what's really subscribed on the server.
    bounds = boundsRectState.bounds;
  } else {
    const b = map.getBounds();
    bounds = [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]];
  }
  showSubscribedBounds(bounds);
  ws.send(JSON.stringify({ type: 'setBounds', bounds }));
}

function initBoundsRectControls() {
  const checkbox = document.getElementById('freeze-bounds-checkbox');
  if (checkbox) {
    // Reflect the (possibly cookie-restored) saved state onto the checkbox,
    // rather than reading the checkbox's static HTML default into state.
    checkbox.checked = boundsRectState.frozen;
    checkbox.addEventListener('change', (e) => { boundsRectState.frozen = e.target.checked; });
  }
  // Show whatever bounding box was last known (e.g. restored from the
  // settings cookie) right away — don't wait for the websocket to connect
  // and send a live one, which freezing would then block forever anyway.
  if (boundsRectState.bounds) drawBoundsRect(boundsRectState.bounds);
}

let lastZoom = map.getZoom();
function updateBoundsVisibility() {
  const b = map.getBounds();
  const zoomChanged = map.getZoom() !== lastZoom;
  lastZoom = map.getZoom();
  for (const mmsi of ships.keys()) {
    const ship = ships.get(mmsi);
    ship.inBounds = b.contains([ship.data.lat, ship.data.lon]);
    if (zoomChanged) refreshIcon(mmsi); // refreshIcon calls applyVisibility
    else applyVisibility(mmsi);
  }
}

let boundsTimer = null;
function onMapMove() {
  updateHash();
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => { updateBoundsVisibility(); sendBounds(activeWs); }, 500);
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  activeWs = ws;
  ws.onopen = () => { statusDot.className = 'connected'; statusText.textContent = 'Connected'; sendBounds(ws); };
  ws.onmessage = (e) => {
    incrementMsgCount();
    try { updateShip(JSON.parse(e.data)); }
    catch (err) { console.error('Parse error:', err, e.data?.slice(0, 200)); }
  };
  ws.onclose = () => { statusDot.className = 'error'; statusText.textContent = 'Reconnecting…'; setTimeout(connect, 3000); };
  ws.onerror = () => { statusDot.className = 'error'; statusText.textContent = 'Error'; };
}

export function initWebSocket() {
  initBoundsRectControls();
  map.on('moveend', onMapMove);
  map.on('zoomend', onMapMove);
  connect();
}
