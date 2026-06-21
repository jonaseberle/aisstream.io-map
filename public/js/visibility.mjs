import { map } from './map.mjs';
import { ships, staticData } from './state.mjs';
import { shipCategory } from './categories.mjs';
import { hdgBad, cogBad } from './heading.mjs';
import { smoothMotionState, historicalState, targetTimestamp, PAST_TRAIL_OPACITY, reconcileFixCircles, removeFixCircles } from './smoothMotion.mjs';
import { updateLabel } from './messages.mjs';

// ── Visibility state ─────────────────────────────────────────────────────
// Slider ceilings; at these values, the respective "max" filter is disabled.
export const MAX_AGE_SLIDER_MAX = 600;
export const MAX_LENGTH_SLIDER_MAX = 400;
export const MAX_INTERVAL_SLIDER_MAX = 1200;
export const FLOATING_DISPLAY_SLIDER_MAX = 1200;
export const MAX_TRAIL_SLIDER_SEC = 7200; // ceiling of the "Trail" slider — also used by messages.mjs's pruneOldFixes
export const filterState = {
  trailSec: 600,
  leadSec: 300, // how far ahead to draw the smooth-motion lead line (smooth motion only)
  smoothMotionTension: 1.0, // damps the smooth-motion Hermite tangent (0=hugs the straight chord, 1=full dead-reckoning distance/most bulge) — see buildSegment in smoothMotion.mjs
  mapSource: 'dark', // see MAP_SOURCES in map.mjs
  messageFlushMs: 1000, // how often queued incoming AIS messages are parsed+rendered — see flushMessageQueue in messages.mjs
  maxStorageKB: 10240, // 0 = localStorage disabled entirely — see storage.mjs's checkUserStorageLimit/disableLocalStorage
  compressStorage: false, // LZString-compress the localStorage save — see storage.mjs's compressInWorker/saveVesselDataSync. Off by default: compression is real CPU work, and the unload-time save (saveVesselDataSync) can't offload it to a worker, so it's the main cause of the multi-second freeze-with-no-feedback on reload/close.
  minAgeSec: 0,
  maxAgeSec: 300,
  minLengthM: 0,
  maxLengthM: MAX_LENGTH_SLIDER_MAX, // disabled by default
  minIntervalSec: 0,
  maxIntervalSec: 300,
  floatingDisplaySec: 60, // how long to keep showing a ship after it goes floating
  filterHdg000: true,
  showFixes: false, // show the clickable AIS-fix circles (+ ticks in smooth mode)
  showMoving: true,
  showNonMoving: true,
  hideSpoofed: true,
  hideUnreliableNavStatus: false,
  showLabels: false,
  showAntenna: false,
  displayCollapsed: false,
  filtersCollapsed: false,
  shipTypesCollapsed: false,
  smoothMotionCollapsed: false,
  boundsCollapsed: false,
  debugCollapsed: false,
};
export const hiddenCategories = new Set(['unknown']);
export const hiddenTypes = new Set();

// navStatus codes that claim the vessel is stationary (at anchor/moored/aground).
const STATIONARY_NAV_STATUSES = [1, 5, 6];

// A reported navStatus of "at anchor"/"moored"/"aground" is unreliable (often
// stale) when sog says otherwise — trust the speed over the stale nav status.
export function navStatusUnreliable(sog, navStatus) {
  return (sog ?? 0) >= 0.5 && STATIONARY_NAV_STATUSES.includes(navStatus);
}

export function isShipMoving(sog) {
  return (sog ?? 0) >= 0.5;
}

// A vessel is "floating" (its marker shows a stale, unconfirmed position)
// once no position report has arrived for at least filterState.maxAgeSec,
// as of nowRef (defaults to real now; smooth motion evaluates this as of
// the simulated/historical instant instead). When the max-age filter is
// itself disabled (slider at ceiling), floating never triggers — "off"
// means no age-based behavior at all.
export function isShipFloating(ts, nowRef = Date.now()) {
  if (filterState.maxAgeSec >= MAX_AGE_SLIDER_MAX) return false;
  const ageSec = ts ? (nowRef - ts) / 1000 : 0;
  return ageSec >= filterState.maxAgeSec;
}

// Single source of truth for "is this ship currently floating", used both
// for live (real-clock-stale) and smooth-motion (ran-out-of-future-data)
// modes — callers should always use this instead of isShipFloating directly,
// so a stray message handler can't reset the flag using the wrong definition.
export function isFloatingNow(history, ts) {
  if (smoothMotionState.enabled) {
    if (!history || !history.length) return false;
    const snap = historicalState({ history }, targetTimestamp());
    return snap ? snap.overrunSec > 0 : false;
  }
  return isShipFloating(ts);
}

export function refreshTrail(ship) {
  const cutoff = Date.now() - filterState.trailSec * 1000;
  const pts = ship.positions.filter((_, i) => ship.timestamps[i] >= cutoff);
  ship.trail.setLatLngs(pts);

  // Clickable fix circle at each real position fix. While smooth motion is on,
  // the loop owns ship.fixCircles (drawn at the lagged instant from history),
  // so leave them alone here. In live mode draw them persistently (keyed by
  // report ts, so each popup survives message updates) — but only while the
  // trail is actually on the map.
  if (smoothMotionState.enabled) return;
  if (!ship.trailOnMap || !filterState.showFixes) { removeFixCircles(ship); return; }
  const trailColor = ship.trail.options.color;
  const fixSet = new Map();
  for (let i = 0; i < ship.positions.length; i++) {
    if (ship.timestamps[i] >= cutoff) {
      const [lat, lon] = ship.positions[i];
      fixSet.set(ship.timestamps[i], { lat, lon, opacity: PAST_TRAIL_OPACITY });
    }
  }
  reconcileFixCircles(ship, ship.data.mmsi, fixSet, trailColor);
}

// Single source of truth for whether a ship passes all active filters, so
// the map rendering (applyVisibility) and the header stats stay consistent.
export function isShipVisible(mmsi) {
  const ship = ships.get(mmsi);
  if (!ship) return false;
  const sd = staticData.get(mmsi);
  const cat = shipCategory(sd?.typeCode);
  const typeCode  = sd?.typeCode;
  // Ships without static dimension data yet pass through unfiltered by length.
  const lengthM   = sd?.dim ? (sd.dim.A || 0) + (sd.dim.B || 0) : null;

  // With smooth motion on, every filter below is evaluated against the
  // vessel's state DELTA seconds ago (the same instant being displayed),
  // not its live state — "now" for filtering purposes becomes targetTs.
  let d = ship.data;
  let intervalSec = null;
  let nowRef = Date.now();
  let floating, floatingMetric; // floatingMetric: seconds spent floating, vs. filterState.floatingDisplaySec
  if (smoothMotionState.enabled) {
    const targetTs = targetTimestamp();
    const snap = historicalState(ship, targetTs, lengthM);
    if (snap) {
      d = snap.data;
      intervalSec = snap.intervalSec;
      nowRef = targetTs;
      // No real report left to lerp towards — ran out of future data rather
      // than the position simply being old. Floats just like a live ship
      // that's stopped reporting, for the same floatingDisplaySec grace period.
      floating = snap.overrunSec > 0;
      floatingMetric = snap.overrunSec;
    }
  }
  if (floating === undefined) {
    floating = isShipFloating(d.ts, nowRef);
    floatingMetric = (d.ts ? (nowRef - d.ts) / 1000 : 0) - filterState.maxAgeSec;
  }

  const noHeading = hdgBad(d.hdg) && cogBad(d.cog);
  const ageSec    = d.ts ? (nowRef - d.ts) / 1000 : 0;
  // Once floating, stay visible (faded, with the "!" mark) for floatingDisplaySec
  // more seconds before actually being hidden. At the slider ceiling, never hide.
  const floatingExpired = floating && filterState.floatingDisplaySec < FLOATING_DISPLAY_SLIDER_MAX
    && floatingMetric > filterState.floatingDisplaySec;
  const ageOk     = ageSec >= filterState.minAgeSec && !floatingExpired;
  const isMoving  = isShipMoving(d.sog);
  const lengthOk  = lengthM == null || (lengthM >= filterState.minLengthM
    && (filterState.maxLengthM >= MAX_LENGTH_SLIDER_MAX || lengthM <= filterState.maxLengthM));
  // Same gap-between-last-2-reports metric as the "Update interval" stat (the
  // gap as of targetTs from historicalState, with smooth motion on). Only
  // active while smooth motion is on — in live mode there's no meaningful
  // "instant" to measure the gap against (a ship would just vanish the
  // moment it reports), and only applies to moving ships; non-moving and
  // fewer-than-2-report ships always pass through unfiltered.
  let intervalOk = true;
  if (smoothMotionState.enabled) {
    if (intervalSec === null) {
      const ts = ship.timestamps;
      intervalSec = ts.length >= 2 ? (ts[ts.length - 1] - ts[ts.length - 2]) / 1000 : null;
    }
    intervalOk = !isMoving || intervalSec == null
      || ((intervalSec >= filterState.minIntervalSec)
        && (filterState.maxIntervalSec >= MAX_INTERVAL_SLIDER_MAX || intervalSec <= filterState.maxIntervalSec));
  }
  const movingOk = isMoving ? filterState.showMoving : filterState.showNonMoving;
  const navUnreliable = navStatusUnreliable(d.sog, d.navStatus);
  return ageOk && lengthOk && intervalOk && movingOk && !hiddenCategories.has(cat) && !(typeCode != null && hiddenTypes.has(typeCode)) && !(filterState.filterHdg000 && noHeading) && !(filterState.hideSpoofed && ship.spoofSuspected) && !(filterState.hideUnreliableNavStatus && navUnreliable);
}

export function applyVisibility(mmsi) {
  const ship = ships.get(mmsi);
  if (!ship) return;
  const visible = isShipVisible(mmsi);

  if (visible && !ship.onMap)      { ship.marker.addTo(map); ship.onMap = true; }
  if (!visible && ship.onMap)      { ship.marker.remove();   ship.onMap = false; }
  updateLabel(mmsi);

  // While smooth motion is on, the straight-segment trail is replaced by the
  // smooth (kinematic) past line drawn in the smooth-motion loop — hide it.
  const trailVisible = visible && filterState.trailSec > 0 && !smoothMotionState.enabled;
  if (trailVisible && !ship.trailOnMap)  { ship.trail.addTo(map); ship.trailOnMap = true; refreshTrail(ship); }
  if (!trailVisible && ship.trailOnMap)  {
    ship.trail.remove(); ship.trailOnMap = false;
    // In smooth motion the loop owns the fix circles — don't yank them here.
    if (!smoothMotionState.enabled) removeFixCircles(ship);
  }
}
