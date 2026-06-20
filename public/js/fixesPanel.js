import { ships, staticData } from './state.js';
import { isFixInPanelRange, haversineNM, fmtNM } from './smoothMotion.js';
import { registerTab, setTabVisible, openSidePanel } from './sidePanel.js';

// AIS Fixes tab in the shared side panel (sidePanel.js) — lists ALL of a
// selected vessel's stored AIS fixes, not bounded by the trail/lead sliders
// (as if no trail were set at all) and independent of the separate "Show
// AIS fixes" toggle, since this is a debugging aid for inspecting a
// vessel's raw fixes, not a reflection of what's drawn on the map. Still
// requires the vessel itself be currently shown (isFixInPanelRange).
// Unlike Settings, this tab starts hidden and only appears (closable) once
// the "AIS Fixes ›" button inside a vessel popup (popup.js) is clicked.
let selectedMmsi = null;
let titleEl = null;
let bodyEl = null;
let tabShown = false;

function fmtDeg(v) {
  return v != null ? `${v.toFixed(1)}°` : '—';
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
    titleEl.textContent = '';
    bodyEl.innerHTML = '<div class="fixes-empty">Click a vessel to inspect its fixes.</div>';
    return;
  }
  const sd = staticData.get(selectedMmsi);
  titleEl.textContent = sd?.name || ship.data?.name || selectedMmsi;

  const visible = isFixInPanelRange(ship) ? ship.history : [];
  if (!visible.length) {
    bodyEl.innerHTML = '<div class="fixes-empty">Vessel isn’t currently shown on the map.</div>';
    return;
  }
  let html = `<div class="fixes-header-row"><span>Time</span><span>SOG</span><span>COG</span><span>HDG</span><span>Decl.</span></div>`;
  for (let i = 0; i < visible.length; i++) {
    const f = visible[i];
    html += `<div class="fixes-row">
      <span>${fmtTimeZ(f.ts)}</span>
      <span>${f.sog != null ? f.sog.toFixed(1) : '—'}</span>
      <span>${fmtDeg(f.cog)}</span>
      <span>${f.hdg === 511 ? '—' : fmtDeg(f.hdg)}</span>
      <span>${f.declination != null ? `${f.declination > 0 ? '+' : ''}${f.declination}°` : '—'}</span>
    </div>`;
    if (i < visible.length - 1) {
      const next = visible[i + 1];
      const dt = Math.round((next.ts - f.ts) / 1000);
      const nm = haversineNM(f.lat, f.lon, next.lat, next.lon);
      html += `<div class="fixes-interval">${dt} s / ${fmtNM(nm)} NM</div>`;
    }
  }
  bodyEl.innerHTML = html;
}

// Called from each marker's click handler (messages.js, storage.js) — same
// moment the vessel popup opens, so the tab (if currently shown) already
// tracks whichever vessel was last clicked, without forcing it open.
export function setFixesPanelShip(mmsi) {
  selectedMmsi = mmsi;
  if (tabShown) renderFixesPanel();
}

// Used by the popup's own "AIS Fixes ›" button (popup.js) — selects that
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

// Called periodically (main.js) so the list keeps up with the lead/trail
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
  wrapper.appendChild(titleRow);
  wrapper.appendChild(bodyEl);
  titleEl = titleRow;

  // onHide fires when the tab bar's own close button (or anything else)
  // hides this tab — flips tabShown off so refreshFixesPanel/
  // setFixesPanelShip stop re-rendering into a tab nobody can see.
  registerTab('fixes', 'AIS Fixes', wrapper, {
    closable: true,
    visible: false,
    onHide: () => { tabShown = false; },
  });

  // Delegated (rather than bound per-popup) since Leaflet rebuilds the
  // popup's DOM from the HTML string every time buildPopup() re-renders it —
  // a direct listener on the button would be thrown away with that DOM.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.popup-fixes-btn');
    if (btn) openFixesPanel(btn.dataset.mmsi);
  });
}
