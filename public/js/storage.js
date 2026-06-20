import { map } from './map.js';
import { ships, staticData, MAX_TRAIL_POINTS } from './state.js';
import { CATEGORIES, shipCategory } from './categories.js';
import { shipIcon } from './icons.js';
import { resolveHeading, cogBad } from './heading.js';
import { SPOOF_SPEED_KNOTS } from './spoof.js';
import { applyVisibility, refreshTrail, isShipMoving, isShipFloating } from './visibility.js';
import { buildPopup } from './popup.js';
import { flushMessageQueue } from './messages.js';

// ── localStorage persistence ──────────────────────────────────────────────
export const STORAGE_KEY_SHIPS  = 'ais_ships';
export const STORAGE_KEY_STATIC = 'ais_static';
export const STORAGE_KEY_META   = 'ais_saved_at';
const STORAGE_TTL_MS = 2 * 60 * 60 * 1000; // prune data older than 2 h on load

export const STORAGE_QUOTA_KB = 5 * 1024; // localStorage is typically limited to 5 MB
export const storageState = { note: null }; // null = clean save; string = what was dropped/trimmed

// Shows a note next to the connection status dot, so localStorage activity
// (otherwise silent) is visible — a distinct color while a save/load is
// actually in progress (`busy`), vs. the brief result flash afterwards
// (default = success, `error` = failed). Reverts to an idle "fix count"
// readout once the flash times out, rather than disappearing.
let flashTimer = null;
function setStorageIndicator(text, variant) {
  const el = document.getElementById('storage-indicator');
  if (!el) return;
  el.textContent = `Storage: ${text}`;
  el.classList.remove('busy', 'error');
  if (variant) el.classList.add(variant);
  el.classList.add('visible');
}
function flashStorageIndicator(text, variant) {
  setStorageIndicator(text, variant);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(showIdleStorageIndicator, 10000);
}
// Total AIS fixes currently held in memory (sum of each ship's trail) — what
// the next save would persist — plus the actual on-disk size of the last
// save, shown while nothing's actively loading/saving.
function showIdleStorageIndicator() {
  let count = 0;
  for (const ship of ships.values()) count += ship.history.length;
  let sizeNote = '';
  try {
    const bytes = [STORAGE_KEY_SHIPS, STORAGE_KEY_STATIC, STORAGE_KEY_META]
      .reduce((sum, k) => sum + (localStorage.getItem(k)?.length ?? 0), 0);
    const usedKB = bytes / 1024;
    sizeNote = ` · ${usedKB.toFixed(1)} KB / ~5 MB (${(usedKB / STORAGE_QUOTA_KB * 100).toFixed(1)}%)`;
  } catch (_) {}
  setStorageIndicator(`🕐 ${count.toLocaleString()} fixes${sizeNote}`);
}

export function saveVesselData() {
  // Apply any messages still sitting in the batch queue first — otherwise a
  // save could persist stale ship state that's about to change the instant
  // the next periodic flush runs.
  flushMessageQueue();
  setStorageIndicator('💾 Saving…', 'busy');
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
          // The real per-point cog/sog/hdg/navStatus/declination — saved
          // verbatim so a reload doesn't need to fabricate them (see
          // loadVesselData). lat/lon here are already the hull's middle.
          history: ship.history.slice(-maxPoints).map((h) => ({
            lat: +h.lat.toFixed(4), lon: +h.lon.toFixed(4),
            sog: h.sog, cog: h.cog, hdg: h.hdg, navStatus: h.navStatus, declination: h.declination,
            ts: h.ts, headingReliable: h.headingReliable,
          })),
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
      flashStorageIndicator(storageState.note ? `✅ Saved (${storageState.note})` : '✅ Saved');
      return;
    } catch (e) {
      if (e.name !== 'QuotaExceededError' && e.code !== 22) {
        console.warn('localStorage save failed:', e.message);
        storageState.note = 'save failed';
        flashStorageIndicator('⚠️ Save failed', 'error');
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
        flashStorageIndicator('⚠️ Save failed', 'error');
        return;
      }
    }
  }
}

export function loadVesselData() {
  try {
    const savedAt = parseInt(localStorage.getItem(STORAGE_KEY_META) ?? '0', 10);
    if (!savedAt || Date.now() - savedAt > STORAGE_TTL_MS) { showIdleStorageIndicator(); return; }
    setStorageIndicator('📂 Loading…', 'busy');
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
    if (!shipsRaw) { flashStorageIndicator('🕐 Nothing to load'); return; }
    for (const [mmsi, saved] of Object.entries(lzParse(shipsRaw))) {
      // The real per-point cog/sog/hdg/navStatus/declination are persisted
      // verbatim (see saveVesselData) — no fabricating them from position
      // deltas. Older saves (before this) won't have `history` at all;
      // those vessels just don't restore, rather than restoring with made-up
      // kinematics.
      const history = (saved.history ?? []).filter((h) => h.ts >= cutoff);
      if (!history.length) continue;
      const positions  = history.map((h) => [h.lat, h.lon]);
      const timestamps = history.map((h) => h.ts);

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
      // data.lat/data.lon already IS the hull's middle — it was stored that
      // way (see updateShip in messages.js) before ever being saved here.
      const middle = [data.lat, data.lon];
      const marker = L.marker(middle, { icon: shipIcon(heading, dotAngle, data.sog, sd?.typeCode, sd?.dim, isFloating) });
      marker.bindPopup('', { maxWidth: 300 });
      marker.on('click', (e) => { L.DomEvent.stopPropagation(e); marker.getPopup().setContent(buildPopup(mmsi)); marker.openPopup(); });
      const ship = {
        marker, trail, data, positions, timestamps, history, inBounds: map.getBounds().contains([data.lat, data.lon]),
        timedOut: false, spoofSuspected, maxImpliedKnots, isFloating,
        lastGoodHeading: heading, usingLastKnownHeading: usingLastKnown,
        middle,
        onMap: false, trailOnMap: false,
      };
      ships.set(mmsi, ship);
      refreshTrail(ship);
      applyVisibility(mmsi);
    }
    console.log(`Restored ${ships.size} vessels from localStorage (saved ${Math.round((Date.now()-savedAt)/1000)}s ago)`);
    flashStorageIndicator(`✅ Loaded ${ships.size} vessel${ships.size === 1 ? '' : 's'}`);
  } catch (e) {
    console.warn('localStorage load failed:', e.message);
    flashStorageIndicator('⚠️ Load failed', 'error');
  }
}
