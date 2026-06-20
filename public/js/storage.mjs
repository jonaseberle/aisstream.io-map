import { map } from './map.mjs';
import { ships, staticData, MAX_TRAIL_POINTS } from './state.mjs';
import { CATEGORIES, shipCategory } from './categories.mjs';
import { shipIcon } from './icons.mjs';
import { resolveHeading, cogBad } from './heading.mjs';
import { SPOOF_SPEED_KNOTS } from './spoof.mjs';
import { applyVisibility, refreshTrail, isShipMoving, isShipFloating } from './visibility.mjs';
import { buildPopup } from './popup.mjs';
import { flushMessageQueue } from './messages.mjs';
import { setFixesPanelShip } from './fixesPanel.mjs';

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
// Vessel/fix counts (in-memory, what the next save would persist) plus the
// actual on-disk size of the last save — the full breakdown shown in the
// indicator's hover tooltip (storageDetailTitle), regardless of which short
// status text happens to be showing at the time.
function storageDetail() {
  const vesselCount = ships.size;
  let fixCount = 0;
  for (const ship of ships.values()) fixCount += ship.history.length;
  let usedKB = null, pct = null;
  try {
    const bytes = [STORAGE_KEY_SHIPS, STORAGE_KEY_STATIC, STORAGE_KEY_META]
      .reduce((sum, k) => sum + (localStorage.getItem(k)?.length ?? 0), 0);
    usedKB = bytes / 1024;
    pct = usedKB / STORAGE_QUOTA_KB * 100;
  } catch (_) {}
  return { vesselCount, fixCount, usedKB, pct };
}

function storageDetailTitle({ vesselCount, fixCount, usedKB, pct }) {
  const lines = [
    `Vessels: ${vesselCount.toLocaleString()}`,
    `AIS fixes: ${fixCount.toLocaleString()}`,
  ];
  if (usedKB != null) lines.push(`Size: ${usedKB.toFixed(1)} KB / ~5 MB (${pct.toFixed(1)}%)`);
  return lines.join('\n');
}

// One-line save outcome, meant for the unload banner (main.mjs) — reflects
// whatever saveVesselDataSync() just left in storageState.note, alongside
// the same vessel/fix/size breakdown as the hover tooltip above.
export function storageSummaryText() {
  const { vesselCount, fixCount, usedKB, pct } = storageDetail();
  if (storageState.note === 'save failed') return '⚠️ Save failed';
  const sizeNote = usedKB != null ? ` (${usedKB.toFixed(1)} KB / ${pct.toFixed(1)}%)` : '';
  const evictionNote = storageState.note ? ` — ${storageState.note}` : '';
  return `✅ Saved ${vesselCount.toLocaleString()} vessels, ${fixCount.toLocaleString()} fixes${sizeNote}${evictionNote}`;
}

let flashTimer = null;
function setStorageIndicator(text, variant) {
  const el = document.getElementById('storage-indicator');
  if (!el) return;
  el.textContent = `Storage: ${text}`;
  el.title = storageDetailTitle(storageDetail());
  el.classList.remove('busy', 'error');
  if (variant) el.classList.add(variant);
  el.classList.add('visible');
}
function flashStorageIndicator(text, variant) {
  setStorageIndicator(text, variant);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(showIdleStorageIndicator, 10000);
}
// Compact summary shown while nothing's actively loading/saving — the full
// breakdown (incl. vessel count) is in the hover tooltip set by
// setStorageIndicator above.
function showIdleStorageIndicator() {
  const { fixCount, usedKB, pct } = storageDetail();
  const sizeNote = usedKB != null ? ` · ${usedKB.toFixed(1)} KB / ~5 MB (${pct.toFixed(1)}%)` : '';
  setStorageIndicator(`🕐`);
}

// Progressively more aggressive eviction states tried on QuotaExceededError,
// shared by both the sync and worker-based save below — yields the
// {shipsToSave, saveStatic, maxPoints, step} to try next, ending the
// sequence once nothing more can be evicted.
function* evictionSteps() {
  const shipIsMoving = (d) => isShipMoving(d.sog);
  let shipsToSave = ships;          // Map or filtered array of [mmsi, ship]
  let saveStatic  = true;
  let maxPoints   = MAX_TRAIL_POINTS;
  let step        = 0;              // eviction step reached
  for (;;) {
    yield { shipsToSave, saveStatic, maxPoints, step };
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
      return; // nothing left to evict
    }
  }
}

// Plain-data snapshot for one eviction attempt — cheap (just copying/
// rounding numbers), unlike the JSON.stringify+compress step that follows
// it, which is the actual expensive part (see saveVesselData below).
function buildSavePayload(shipsToSave, saveStatic, maxPoints) {
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
        ts: h.ts, headingReliable: h.headingReliable, unreliableReason: h.unreliableReason ?? null,
      })),
      spoofSuspected: ship.spoofSuspected || false,
      maxImpliedKnots: ship.maxImpliedKnots || 0,
    };
  }
  const staticObj = saveStatic ? Object.fromEntries(staticData) : {};
  return { shipsObj, staticObj };
}

function isQuotaError(e) {
  return e.name === 'QuotaExceededError' || e.code === 22;
}

function commitSave(shipsStr, staticStr, step, maxPoints) {
  localStorage.setItem(STORAGE_KEY_SHIPS,  shipsStr);
  localStorage.setItem(STORAGE_KEY_STATIC, staticStr);
  localStorage.setItem(STORAGE_KEY_META,   String(Date.now()));
  const parts = [];
  if (step >= 1) parts.push('dropped no-static vessels');
  if (step >= 2) parts.push('non-moving vessels');
  if (step >= 3) parts.push('static data');
  if (maxPoints < MAX_TRAIL_POINTS) parts.push(`trimmed to ${maxPoints} pts/ship`);
  storageState.note = parts.length ? parts.join(', ') : null;
  flashStorageIndicator(storageState.note ? `✅ Saved (${storageState.note})` : '✅ Saved');
}

function reportSaveFailed(e) {
  if (e) console.warn('localStorage save failed:', e.message);
  else console.warn('localStorage: cannot fit data even after full eviction');
  storageState.note = 'save failed';
  flashStorageIndicator('⚠️ Save failed', 'error');
}

// ── Worker-backed save (default) ────────────────────────────────────────
// JSON.stringify + LZString-compressing a fleet's worth of ship history is
// the actual cause of the "UI hangs while saving" symptom — real CPU work
// on a string that can run into the hundreds of KB. localStorage itself has
// no async API, so the .setItem() write still happens here on the main
// thread, but by then the string is already built — that part is fast.
// Only the stringify+compress step is offloaded to storageWorker.mjs.
let worker = null;
let nextRequestId = 0;
function compressInWorker(shipsObj, staticObj) {
  if (!worker) worker = new Worker(new URL('./storageWorker.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const id = ++nextRequestId;
    const onMessage = (e) => {
      if (e.data.id !== id) return;
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      resolve(e.data);
    };
    const onError = (err) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      reject(err);
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ id, shipsObj, staticObj });
  });
}

// Guards against periodic ticks overlapping a still-in-flight save — there's
// no correctness need to run two at once, and the next tick 30s later will
// just pick up fresher data anyway.
let saveInFlight = false;

export async function saveVesselData() {
  if (saveInFlight) return;
  saveInFlight = true;
  try {
    // Apply any messages still sitting in the batch queue first — otherwise
    // a save could persist stale ship state that's about to change the
    // instant the next periodic flush runs.
    flushMessageQueue();
    setStorageIndicator('💾 Saving…', 'busy');
    for (const { shipsToSave, saveStatic, maxPoints, step } of evictionSteps()) {
      try {
        const { shipsObj, staticObj } = buildSavePayload(shipsToSave, saveStatic, maxPoints);
        const { shipsStr, staticStr } = await compressInWorker(shipsObj, staticObj);
        commitSave(shipsStr, staticStr, step, maxPoints);
        return;
      } catch (e) {
        if (!isQuotaError(e)) { reportSaveFailed(e); return; }
      }
    }
    reportSaveFailed(null);
  } finally {
    saveInFlight = false;
  }
}

// ── Synchronous save (unload-time only) ─────────────────────────────────
// Used where a save must actually complete before the page goes away
// (pagehide / visibilitychange→hidden) — the worker round-trip in
// saveVesselData() above is async, so it can't be relied on to finish in
// time there. A user is already navigating away at that point, so blocking
// briefly is the right tradeoff for not losing the last few seconds of data.
export function saveVesselDataSync() {
  flushMessageQueue();
  setStorageIndicator('💾 Saving…', 'busy');
  for (const { shipsToSave, saveStatic, maxPoints, step } of evictionSteps()) {
    try {
      const { shipsObj, staticObj } = buildSavePayload(shipsToSave, saveStatic, maxPoints);
      const shipsStr  = LZString.compressToUTF16(JSON.stringify(shipsObj));
      const staticStr = LZString.compressToUTF16(JSON.stringify(staticObj));
      commitSave(shipsStr, staticStr, step, maxPoints);
      return;
    } catch (e) {
      if (!isQuotaError(e)) { reportSaveFailed(e); return; }
    }
  }
  reportSaveFailed(null);
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
      // Reflects only the latest (most recently saved) fix, same as
      // messages.mjs computes it going forward — not an ever-growing max, so
      // a vessel doesn't stay flagged across reloads just because it once
      // had one bad fix.
      const spoofSuspected  = saved.spoofSuspected ?? (data.sog > SPOOF_SPEED_KNOTS);
      const maxImpliedKnots = spoofSuspected ? (saved.maxImpliedKnots ?? data.sog ?? 0) : 0;
      const trailColor = spoofSuspected ? '#ff4444' : CATEGORIES[shipCategory(sd?.typeCode)].color;
      const isFloating = isShipFloating(data.ts);
      const { heading, usingLastKnown } = resolveHeading(data.cog, data.hdg, data.declination, null);
      const dotAngle = !cogBad(data.cog) ? data.cog : heading;
      const trail  = L.polyline(positions, { color: trailColor, weight: 1.5, opacity: 0.6 });
      // data.lat/data.lon already IS the hull's middle — it was stored that
      // way (see updateShip in messages.mjs) before ever being saved here.
      const middle = [data.lat, data.lon];
      const marker = L.marker(middle, { icon: shipIcon(heading, dotAngle, data.sog, sd?.typeCode, sd?.dim, isFloating) });
      marker.bindPopup('', { maxWidth: 300 });
      marker.on('click', (e) => { L.DomEvent.stopPropagation(e); marker.getPopup().setContent(buildPopup(mmsi)); marker.openPopup(); setFixesPanelShip(mmsi); });
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
    flashStorageIndicator(`✅ Loaded.`);
  } catch (e) {
    console.warn('localStorage load failed:', e.message);
    flashStorageIndicator('⚠️ Load failed', 'error');
  }
}
