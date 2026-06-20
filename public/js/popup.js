import { ships, staticData, NAV_STATUS } from './state.js';
import { bestHeading, hdgBad, cogBad } from './heading.js';
import { SPOOF_SPEED_KNOTS } from './spoof.js';
import { filterState, navStatusUnreliable } from './visibility.js';
import { smoothMotionState, historicalState, targetTimestamp } from './smoothMotion.js';
import { gpsAntennaPosition } from './geo.js';

function row(label, value) {
  return `<div class="popup-row"><span class="popup-label">${label}</span><span class="popup-value">${value}</span></div>`;
}
function warn(text) {
  return `<span class="popup-warn">${text}</span>`;
}

export function buildPopup(mmsi) {
  const ship = ships.get(mmsi);
  if (!ship) return '';
  const sd = staticData.get(mmsi);
  // Always shows whatever is actually being DISPLAYED right now, not
  // necessarily the literal latest AIS message — under smooth motion that's
  // the lagged/interpolated snapshot at the current delta (the same one
  // historicalState feeds the marker/icon each tick), so the popup is a
  // direct window into what a rendering bug would look like, rather than
  // always showing the (possibly very different) live data underneath it.
  // In live mode there's no lag to simulate, so this is just ship.data —
  // identical to before.
  const simulated = smoothMotionState.enabled;
  let d = ship.data;
  if (simulated) {
    const lengthM = sd?.dim ? (sd.dim.A || 0) + (sd.dim.B || 0) : null;
    const snap = historicalState(ship, targetTimestamp(), lengthM);
    if (snap) d = snap.data;
  }
  const simLabel = simulated ? ' [sim]' : '';
  const name = sd?.name || ship.data.name || '—';
  const navLabel = NAV_STATUS[d.navStatus] ?? 'Unknown';
  const navUnreliable = navStatusUnreliable(d.sog, d.navStatus);
  const typeStr = sd?.typeCode != null ? `type=${sd.typeCode} (${sd.typeLabel})` : '— (no static data yet)';

  // Dimensions: A=bow, B=stern, C=port, D=starboard (all from GPS antenna)
  const dim = sd?.dim;
  const length = dim ? (dim.A || 0) + (dim.B || 0) : 0;
  const beam   = dim ? (dim.C || 0) + (dim.D || 0) : 0;
  const dimStr = length ? `${length} × ${beam} m (A=${dim.A} B=${dim.B} C=${dim.C} D=${dim.D})` : null;
  const draughtStr = sd?.draught ? `${sd.draught} m` : null;

  return `
    <div class="popup-name">${name}</div>
    ${row('MMSI', `<a href="https://www.vesselfinder.com/vessels/details/${mmsi}" target="_blank" rel="noopener">${mmsi}</a>`)}
    ${sd?.imo     ? row('IMO',         String(sd.imo))        : ''}
    ${sd?.callSign ? row('Call sign',   sd.callSign)           : ''}
    ${row('Type', typeStr)}
    ${dimStr      ? row('Length × beam', dimStr)              : ''}
    ${draughtStr  ? row('Draught',       draughtStr)           : ''}
    ${sd?.destination ? row('Destination', sd.destination)    : ''}
    <div class="popup-sep"></div>
    ${row(`Speed${simLabel}`,      `${d.sog != null ? d.sog.toFixed(1) : '—'} kn`)}
    ${simulated ? (() => {
      // d.cog/d.hdg here are already the fully resolved course/heading the
      // smooth-motion loop computed (or null if genuinely unknown) — none
      // of live mode's raw-sentinel decoding (511, declination correction,
      // etc.) applies, since that resolution already happened upstream
      // (declination is already baked into hdg there, so it's not its own
      // row here the way it is in the raw/live branch below).
      const courseStr = d.cog != null ? `${d.cog.toFixed(1)}°` : '— (n/a)';
      const headingStr = d.hdg != null ? `${d.hdg.toFixed(1)}°` : '— (n/a)';
      return row(`Course${simLabel}`, courseStr) + row(`Heading (true)${simLabel}`, headingStr);
    })() : (()=>{
      const bh = bestHeading(d.cog, d.hdg, d.declination);
      const usesHdg = bh != null && !hdgBad(d.hdg);
      const usesCog = bh != null && hdgBad(d.hdg) && !cogBad(d.cog);
      const cogStr = cogBad(d.cog) ? `${d.cog != null ? d.cog.toFixed(1) : '—'} (n/a)` : `${d.cog.toFixed(1)}°${usesCog ? ' ← rotation' : ''}`;
      const hdgVal = d.hdg === 511 ? '0x1FF (n/a)' : (d.hdg === 0 || d.hdg === 360) ? `${d.hdg.toFixed(1)} (unreliable)` : d.hdg != null ? `${d.hdg.toFixed(1)}°` : '—';
      const decStr = d.declination != null ? `${d.declination > 0 ? '+' : ''}${d.declination}°` : '—';
      const corrected = usesHdg && d.declination != null
        ? ` → ${((d.hdg + d.declination + 360) % 360).toFixed(1)}° true` : '';
      const hdgStr = `${hdgVal}${corrected}${usesHdg ? ' ← rotation' : ''}`;
      const lastKnownNote = ship.usingLastKnownHeading ? ' (using last known heading)' : '';
      return row('AIS COG', cogStr)
        + row('AIS HDG', `${hdgStr}${lastKnownNote}`)
        + row('Mag. decl.', decStr);
    })()}
    ${row(`Nav status${simLabel}`, `${d.navStatus} (${navLabel})${navUnreliable ? ' ' + warn('⚠ unreliable (sog ≥ 0.5kn)') : ''}`)}
    ${row(`Position (middle)${simLabel}`, `lat=${d.lat.toFixed(5)} lon=${d.lon.toFixed(5)}${ship.isFloating ? ' ' + warn('(floating)') : ''}`)}
    ${(()=>{
      // The GPS antenna fix itself isn't stored (only the hull's middle is —
      // see updateShip in messages.js) — recovered here on demand, only
      // while the setting is on and there's a dim-derived offset to undo.
      if (!filterState.showAntenna || !dim) return '';
      const heading = simulated ? d.hdg : bestHeading(d.cog, d.hdg, d.declination);
      const [aLat, aLon] = gpsAntennaPosition(d.lat, d.lon, heading, dim);
      return row(`GPS antenna${simLabel}`, `lat=${aLat.toFixed(5)} lon=${aLon.toFixed(5)}`);
    })()}
    ${ship.spoofSuspected ? row('⚠ Spoofing?', warn(`speed ${Math.round(ship.maxImpliedKnots)} kts (implied or reported, threshold ${SPOOF_SPEED_KNOTS} kts)`)) : ''}
    <div class="popup-fixes-row"><button type="button" class="popup-fixes-btn" data-mmsi="${mmsi}">AIS Fixes ›</button></div>
  `;
}

// Re-renders a ship's popup content in place if it's currently open, so
// values (position, age, "Last reports", etc.) stay live without the user
// having to close and reopen it.
export function refreshPopupIfOpen(mmsi) {
  const ship = ships.get(mmsi);
  if (!ship || !ship.marker.isPopupOpen()) return;
  ship.marker.setPopupContent(buildPopup(mmsi));
}
