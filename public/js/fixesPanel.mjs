import { map, wrapLatLngNearCenter } from './map.mjs';
import { ships, staticData } from './state.mjs';
import { currentFixTimestamps, buildFixPopup, pushTicks, smoothMotionState, targetTimestamp, findBracket } from './smoothMotion.mjs';
import { bestHeading, cogBad } from './heading.mjs';
import { haversineNM, fmtNM } from './geo.mjs';
import { buildPopup } from './popup.mjs';
import { registerTab, setTabVisible, openSidePanel } from './sidePanel.mjs';

// AIS Fixes tab in the shared side panel (sidePanel.mjs) — lists ALL of a
// selected vessel's stored AIS fixes, not bounded by the trail/lead sliders
// (as if no trail were set at all) and independent of the separate "Show
// AIS fixes" toggle, since this is a debugging aid for inspecting a
// vessel's raw fixes, not a reflection of what's drawn on the map. Shown
// regardless of whether the vessel itself currently passes the filters
// (ship.onMap) — a filtered-out vessel's history is just as inspectable;
// only the "Vessel popup ›" button below cares about onMap, since a marker
// that isn't on the map has nothing to pan to or pop open.
// Unlike Settings, this tab starts hidden and only appears (closable) once
// the "AIS Fixes ›" button inside a vessel popup (popup.mjs) is clicked.
let selectedMmsi = null;
let titleNameEl = null;
let titleShipBtn = null;
let bodyEl = null;
let tabShown = false;

// Which fix (if any) currently has its popup open on the map — tracked via a
// hidden marker baked into buildFixPopup's own HTML (smoothMotion.mjs)
// rather than wherever the popup happened to be opened from (an on-map
// circle/tick, or this panel's own row click), so it stays correct
// regardless of which path opened it.
let openFixMmsi = null;
let openFixTs = null;

function readFixMarker(popup) {
  const el = popup.getElement();
  const marker = el?.querySelector('.popup-fix-marker');
  return marker ? { mmsi: marker.dataset.mmsi, ts: Number(marker.dataset.ts) } : null;
}

map.on('popupopen', (e) => {
  const fix = readFixMarker(e.popup);
  openFixMmsi = fix?.mmsi ?? null;
  openFixTs = fix?.ts ?? null;
  if (tabShown) renderFixesPanel();
});
map.on('popupclose', (e) => {
  const fix = readFixMarker(e.popup);
  if (fix && fix.mmsi === openFixMmsi && fix.ts === openFixTs) {
    openFixMmsi = null;
    openFixTs = null;
    if (tabShown) renderFixesPanel();
  }
});

// Pans to the vessel and opens its regular popup (same content as clicking
// its marker directly) — lets this fly-in serve as a jump-back-to-the-map
// shortcut once you've drilled into a vessel's fixes. No-ops (the button is
// disabled in this case, see renderFixesPanel) when the marker isn't
// currently on the map — it has no on-screen position to pan to, and
// Leaflet can't open a popup on a layer that isn't added.
function showShipPopup(mmsi) {
  const ship = ships.get(mmsi);
  if (!ship || !ship.onMap) return;
  map.panTo(ship.marker.getLatLng());
  ship.marker.getPopup().setContent(buildPopup(mmsi));
  ship.marker.openPopup();
}

// Pans to one specific fix (clicked in the list below) and opens the same
// popup its on-map circle would (buildFixPopup, shared with smoothMotion.mjs).
function showFixPopup(mmsi, ts) {
  const ship = ships.get(mmsi);
  const f = ship?.history.find((h) => h.ts === ts);
  if (!f) return;
  const latlng = wrapLatLngNearCenter([f.lat, f.lon]);
  map.panTo(latlng);
  L.popup({ maxWidth: 360 }).setLatLng(latlng).setContent(buildFixPopup(mmsi, ts)).openOn(map);
}

// One circle per listed fix, kept on the map for as long as this fly-in is
// showing that vessel — a separate layer from the live trail's/smooth
// motion's own fix circles (ship.fixCircles, reconciled by smoothMotion.mjs)
// rather than reusing that shared state, since those are windowed to the
// trail/lead sliders and reconciled on their own fast loop/message ticks;
// sharing the same Map would mean this panel's "show ALL fixes" set and
// that windowed set fight over the same markers every tick.
//
// Keyed by ts and diffed (not cleared+recreated) on every render — this
// panel re-renders roughly every second (refreshFixesPanel) while shown, and
// recreating every circle on each tick would yank shut any popup the user
// just opened by clicking one directly on the map.
let fixMarkers = new Map();
// Hdg/Crs tick lines at each listed fix (pushTicks, shared with
// smoothMotion.mjs's trail/lead rendering) — ephemeral like there, so just
// cleared and fully rebuilt on every render rather than diffed like
// fixMarkers above; they carry no state worth preserving (no bound popup of
// their own — clicking one opens the same fix popup via the same
// openFixPopupAt path pushTicks already wires up).
let fixTickMarks = [];
function clearFixMarkers() {
  for (const m of fixMarkers.values()) m.remove();
  fixMarkers.clear();
  for (const m of fixTickMarks) m.remove();
  fixTickMarks = [];
}
function drawFixMarkers(ship, mmsi) {
  const color = ship.trail.options.color;
  const sd = staticData.get(mmsi);
  const lengthM = sd?.dim ? (sd.dim.A || 0) + (sd.dim.B || 0) : null;
  const liveTs = new Set(ship.history.map((f) => f.ts));
  for (const [ts, m] of fixMarkers) {
    if (!liveTs.has(ts)) { m.remove(); fixMarkers.delete(ts); }
  }
  for (const m of fixTickMarks) m.remove();
  fixTickMarks = [];
  for (const f of ship.history) {
    let m = fixMarkers.get(f.ts);
    if (!m) {
      m = L.circleMarker(wrapLatLngNearCenter([f.lat, f.lon]), {
        radius: 4, color, weight: 1.5, opacity: 0.7, fill: true, fillColor: color, fillOpacity: 0,
      }).addTo(map);
      m.bindPopup(() => buildFixPopup(mmsi, f.ts), { maxWidth: 360 });
      fixMarkers.set(f.ts, m);
    } else {
      m.setLatLng(wrapLatLngNearCenter([f.lat, f.lon]));
      m.setStyle({ color, fillColor: color });
    }
    const [lat, lon] = wrapLatLngNearCenter([f.lat, f.lon]);
    const wp = {
      ts: f.ts, lat, lon, sog: f.sog,
      heading: f.headingReliable ? bestHeading(f.courseTrue, f.headingTrue) : null,
      courseTrue: cogBad(f.courseTrue) ? null : f.courseTrue,
    };
    pushTicks(fixTickMarks, wp, lengthM, color, 0.9, mmsi);
  }
}

function fmtDeg(v) {
  return v != null ? `${v.toFixed(1)}°` : '—';
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// Z (UTC) time, not the browser's local timezone — every displayed time in
// this project is Z, so a fix here is directly comparable to one in the
// vessel popup or server debug.log without a mental timezone conversion.
function fmtTimeZ(ts) {
  return `${new Date(ts).toISOString().slice(11, 23)}Z`;
}

function renderFixesPanel() {
  if (!bodyEl) return;
  const ship = selectedMmsi ? ships.get(selectedMmsi) : null;
  if (!ship) {
    titleNameEl.textContent = '';
    titleShipBtn.style.display = 'none';
    bodyEl.innerHTML = '<div class="fixes-empty">Click a vessel to inspect its fixes.</div>';
    clearFixMarkers();
    return;
  }
  const sd = staticData.get(selectedMmsi);
  titleNameEl.textContent = sd?.name || ship.data?.name || selectedMmsi;
  titleShipBtn.style.display = '';
  titleShipBtn.disabled = !ship.onMap;
  titleShipBtn.textContent = ship.onMap ? 'Vessel popup ›' : '⚠ Vessel popup ›';
  titleShipBtn.title = ship.onMap ? '' : 'Vessel currently not visible on the map (filtered out, or no fix in range) — nothing to pan to or pop open';

  const visible = ship.history;
  if (!visible.length) {
    bodyEl.innerHTML = '<div class="fixes-empty">No fixes recorded yet.</div>';
    clearFixMarkers();
    return;
  }
  // Latest fix on top — intervals are still computed between chronologically
  // adjacent fixes (just walked back-to-front), so the time/distance values
  // themselves are unaffected by the display order.
  const currentTs = new Set(currentFixTimestamps(ship));
  drawFixMarkers(ship, selectedMmsi);
  let rowsHtml = '';
  for (let i = visible.length - 1; i >= 0; i--) {
    const f = visible[i];
    // Live mode: the single newest fix IS the current position. Smooth
    // motion: the two fixes bracketing the interpolated position both are.
    const isCurrent = currentTs.has(f.ts);
    const isOpen = openFixMmsi === selectedMmsi && openFixTs === f.ts;
    const warnMark = f.unreliableReason
      ? `<span class="fixes-warn" title="${escapeAttr(f.unreliableReason)}">⚠</span> `
      : '';
    rowsHtml += `<div class="fixes-fix${isCurrent ? ' fixes-fix-current' : ''}${isOpen ? ' fixes-fix-open' : ''}" data-ts="${f.ts}">
      <div class="fixes-row">
        <span>${warnMark}${fmtTimeZ(f.ts)}</span>
        <span>${f.sog != null ? f.sog.toFixed(1) : '—'}</span>
        <span>${fmtDeg(f.courseTrue)}</span>
        <span>${f.headingTrue === 511 ? '—' : fmtDeg(f.headingTrue)}</span>
      </div>
      <div class="fixes-pos">lat=${f.lat.toFixed(5)} lon=${f.lon.toFixed(5)}</div>
    </div>`;
    if (i > 0) {
      const prev = visible[i - 1];
      const dt = Math.round((f.ts - prev.ts) / 1000);
      const nm = haversineNM(prev.lat, prev.lon, f.lat, f.lon);
      rowsHtml += `<div class="fixes-interval">${dt} s / ${fmtNM(nm)} NM</div>`;
    }
  }
  bodyEl.innerHTML = `<div class="fixes-header-row"><span>Time</span><span>SOG (kn)</span><span>Crs (true)</span><span>Hdg (true)</span></div>
    <div class="fixes-timeline-wrap">
      <div class="fixes-timeline-track"><div class="fixes-timeline-line"></div><div class="fixes-timeline-dot"></div></div>
      <div class="fixes-rows">${rowsHtml}</div>
    </div>`;
  positionTimelineDot(ship);
}

// Vertical line + dot in the gutter beside the rows, marking where "now"
// (live mode) or the smooth-motion lagged instant (targetTimestamp) falls
// relative to the listed fixes — interpolated by actual measured row
// position (not list index) since row heights vary slightly (the interval
// dividers, the warning icon, the current/open highlight borders).
function positionTimelineDot(ship) {
  const wrap = bodyEl.querySelector('.fixes-timeline-wrap');
  const dot = bodyEl.querySelector('.fixes-timeline-dot');
  const history = ship.history;
  if (!wrap || !dot || !history.length) return;
  const targetTs = smoothMotionState.enabled ? targetTimestamp() : Date.now();
  const [li, ri] = findBracket(history, targetTs);
  const loEl = bodyEl.querySelector(`.fixes-fix[data-ts="${history[li].ts}"]`);
  const hiEl = bodyEl.querySelector(`.fixes-fix[data-ts="${history[ri].ts}"]`);
  if (!loEl || !hiEl) return;
  const wrapTop = wrap.getBoundingClientRect().top;
  const loY = loEl.getBoundingClientRect().top + loEl.offsetHeight / 2 - wrapTop;
  const hiY = hiEl.getBoundingClientRect().top + hiEl.offsetHeight / 2 - wrapTop;
  const span = history[ri].ts - history[li].ts;
  const frac = span > 0 ? Math.min(1, Math.max(0, (targetTs - history[li].ts) / span)) : 0;
  dot.style.top = `${loY + (hiY - loY) * frac}px`;
}

// Called from each marker's click handler (messages.mjs, storage.mjs) — same
// moment the vessel popup opens, so the tab (if currently shown) already
// tracks whichever vessel was last clicked, without forcing it open.
export function setFixesPanelShip(mmsi) {
  selectedMmsi = mmsi;
  if (tabShown) renderFixesPanel();
}

// Used by the popup's own "AIS Fixes ›" button (popup.mjs) — selects that
// vessel, reveals the (closable) tab if it was hidden, and switches the
// shared side panel to it outright. setFixesPanelShip above, by contrast,
// only updates the selection if the tab already happens to be visible.
export function openFixesPanel(mmsi) {
  selectedMmsi = mmsi;
  tabShown = true;
  setTabVisible('fixes', true);
  openSidePanel('fixes');
  renderFixesPanel();
}

// Called periodically (main.mjs) so the list keeps up with the lead/trail
// window sliding forward and new fixes arriving, while the tab is shown.
export function refreshFixesPanel() {
  if (tabShown) renderFixesPanel();
}

export function initFixesPanel() {
  bodyEl = document.createElement('div');
  bodyEl.className = 'fixes-panel-body';

  const wrapper = document.createElement('div');
  wrapper.className = 'fixes-panel';
  const titleRow = document.createElement('div');
  titleRow.className = 'fixes-panel-title';
  titleNameEl = document.createElement('span');
  titleNameEl.className = 'fixes-panel-title-name';
  titleShipBtn = document.createElement('button');
  titleShipBtn.type = 'button';
  titleShipBtn.className = 'fixes-panel-ship-btn';
  titleShipBtn.textContent = 'Vessel popup ›';
  titleShipBtn.style.display = 'none';
  titleShipBtn.addEventListener('click', () => { if (selectedMmsi) showShipPopup(selectedMmsi); });
  titleRow.appendChild(titleNameEl);
  titleRow.appendChild(titleShipBtn);
  wrapper.appendChild(titleRow);
  wrapper.appendChild(bodyEl);

  // onHide fires when the tab bar's own close button (or anything else)
  // hides this tab — flips tabShown off so refreshFixesPanel/
  // setFixesPanelShip stop re-rendering into a tab nobody can see.
  registerTab('fixes', 'AIS Fixes', wrapper, {
    closable: true,
    visible: false,
    onHide: () => { tabShown = false; clearFixMarkers(); },
  });

  // Delegated (rather than bound per-popup) since Leaflet rebuilds the
  // popup's DOM from the HTML string every time buildPopup() re-renders it —
  // a direct listener on the button would be thrown away with that DOM.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.popup-fixes-btn');
    if (btn) openFixesPanel(btn.dataset.mmsi);
  });

  // Attached directly to bodyEl (not document-delegated) — bodyEl itself is
  // never replaced, only its innerHTML, so a listener here survives every
  // re-render, same reasoning as the popup-fixes-btn delegation above just
  // scoped tighter since rows only ever live inside this one element.
  bodyEl.addEventListener('click', (e) => {
    const row = e.target.closest('.fixes-fix');
    if (row && selectedMmsi) showFixPopup(selectedMmsi, Number(row.dataset.ts));
  });
}
