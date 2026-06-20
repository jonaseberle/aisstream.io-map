import { ships, staticData } from './state.js';
import { isFixInPanelRange, haversineNM, fmtNM } from './smoothMotion.js';

// Side panel listing a selected vessel's AIS fixes within the same
// time/onMap window the map's own fix circles use (isFixInPanelRange) —
// but always, regardless of the separate "Show AIS fixes" toggle, since
// this is a debugging aid for inspecting a vessel's raw fixes, not tied to
// whether the on-map circles happen to be switched on. Opened only via the
// "AIS Fixes ›" button inside the vessel popup (popup.js) — there's no
// standalone toggle for it.
let selectedMmsi = null;
let panelEl = null;
let headerEl = null;
let bodyEl = null;
let reopenTabEl = null;
// 'closed' — fully hidden, no trace on screen (initial state).
// 'open' — slid fully into view.
// 'minimized' — slid back out, leaving only reopenTabEl (a small fixed tab)
// visible, so the panel isn't blocking the map but is still one click away.
let state = 'closed';

function fmtDeg(v) {
  return v != null ? `${v.toFixed(1)}°` : '—';
}

function renderFixesPanel() {
  if (!bodyEl) return;
  const ship = selectedMmsi ? ships.get(selectedMmsi) : null;
  if (!ship) {
    headerEl.textContent = 'AIS Fixes';
    bodyEl.innerHTML = '<div class="fixes-empty">Click a vessel to inspect its fixes.</div>';
    return;
  }
  const sd = staticData.get(selectedMmsi);
  headerEl.textContent = `AIS Fixes — ${sd?.name || ship.data?.name || selectedMmsi}`;

  const visible = ship.history.filter((h) => isFixInPanelRange(ship, h.ts));
  if (!visible.length) {
    bodyEl.innerHTML = '<div class="fixes-empty">No fixes in range for this vessel right now.</div>';
    return;
  }
  let html = `<div class="fixes-header-row"><span>Time</span><span>SOG</span><span>COG</span><span>HDG</span><span>Decl.</span></div>`;
  for (let i = 0; i < visible.length; i++) {
    const f = visible[i];
    html += `<div class="fixes-row">
      <span>${new Date(f.ts).toLocaleTimeString()}</span>
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
// moment the vessel popup opens, so the panel (if open) already tracks
// whichever vessel was last clicked, without forcing it open.
export function setFixesPanelShip(mmsi) {
  selectedMmsi = mmsi;
  if (state === 'open') renderFixesPanel();
}

function setState(next) {
  state = next;
  panelEl.classList.toggle('open', state === 'open');
  reopenTabEl.classList.toggle('visible', state === 'minimized');
  if (state === 'open') renderFixesPanel();
}

// Used by the popup's own "AIS Fixes ›" button (popup.js) — selects that
// vessel AND opens the panel outright, unlike setFixesPanelShip above which
// only updates the selection if the panel already happens to be open.
export function openFixesPanel(mmsi) {
  selectedMmsi = mmsi;
  setState('open');
}

// Called periodically (main.js) so the list keeps up with the lead/trail
// window sliding forward and new fixes arriving, while the panel is open.
export function refreshFixesPanel() {
  if (state === 'open') renderFixesPanel();
}

export function initFixesPanel() {
  panelEl = document.createElement('div');
  panelEl.id = 'fixes-panel';
  panelEl.className = 'fixes-panel';
  panelEl.innerHTML = `
    <div class="fixes-panel-header">
      <span class="fixes-panel-title"></span>
      <button type="button" class="fixes-panel-min" title="Minimize">─</button>
      <button type="button" class="fixes-panel-close" title="Close">✕</button>
    </div>
    <div class="fixes-panel-body"></div>`;
  document.body.appendChild(panelEl);
  headerEl = panelEl.querySelector('.fixes-panel-title');
  bodyEl = panelEl.querySelector('.fixes-panel-body');
  headerEl.textContent = 'AIS Fixes';
  panelEl.querySelector('.fixes-panel-min').addEventListener('click', () => setState('minimized'));
  panelEl.querySelector('.fixes-panel-close').addEventListener('click', () => setState('closed'));

  reopenTabEl = document.createElement('button');
  reopenTabEl.type = 'button';
  reopenTabEl.id = 'fixes-panel-reopen';
  reopenTabEl.className = 'fixes-panel-reopen';
  reopenTabEl.textContent = 'AIS Fixes ‹';
  reopenTabEl.addEventListener('click', () => setState('open'));
  document.body.appendChild(reopenTabEl);

  // Delegated (rather than bound per-popup) since Leaflet rebuilds the
  // popup's DOM from the HTML string every time buildPopup() re-renders it —
  // a direct listener on the button would be thrown away with that DOM.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.popup-fixes-btn');
    if (btn) openFixesPanel(btn.dataset.mmsi);
  });
}
