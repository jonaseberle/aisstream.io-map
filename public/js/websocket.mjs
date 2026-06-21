import { map, updateHash, wrapLatLngNearCenter } from './map.mjs';
import { ships } from './state.mjs';
import { applyVisibility } from './visibility.mjs';
import { refreshIcon, queueMessage } from './messages.mjs';
import { incrementMsgCount } from './stats.mjs';
import { saveSettings } from './settings.mjs';

// Looked up lazily (not cached at module load) — #status-dot/#status-text
// are built by legend.mjs, and a pre-existing circular import (settings.mjs
// <-> websocket.mjs) means this module's top-level code can run before that
// DOM exists; caching `null` here would silently break the indicator forever.
function setStatus(className, text) {
  const dot = document.getElementById('status-dot');
  const textEl = document.getElementById('status-text');
  if (dot) dot.className = className;
  if (textEl) textEl.textContent = text;
}
let activeWs = null;

// Areas the user has explicitly drawn on the map to subscribe to — each is
// a box [[s,w],[n,e]]. An empty list means "no restriction", i.e. subscribe
// to the whole world (same as what the server itself falls back to when no
// boxes are sent). Persisted via settings.mjs so the outlines can be redrawn
// immediately on page load, before the websocket even connects.
export const boundsRectState = { areas: [] };

let areaOutline = null; // single multi-line layer tracing the union of all areas (not one outline per area, so overlapping/adjacent areas don't show crisscrossing interior lines)

// Axis-aligned rectangles only, so their union's boundary is computable
// exactly by coordinate-compressing into a grid, marking which cells are
// covered by at least one box, then keeping only the cell edges that sit
// between a covered and an uncovered cell (or the outside) — those are
// exactly the segments of the union's outline. Adjacent same-direction
// edges are merged into single runs so the dash pattern doesn't restart at
// every grid line.
function unionOutlineSegments(areas) {
  if (areas.length === 0) return [];
  const xs = [...new Set(areas.flatMap(([[, w], [, e]]) => [w, e]))].sort((a, b) => a - b);
  const ys = [...new Set(areas.flatMap(([[s], [n]]) => [s, n]))].sort((a, b) => a - b);
  const nx = xs.length - 1, ny = ys.length - 1;
  if (nx <= 0 || ny <= 0) return [];

  const covered = Array.from({ length: ny }, () => new Array(nx).fill(false));
  for (const [[s, w], [n, e]] of areas) {
    for (let j = 0; j < ny; j++) {
      const cy = (ys[j] + ys[j + 1]) / 2;
      if (cy < s || cy > n) continue;
      for (let i = 0; i < nx; i++) {
        const cx = (xs[i] + xs[i + 1]) / 2;
        if (cx < w || cx > e) continue;
        covered[j][i] = true;
      }
    }
  }

  const segments = [];

  // Horizontal edges, one scan per grid line, merging contiguous runs along x.
  for (let j = 0; j <= ny; j++) {
    let runStart = null;
    for (let i = 0; i <= nx; i++) {
      const below = j > 0 && i < nx && covered[j - 1][i];
      const above = j < ny && i < nx && covered[j][i];
      if (i < nx && below !== above) {
        if (runStart === null) runStart = i;
      } else if (runStart !== null) {
        segments.push([[ys[j], xs[runStart]], [ys[j], xs[i]]]);
        runStart = null;
      }
    }
  }

  // Vertical edges, one scan per grid line, merging contiguous runs along y.
  for (let i = 0; i <= nx; i++) {
    let runStart = null;
    for (let j = 0; j <= ny; j++) {
      const left = i > 0 && j < ny && covered[j][i - 1];
      const right = i < nx && j < ny && covered[j][i];
      if (j < ny && left !== right) {
        if (runStart === null) runStart = j;
      } else if (runStart !== null) {
        segments.push([[ys[runStart], xs[i]], [ys[j], xs[i]]]);
        runStart = null;
      }
    }
  }

  return segments;
}

function redrawAreaRects() {
  if (areaOutline) { map.removeLayer(areaOutline); areaOutline = null; }
  const segments = unionOutlineSegments(boundsRectState.areas);
  if (segments.length > 0) {
    areaOutline = L.polyline(segments, {
      color: '#fbbf24', weight: 1.5, opacity: 0.8, dashArray: '6,4', interactive: false,
    }).addTo(map);
  }
  updateBoundsWarning();
}

function updateBoundsWarning() {
  const warn = document.getElementById('bounds-warning');
  if (warn) warn.style.display = boundsRectState.areas.length === 0 ? 'inline' : 'none';
}

function currentBoundsToSend() {
  return boundsRectState.areas.length > 0 ? boundsRectState.areas : null;
}

function sendBounds(ws) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'setBounds', bounds: currentBoundsToSend() }));
}

function areaAdded() {
  redrawAreaRects();
  sendBounds(activeWs);
  saveSettings();
}

// ── "+ Add area": drag a rectangle on the map ──────────────────────────────
let drawStart = null;
let drawPreviewRect = null;

function onDrawMouseDown(e) {
  drawStart = e.latlng;
  drawPreviewRect = L.rectangle([e.latlng, e.latlng], {
    color: '#fbbf24', weight: 1.5, dashArray: '4,3', fill: true, fillOpacity: 0.08, interactive: false,
  }).addTo(map);
  map.on('mousemove', onDrawMouseMove);
  map.on('mouseup', onDrawMouseUp);
}

function onDrawMouseMove(e) {
  if (drawPreviewRect) drawPreviewRect.setBounds([drawStart, e.latlng]);
}

function onDrawMouseUp(e) {
  const start = drawStart, end = e.latlng;
  cancelAddArea(); // tears down preview/listeners, but leaves start/end available below
  if (!start) return;
  const box = [
    [Math.min(start.lat, end.lat), Math.min(start.lng, end.lng)],
    [Math.max(start.lat, end.lat), Math.max(start.lng, end.lng)],
  ];
  // Ignore a plain click with no drag rather than adding a zero-size area.
  if (box[1][0] - box[0][0] > 1e-6 && box[1][1] - box[0][1] > 1e-6) {
    boundsRectState.areas.push(box);
    areaAdded();
  }
}

function setArmed(buttonId, armed) {
  const btn = document.getElementById(buttonId);
  if (btn) btn.classList.toggle('armed', armed);
}

function armAddArea() {
  cancelRemoveArea();
  setArmed('add-area-button', true);
  map.dragging.disable();
  map.getContainer().style.cursor = 'crosshair';
  map.on('mousedown', onDrawMouseDown);
}

function cancelAddArea() {
  map.off('mousedown', onDrawMouseDown);
  map.off('mousemove', onDrawMouseMove);
  map.off('mouseup', onDrawMouseUp);
  if (drawPreviewRect) { map.removeLayer(drawPreviewRect); drawPreviewRect = null; }
  map.dragging.enable();
  map.getContainer().style.cursor = '';
  drawStart = null;
  setArmed('add-area-button', false);
}

// ── "- Remove area": click inside an existing area to delete it ───────────
function areaIndexAt(latlng) {
  const { lat, lng } = latlng;
  const lon = normalizeLon(lng);
  return boundsRectState.areas.findIndex(([[s, w], [n, ee]]) => {
    if (lat < s || lat > n) return false;
    const west = normalizeLon(w), east = normalizeLon(ee);
    return west <= east ? (lon >= west && lon <= east) : (lon >= west || lon <= east);
  });
}

let removeHoverRect = null; // highlights whichever area the cursor is currently over, while remove mode is armed

function clearRemoveHover() {
  if (removeHoverRect) { map.removeLayer(removeHoverRect); removeHoverRect = null; }
}

function onRemoveHoverMove(e) {
  const idx = areaIndexAt(e.latlng);
  if (idx === -1) { clearRemoveHover(); return; }
  const [[s, w], [n, ee]] = boundsRectState.areas[idx];
  if (!removeHoverRect) {
    removeHoverRect = L.rectangle([[s, w], [n, ee]], {
      color: '#ef4444', weight: 2, opacity: 0.9, fill: true, fillColor: '#ef4444', fillOpacity: 0.15, interactive: false,
    }).addTo(map);
  } else {
    removeHoverRect.setBounds([[s, w], [n, ee]]);
  }
}

function onRemoveClick(e) {
  const idx = areaIndexAt(e.latlng);
  clearRemoveHover();
  if (idx === -1) return;
  boundsRectState.areas.splice(idx, 1);
  areaAdded();
}

function armRemoveArea() {
  cancelAddArea();
  setArmed('remove-area-button', true);
  map.getContainer().style.cursor = 'crosshair';
  map.on('mousemove', onRemoveHoverMove);
  map.on('click', onRemoveClick);
}

function cancelRemoveArea() {
  map.off('mousemove', onRemoveHoverMove);
  map.off('click', onRemoveClick);
  clearRemoveHover();
  map.getContainer().style.cursor = '';
  setArmed('remove-area-button', false);
}

function initBoundsAreaControls() {
  const addBtn = document.getElementById('add-area-button');
  if (addBtn) addBtn.addEventListener('click', () => {
    addBtn.classList.contains('armed') ? cancelAddArea() : armAddArea();
  });
  const removeBtn = document.getElementById('remove-area-button');
  if (removeBtn) removeBtn.addEventListener('click', () => {
    removeBtn.classList.contains('armed') ? cancelRemoveArea() : armRemoveArea();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { cancelAddArea(); cancelRemoveArea(); }
  });
  // Draw whatever areas were restored from the settings cookie right away —
  // don't wait for the websocket to connect.
  redrawAreaRects();
}

// Wraps to (-180, 180] — same reasoning as server.mjs's own copy: Leaflet's
// map.getBounds() doesn't wrap longitude, so a view panned across the
// antimeridian (±180°) has west/east outside the standard range (e.g.
// west=170, east=190), while AIS positions are always normalized. Without
// this, b.contains() below would wrongly hide ships near the antimeridian
// whenever the view straddles it.
function normalizeLon(lon) {
  return ((lon + 540) % 360) - 180;
}

function updateBoundsVisibility() {
  const b = map.getBounds();
  const south = b.getSouth(), north = b.getNorth();
  const west = normalizeLon(b.getWest()), east = normalizeLon(b.getEast());
  for (const mmsi of ships.keys()) {
    const ship = ships.get(mmsi);
    const { lat, lon } = ship.data;
    const lonOk = west <= east ? (lon >= west && lon <= east) : (lon >= west || lon <= east);
    ship.inBounds = lat >= south && lat <= north && lonOk;
    applyVisibility(mmsi);
  }
}

// Markers only get re-shifted into whichever world-copy is on screen (see
// wrapLatLngNearCenter/map.mjs) when their own position is recomputed —
// which, in live mode, only happens when a new message actually arrives
// for that ship. Panning far enough to cross into a different copy without
// new data for some ship would otherwise leave its marker stuck wherever
// it last rendered, so re-apply the shift for every ship once the
// pan/zoom settles (same debounce as the bounds update below — this is
// just as cheap, and just as fine to defer to gesture-end).
function rewrapAllMarkers() {
  for (const ship of ships.values()) {
    if (ship.onMap) ship.marker.setLatLng(wrapLatLngNearCenter(ship.middle));
  }
}

let boundsTimer = null;
function onMapMove() {
  updateHash();
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    rewrapAllMarkers();
    updateBoundsVisibility(); // live on-screen filtering — independent of the drawn subscription areas
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
// marker itself (the loop in smoothMotion.mjs owns it there); it only
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
    // messages.mjs's queueMessage/flushMessageQueue) — keeps this handler
    // itself cheap even during a burst of many messages back to back.
    queueMessage(e.data);
  };
  ws.onclose = () => { setStatus('error', 'Reconnecting…'); setTimeout(connect, 3000); };
  ws.onerror = () => { setStatus('error', 'Error'); };
}

export function initWebSocket() {
  initBoundsAreaControls();
  map.on('moveend', onMapMove);
  map.on('zoomend', onMapMove);
  map.on('zoomstart', onZoomStart);
  map.on('zoomend', onZoomEnd);
  connect();
}
