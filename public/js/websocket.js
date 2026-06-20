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

function currentBoundsToSend() {
  if (boundsRectState.frozen && boundsRectState.bounds) {
    // Freezing pins the actual subscription too, not just the outline —
    // otherwise the drawn rect (e.g. restored from the settings cookie)
    // would silently disagree with what's really subscribed on the server.
    return boundsRectState.bounds;
  }
  const b = map.getBounds();
  return [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]];
}

function sendBounds(ws) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const bounds = currentBoundsToSend();
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
// (pixelsPerMeter, speedDotZoomFactor), but markers don't repaint until
// they're explicitly redrawn — without this they'd stay at their pre-zoom
// pixel size for a moment after the map's zoom level (and thus everything
// else's scale) has already changed, looking visibly wrong. So: hide every
// marker the instant a zoom starts, redraw at zoomend (rather than waiting
// on the 500ms pan/zoom-settle debounce above, which exists to avoid
// spamming the server with bounds updates, not to delay the icons), then
// unhide shortly after — under smooth motion, refreshIcon doesn't touch the
// marker itself (the loop in smoothMotion.js owns it there); it only
// invalidates smoothIconHeading so that loop's next ~100ms tick redraws at
// the right size, so unhiding needs to wait for that tick too.
function onZoomStart() {
  for (const ship of ships.values()) {
    if (ship.onMap) ship.marker.setOpacity(0);
  }
}

function onZoomEnd() {
  for (const mmsi of ships.keys()) refreshIcon(mmsi);
  setTimeout(() => {
    for (const ship of ships.values()) ship.marker.setOpacity(1);
  }, 150);
}

function connect() {
  // Bounds are also embedded directly in the connection URL (not just sent
  // as a 'setBounds' message right after open) — so the server knows them
  // the instant the connection is established, with no round-trip delay.
  // Matters most right after a server restart: aisSocket reconnects to
  // aisstream.io and re-subscribes almost immediately, well before this
  // browser's reconnect (which waits out the close, then 3s) — without this,
  // that re-subscribe would briefly use whatever (or no) bounds the server
  // had before restarting, rather than what's actually on screen.
  const boundsParam = encodeURIComponent(JSON.stringify(currentBoundsToSend()));
  const ws = new WebSocket(`ws://${location.host}/ws?bounds=${boundsParam}`);
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
  map.on('zoomstart', onZoomStart);
  map.on('zoomend', onZoomEnd);
  connect();
}
