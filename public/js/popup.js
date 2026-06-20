import { ships, staticData, NAV_STATUS } from './state.js';
import { bestHeading, hdgBad, cogBad } from './heading.js';
import { SPOOF_SPEED_KNOTS } from './spoof.js';
import { filterState, navStatusUnreliable } from './visibility.js';
import { shipFixGaps } from './smoothMotion.js';
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
  const d = ship.data;
  const sd = staticData.get(mmsi);
  console.log(`popup mmsi=${mmsi}`, { shipData: d, staticData: sd });
  const name = sd?.name || d.name || '—';
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
    ${row('MMSI', d.mmsi)}
    ${sd?.imo     ? row('IMO',         String(sd.imo))        : ''}
    ${sd?.callSign ? row('Call sign',   sd.callSign)           : ''}
    ${row('Type', typeStr)}
    ${dimStr      ? row('Length × beam', dimStr)              : ''}
    ${draughtStr  ? row('Draught',       draughtStr)           : ''}
    ${sd?.destination ? row('Destination', sd.destination)    : ''}
    ${row('Speed',      `${d.sog ?? '—'} kn`)}
    ${(()=>{
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
    ${row('Nav status', `${d.navStatus} (${navLabel})${navUnreliable ? ' ' + warn('⚠ unreliable (sog ≥ 0.5kn)') : ''}`)}
    ${row('Position (middle)', `lat=${d.lat.toFixed(5)} lon=${d.lon.toFixed(5)}${ship.isFloating ? ' ' + warn('(floating)') : ''}`)}
    ${(()=>{
      // The GPS antenna fix itself isn't stored (only the hull's middle is —
      // see updateShip in messages.js) — recovered here on demand, only
      // while the setting is on and there's a dim-derived offset to undo.
      if (!filterState.showAntenna || !dim) return '';
      const heading = bestHeading(d.cog, d.hdg, d.declination);
      const [aLat, aLon] = gpsAntennaPosition(d.lat, d.lon, heading, dim);
      return row('GPS antenna', `lat=${aLat.toFixed(5)} lon=${aLon.toFixed(5)}`);
    })()}
    ${row('Trail', `${ship.positions.length} pts stored / ${filterState.trailSec}s window`)}
    ${ship.spoofSuspected ? row('⚠ Spoofing?', warn(`speed ${Math.round(ship.maxImpliedKnots)} kts (implied or reported, threshold ${SPOOF_SPEED_KNOTS} kts)`)) : ''}
    <div class="popup-fixgaps"><span class="popup-label">Fix intervals</span><br>${shipFixGaps(d.mmsi)}</div>
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
