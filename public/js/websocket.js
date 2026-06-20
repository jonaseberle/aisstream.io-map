import { map, updateHash } from './map.js';
import { ships } from './state.js';
import { applyVisibility } from './visibility.js';
import { refreshIcon, queueMessage } from './messages.js';
import { incrementMsgCount } from './stats.js';
import { saveSettings } from './settings.js';

// Looked up lazily (not cached at module load) — #status-dot/#status-text
// are built by legend.js, and a pre-existing circular import (settings.js
// <-> websocket.js) means this module's top-level code can run before that
// DOM exists; caching `null` here would silently break the indicator forever.
function setStatus(className, text) {
  const dot = document.getElementById('status-dot');
  const textEl = document.getElementById('status-text');
  if (dot) dot.className = className;
  if (textEl) textEl.textContent = text;
}
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
    checkbox.addEventListener('change', (e) => { boundsRectState.frozen = e.target.checked; saveSettings(); });
  }
  // Show whatever bounding box was last known (e.g. restored from the
  // settings cookie) right away — don't wait for the websocket to connect
  // and send a live one, which freezing would then block forever anyway.
  if (boundsRectState.bounds) drawBoundsRect(boundsRectState.bounds);
}

function updateBoundsVisibility() {
  const b = map.getBounds();
  for (const mmsi of ships.keys()) {
    const ship = ships.get(mmsi);
    ship.inBounds = b.contains([ship.data.lat, ship.data.lon]);
    applyVisibility(mmsi);
  }
}

let boundsTimer = null;
function onMapMove() {
  updateHash();
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    updateBoundsVisibility(); // live on-screen filtering — independent of the frozen subscription
    // While frozen, the subscription is deliberately pinned — panning/
    // zooming around to inspect it shouldn't re-send (or re-affirm) a
    // bounds update at all.
    if (!boundsRectState.frozen) sendBounds(activeWs);
  }, 500);
}

// Icon dimensions/speed-dot count/cog-line length are all zoom-dependent
// (pixelsPerMeter, speedDotZoomFactor) — redraw every icon the instant zoom
// actually settles, rather than waiting on the 500ms pan/zoom-settle debounce
// above (which exists to avoid spamming the server with bounds updates, not
// to delay the icons). Without this, the "each dot = N knots" legend hint
// (which recomputes every second, unconditionally) could say one scale while
// the icons still visibly showed the previous zoom's.
function onZoomEnd() {
  for (const mmsi of ships.keys()) refreshIcon(mmsi);
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  activeWs = ws;
  ws.onopen = () => { setStatus('connected', 'Connected'); sendBounds(ws); };
  ws.onmessage = (e) => {
    incrementMsgCount();
    // Parsing/applying is deferred to a periodic batch flush (see
    // messages.js's queueMessage/flushMessageQueue) — keeps this handler
    // itself cheap even during a burst of many messages back to back.
    queueMessage(e.data);
  };
  ws.onclose = () => { setStatus('error', 'Reconnecting…'); setTimeout(connect, 3000); };
  ws.onerror = () => { setStatus('error', 'Error'); };
}

export function initWebSocket() {
  initBoundsRectControls();
  map.on('moveend', onMapMove);
  map.on('zoomend', onMapMove);
  map.on('zoomend', onZoomEnd);
  connect();
}
