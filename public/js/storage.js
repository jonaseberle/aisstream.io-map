import { map } from './map.js';
import { ships, staticData, MAX_TRAIL_POINTS } from './state.js';
import { CATEGORIES, shipCategory } from './categories.js';
import { shipIcon } from './icons.js';
import { resolveHeading, cogBad, bestHeading } from './heading.js';
import { SPOOF_SPEED_KNOTS, haversineKnots } from './spoof.js';
import { applyVisibility, refreshTrail, isShipMoving, isShipFloating } from './visibility.js';
import { buildPopup } from './popup.js';

// ── localStorage persistence ──────────────────────────────────────────────
export const STORAGE_KEY_SHIPS  = 'ais_ships';
export const STORAGE_KEY_STATIC = 'ais_static';
export const STORAGE_KEY_META   = 'ais_saved_at';
const STORAGE_TTL_MS = 2 * 60 * 60 * 1000; // prune data older than 2 h on load

export const STORAGE_QUOTA_KB = 5 * 1024; // localStorage is typically limited to 5 MB
export const storageState = { note: null }; // null = clean save; string = what was dropped/trimmed

// Initial bearing from (lat1,lon1) to (lat2,lon2), in degrees clockwise from north.
function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function saveVesselData() {
  const shipIsMoving = (d) => isShipMoving(d.sog);
  let shipsToSave = ships;          // Map or filtered array of [mmsi, ship]
  let saveStatic  = true;
  let maxPoints   = MAX_TRAIL_POINTS;
  let step        = 0;              // eviction step reached

  for (;;) {
    try {
      const shipsObj = {};
      for (const [mmsi, ship] of shipsToSave) {
        const d = ship.data;
        shipsObj[mmsi] = {
          data: { ...d, lat: +d.lat.toFixed(4), lon: +d.lon.toFixed(4) },
          positions:  ship.positions.slice(-maxPoints).map(([la, lo]) => [+la.toFixed(4), +lo.toFixed(4)]),
          timestamps: ship.timestamps.slice(-maxPoints),
          spoofSuspected: ship.spoofSuspected || false,
          maxImpliedKnots: ship.maxImpliedKnots || 0,
        };
      }
      const staticObj = saveStatic ? Object.fromEntries(staticData) : {};
      localStorage.setItem(STORAGE_KEY_SHIPS,  LZString.compressToUTF16(JSON.stringify(shipsObj)));
      localStorage.setItem(STORAGE_KEY_STATIC, LZString.compressToUTF16(JSON.stringify(staticObj)));
      localStorage.setItem(STORAGE_KEY_META,   String(Date.now()));
      const parts = [];
      if (step >= 1) parts.push('dropped no-static vessels');
      if (step >= 2) parts.push('non-moving vessels');
      if (step >= 3) parts.push('static data');
      if (maxPoints < MAX_TRAIL_POINTS) parts.push(`trimmed to ${maxPoints} pts/ship`);
      storageState.note = parts.length ? parts.join(', ') : null;
      return;
    } catch (e) {
      if (e.name !== 'QuotaExceededError' && e.code !== 22) {
        console.warn('localStorage save failed:', e.message);
        storageState.note = 'save failed';
        return;
      }
      step++;
      if (step === 1) {
        shipsToSave = new Map([...ships].filter(([mmsi]) => staticData.has(mmsi)));
      } else if (step === 2) {
        shipsToSave = new Map([...ships].filter(([mmsi, ship]) => staticData.has(mmsi) && shipIsMoving(ship.data)));
      } else if (step === 3) {
        saveStatic = false;
      } else if (maxPoints >= 2) {
        maxPoints = Math.floor(maxPoints / 2);
      } else {
        console.warn('localStorage: cannot fit data even after full eviction');
        storageState.note = 'save failed';
        return;
      }
    }
  }
}

export function loadVesselData() {
  try {
    const savedAt = parseInt(localStorage.getItem(STORAGE_KEY_META) ?? '0', 10);
    if (!savedAt || Date.now() - savedAt > STORAGE_TTL_MS) return;
    const cutoff  = Date.now() - STORAGE_TTL_MS;

    const lzParse = (raw) => {
      if (!raw) return null;
      const dec = LZString.decompressFromUTF16(raw);
      return JSON.parse(dec ?? raw); // fall back to plain JSON if not compressed
    };

    const staticRaw = localStorage.getItem(STORAGE_KEY_STATIC);
    if (staticRaw) {
      for (const [mmsi, meta] of Object.entries(lzParse(staticRaw))) staticData.set(mmsi, meta);
    }

    const shipsRaw = localStorage.getItem(STORAGE_KEY_SHIPS);
    if (!shipsRaw) return;
    for (const [mmsi, saved] of Object.entries(lzParse(shipsRaw))) {
      // drop positions older than TTL
      const positions  = [];
      const timestamps = [];
      for (let i = 0; i < saved.timestamps.length; i++) {
        if (saved.timestamps[i] >= cutoff) { positions.push(saved.positions[i]); timestamps.push(saved.timestamps[i]); }
      }
      if (!positions.length) continue;

      const data  = saved.data;
      const sd    = staticData.get(mmsi);
      const cat   = shipCategory(sd?.typeCode);
      const color = CATEGORIES[cat].color;
      const spoofSuspected   = (saved.spoofSuspected ?? false) || data.sog > SPOOF_SPEED_KNOTS;
      const maxImpliedKnots  = Math.max(saved.maxImpliedKnots ?? 0, spoofSuspected ? (data.sog ?? 0) : 0);
      const trailColor = spoofSuspected ? '#ff4444' : CATEGORIES[shipCategory(sd?.typeCode)].color;
      const isFloating = isShipFloating(data.ts);
      const { heading, usingLastKnown } = resolveHeading(data.cog, data.hdg, data.declination, null);
      const dotAngle = !cogBad(data.cog) ? data.cog : heading;
      const trail  = L.polyline(positions, { color: trailColor, weight: 1.5, opacity: 0.6 });
      const marker = L.marker([data.lat, data.lon], { icon: shipIcon(heading, dotAngle, data.sog, sd?.typeCode, sd?.dim, isFloating) });
      marker.bindPopup('', { maxWidth: 300 });
      marker.on('click', (e) => { L.DomEvent.stopPropagation(e); marker.getPopup().setContent(buildPopup(mmsi)); marker.openPopup(); });
      // We don't persist per-point sog/cog/hdg/navStatus across reloads, only
      // lat/lon+ts — reuse the restored position trail for history (so smooth
      // motion still has real points to interpolate/lerp against, e.g. at a
      // 300s delta even though the ship hasn't sent anything for a while).
      // Approximate each older point's cog/sog from the bearing/distance to
      // the NEXT point (real movement, not just a copy of the latest report)
      // so the kinematic arc has real turns to follow instead of degrading
      // to a straight glide; the last point gets the real, reported values.
      // declination/navStatus aren't recoverable per-point, so those (and any
      // turn shape) are still approximations until live messages refine them.
      // headingReliable is always false for these synthesized points — a
      // bearing derived from position deltas is fine for animating motion,
      // but it isn't a real reported heading, so "Hide unreliable
      // heading/course" must not treat it as one.
      const history = positions.map((p, i) => {
        const isLast = i === positions.length - 1;
        if (isLast) {
          return { lat: p[0], lon: p[1], sog: data.sog, cog: data.cog, hdg: data.hdg, navStatus: data.navStatus, declination: data.declination, ts: timestamps[i], headingReliable: bestHeading(data.cog, data.hdg, data.declination) != null };
        }
        const next = positions[i + 1];
        const dtMs = timestamps[i + 1] - timestamps[i];
        const cog = bearingDeg(p[0], p[1], next[0], next[1]);
        const sog = dtMs > 0 ? haversineKnots(p[0], p[1], next[0], next[1], dtMs) : data.sog;
        return { lat: p[0], lon: p[1], sog, cog, hdg: cog, navStatus: data.navStatus, declination: data.declination, ts: timestamps[i], headingReliable: false };
      });
      const ship = {
        marker, trail, data, positions, timestamps, history, inBounds: map.getBounds().contains([data.lat, data.lon]),
        timedOut: false, spoofSuspected, maxImpliedKnots, isFloating,
        lastGoodHeading: heading, usingLastKnownHeading: usingLastKnown,
        onMap: false, trailOnMap: false,
      };
      ships.set(mmsi, ship);
      refreshTrail(ship);
      applyVisibility(mmsi);
    }
    console.log(`Restored ${ships.size} vessels from localStorage (saved ${Math.round((Date.now()-savedAt)/1000)}s ago)`);
  } catch (e) {
    console.warn('localStorage load failed:', e.message);
  }
}
