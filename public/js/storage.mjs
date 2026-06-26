import { map, wrapLatLngNearCenter } from './map.mjs';
import { ships, staticData, MAX_TRAIL_POINTS } from './state.mjs';
import { CATEGORIES, shipCategory } from './categories.mjs';
import { shipIcon } from './icons.mjs';
import { resolveHeading, cogBad } from './heading.mjs';
import { SPOOF_SPEED_KNOTS } from './spoof.mjs';
import { applyVisibility, refreshTrail, isShipMoving, isShipFloating, filterState } from './visibility.mjs';
import { buildPopup } from './popup.mjs';
import { flushMessageQueue } from './messages.mjs';
import { setFixesPanelShip } from './fixesPanel.mjs';

// ── localStorage persistence ──────────────────────────────────────────────
export const STORAGE_KEY_SHIPS  = 'ais_ships';
export const STORAGE_KEY_STATIC = 'ais_static';
export const STORAGE_KEY_META   = 'ais_saved_at';
// Whether STORAGE_KEY_SHIPS/STATIC are LZString-compressed — its own key
// rather than a marker prefixed onto those values, so they stay exactly
// what compressToUTF16/JSON.stringify produced (easier to eyeball/copy out
// of devtools while debugging) instead of "valid JSON/LZString plus one
// stray leading character."
export const STORAGE_KEY_COMPRESSED = 'ais_compressed';
// Identifies the packed-array record schema (packFix/packShip/packStatic
// below) that STORAGE_KEY_SHIPS/STATIC were written with. Bump
// STORAGE_FORMAT_VERSION whenever that schema changes (a field added/
// removed/reordered) — loadVesselData refuses to unpack a mismatched
// version rather than feeding the wrong-shaped arrays into today's
// unpack functions, which would silently misread fields by position
// instead of failing loudly.
export const STORAGE_KEY_VERSION = 'ais_version';
export const STORAGE_FORMAT_VERSION = 3; // v3: dropped the unused declination field from packFix/packShip; renamed cog/hdg to courseTrue/headingTrue
const STORAGE_TTL_MS = 2 * 60 * 60 * 1000; // prune data older than 2 h on load

export const STORAGE_QUOTA_KB = 5 * 1024; // localStorage is typically limited to 5 MB
export const storageState = {
  note: null,          // null = clean save; string = what was dropped/trimmed
  evictedVessels: 0,   // vessels NOT included in the last successful save (dropped by eviction steps)
  evictedFixes: 0,      // fixes NOT included in the last successful save (vessels dropped entirely + per-ship trimming)
  usedKB: 0,            // size of the last successful save
  quotaFailKB: null,    // smallest size that still hit a REAL browser QuotaExceededError during the last save attempt (null = none — distinct from filterState.maxStorageKB's own, user-configured limit)
};

// Debug-group rows (legend.mjs) showing the fields above — null-guarded
// since that panel may currently be detached (a different side-panel tab
// active; see stats.mjs's setText for the same situation/reasoning).
function setDebugText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
function updateDebugStorageRows() {
  setDebugText('debug-evicted', `${storageState.evictedVessels} vessels, ${storageState.evictedFixes} fixes`);
  setDebugText('debug-storage-kb', `${storageState.usedKB.toFixed(1)} kB`);
  setDebugText('debug-quota-fail-kb', storageState.quotaFailKB != null ? `${storageState.quotaFailKB.toFixed(0)} kB` : '—');
}

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

// Wipes every vessel/fix the app currently knows about — both the live
// in-memory state (ships/staticData, plus every Leaflet layer a ship owns:
// marker, trail, label, smooth-motion lead/past lines+ticks, fix circles)
// and the persisted localStorage save. Used by the Debug "Clear localStorage"
// button — a fresh start, not just clearing what would be written on the
// next save.
export function clearVesselData() {
  for (const ship of ships.values()) {
    ship.marker?.remove();
    ship.trail?.remove();
    ship.label?.remove();
    ship.smoothAheadLine?.remove();
    ship.smoothPastLine?.remove();
    if (ship.smoothAheadMarks) for (const m of ship.smoothAheadMarks) m.remove();
    if (ship.smoothPastMarks) for (const m of ship.smoothPastMarks) m.remove();
    if (ship.fixCircles) for (const m of ship.fixCircles.values()) m.remove();
  }
  ships.clear();
  staticData.clear();
  removeSavedData();
}

function removeSavedData() {
  localStorage.removeItem(STORAGE_KEY_SHIPS);
  localStorage.removeItem(STORAGE_KEY_STATIC);
  localStorage.removeItem(STORAGE_KEY_META);
  localStorage.removeItem(STORAGE_KEY_COMPRESSED);
  localStorage.removeItem(STORAGE_KEY_VERSION);
  storageState.note = null;
  clearTimeout(flashTimer); // don't let a stale pending flash (e.g. an earlier "Load failed") repaint over this
  showIdleStorageIndicator();
}

// filterState.maxStorageKB === 0 ("off", left end of the Debug slider) means
// localStorage is not used at all, not just "no proactive limit" — called
// from the slider's own input handler (legend.mjs) the instant it's
// dragged to 0, so the existing save is gone immediately rather than
// lingering until whatever was last written naturally expires.
export function disableLocalStorage() {
  removeSavedData();
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

// ── Compact array-based record format ───────────────────────────────────
// A saved fix/ship/static-data record as a plain {lat, lon, sog, ...}
// object repeats every one of those key names in the JSON for every single
// fix — across a few thousand fixes that's most of the saved size. Packing
// each record into a plain positional array instead (decoded via the
// FIX_*/SHIP_*/STATIC_* index constants below, so the access sites still
// read like field names despite the data itself having none) cuts all of
// that out. The mmsi → record mapping itself stays a plain object/dict
// (mmsi is a real lookup key, not a fixed-schema field to compact away).
const FIX_LAT = 0, FIX_LON = 1, FIX_SOG = 2, FIX_COURSE_TRUE = 3, FIX_HEADING_TRUE = 4,
      FIX_NAV_STATUS = 5, FIX_TS = 6, FIX_HEADING_RELIABLE = 7, FIX_UNRELIABLE_REASON = 8;

function packFix(h) {
  return [
    +h.lat.toFixed(4), +h.lon.toFixed(4), h.sog, h.courseTrue, h.headingTrue, h.navStatus,
    h.ts, h.headingReliable, h.unreliableReason ?? null,
  ];
}
function unpackFix(a) {
  return {
    lat: a[FIX_LAT], lon: a[FIX_LON], sog: a[FIX_SOG], courseTrue: a[FIX_COURSE_TRUE], headingTrue: a[FIX_HEADING_TRUE],
    navStatus: a[FIX_NAV_STATUS], ts: a[FIX_TS],
    headingReliable: a[FIX_HEADING_RELIABLE], unreliableReason: a[FIX_UNRELIABLE_REASON],
  };
}

// No name field here — it's already saved once, under the same mmsi key,
// in ais_static (see packStatic/STATIC_NAME below); unpackShip's caller
// (loadVesselData) passes that looked-up name back in rather than this
// carrying its own redundant copy.
const SHIP_LAT = 0, SHIP_LON = 1, SHIP_SOG = 2, SHIP_COURSE_TRUE = 3, SHIP_HEADING_TRUE = 4,
      SHIP_NAV_STATUS = 5, SHIP_TS = 6,
      SHIP_SPOOF_SUSPECTED = 7, SHIP_MAX_IMPLIED_KNOTS = 8, SHIP_HISTORY = 9;

// d (ship.data) is the live snapshot — lat/lon here are already the hull's
// middle, and the real per-point courseTrue/sog/headingTrue/navStatus are
// saved verbatim (in history, below) so a reload doesn't need to fabricate
// them (see unpackShip/loadVesselData).
function packShip(ship, maxPoints) {
  const d = ship.data;
  return [
    +d.lat.toFixed(4), +d.lon.toFixed(4), d.sog, d.courseTrue, d.headingTrue, d.navStatus, d.ts,
    ship.spoofSuspected || false, ship.maxImpliedKnots || 0,
    ship.history.slice(-maxPoints).map(packFix),
  ];
}
function unpackShip(mmsi, a, name) {
  return {
    data: {
      mmsi, name: name ?? null, lat: a[SHIP_LAT], lon: a[SHIP_LON], sog: a[SHIP_SOG], courseTrue: a[SHIP_COURSE_TRUE],
      headingTrue: a[SHIP_HEADING_TRUE], navStatus: a[SHIP_NAV_STATUS], ts: a[SHIP_TS],
    },
    spoofSuspected: a[SHIP_SPOOF_SUSPECTED],
    maxImpliedKnots: a[SHIP_MAX_IMPLIED_KNOTS],
    history: a[SHIP_HISTORY].map(unpackFix),
  };
}

// No typeLabel field — it's presentation, derived on demand from typeCode
// via shipTypeLabel (categories.mjs) wherever it's displayed, not a
// redundant string saved alongside the code that produces it.
const STATIC_TYPE_CODE = 0, STATIC_NAME = 1, STATIC_DIM = 2,
      STATIC_DRAUGHT = 3, STATIC_CALL_SIGN = 4, STATIC_IMO = 5, STATIC_DESTINATION = 6;

// dim ({A,B,C,D}, bow/stern/port/starboard distances from the GPS antenna)
// packs to its own [A,B,C,D] array for the same reason as everything else
// here — it's a fixed, known shape, just nested one level deeper.
function packStatic(meta) {
  return [
    meta.typeCode ?? null, meta.name ?? null,
    meta.dim ? [meta.dim.A ?? 0, meta.dim.B ?? 0, meta.dim.C ?? 0, meta.dim.D ?? 0] : null,
    meta.draught ?? null, meta.callSign ?? null, meta.imo ?? null, meta.destination ?? null,
  ];
}
function unpackStatic(a) {
  const dim = a[STATIC_DIM];
  return {
    typeCode: a[STATIC_TYPE_CODE], name: a[STATIC_NAME],
    dim: dim ? { A: dim[0], B: dim[1], C: dim[2], D: dim[3] } : null,
    draught: a[STATIC_DRAUGHT], callSign: a[STATIC_CALL_SIGN], imo: a[STATIC_IMO], destination: a[STATIC_DESTINATION],
  };
}

// Plain-data snapshot for one eviction attempt — cheap (just copying/
// rounding/packing numbers), unlike the JSON.stringify+compress step that
// follows it, which is the actual expensive part (see saveVesselData below).
function buildSavePayload(shipsToSave, saveStatic, maxPoints) {
  const shipsObj = {};
  for (const [mmsi, ship] of shipsToSave) shipsObj[mmsi] = packShip(ship, maxPoints);
  const staticObj = {};
  if (saveStatic) {
    for (const [mmsi, meta] of staticData) staticObj[mmsi] = packStatic(meta);
  }
  return { shipsObj, staticObj };
}

function isQuotaError(e) {
  return e.name === 'QuotaExceededError' || e.code === 22;
}

// Tracks the smallest payload size that still hit a REAL browser quota
// error (e.attemptedKB, set only by commitSave's own setItem failure — not
// by checkUserStorageLimit's lookalike) across one save attempt's eviction
// retries — eviction shrinks the payload each step, so this ends up being
// "the floor the browser itself enforced," distinct from the user's own
// configured limit.
function trackQuotaFailure(e) {
  if (e.attemptedKB == null) return;
  storageState.quotaFailKB = storageState.quotaFailKB == null
    ? e.attemptedKB
    : Math.min(storageState.quotaFailKB, e.attemptedKB);
}

// The browser's real quota (~5MB) is far past where saving/loading actually
// start feeling laggy (compressing/decompressing a large JSON blob is real
// CPU work) — filterState.maxStorageKB (Debug slider, default 5000) lets
// the user cap it well below that. (0 disables localStorage entirely —
// handled separately, by saveVesselData/saveVesselDataSync returning before
// they ever reach this.) Reuses the SAME progressive eviction loop the real
// QuotaExceededError path already drives, by throwing a lookalike error
// isQuotaError() recognizes, rather than a second eviction mechanism.
function checkUserStorageLimit(shipsStr, staticStr) {
  const limitKB = filterState.maxStorageKB;
  if (!limitKB) return;
  const usedKB = (shipsStr.length + staticStr.length) / 1024;
  if (usedKB > limitKB) {
    const err = new Error(`Save (${usedKB.toFixed(0)}kB) exceeds the configured ${limitKB}kB limit`);
    err.code = 22;
    err.userLimit = true; // distinguishes from a REAL browser QuotaExceededError below
    throw err;
  }
}

function commitSave(shipsStr, staticStr, step, maxPoints, shipsToSave, compressed) {
  const sizeKB = (shipsStr.length + staticStr.length) / 1024;
  try {
    localStorage.setItem(STORAGE_KEY_SHIPS,  shipsStr);
    localStorage.setItem(STORAGE_KEY_STATIC, staticStr);
    localStorage.setItem(STORAGE_KEY_META,   String(Date.now()));
    // Own key (not a prefix baked into the values above) — see
    // STORAGE_KEY_COMPRESSED's own comment for why; read by loadVesselData
    // instead of guessing from decompressFromUTF16's return value, which
    // doesn't reliably signal "this wasn't compressed": fed plain JSON, it
    // neither throws nor returns null/empty, just garbage, which then fails
    // JSON.parse and surfaced as a hard "Load failed" even though the save
    // itself was perfectly fine.
    localStorage.setItem(STORAGE_KEY_COMPRESSED, String(compressed));
    localStorage.setItem(STORAGE_KEY_VERSION, String(STORAGE_FORMAT_VERSION));
  } catch (e) {
    e.attemptedKB = sizeKB; // read by the eviction loop's catch — only set here, so it's never confused with checkUserStorageLimit's own (synthetic) failure
    throw e;
  }
  const parts = [];
  if (step >= 1) parts.push('dropped no-static vessels');
  if (step >= 2) parts.push('non-moving vessels');
  if (step >= 3) parts.push('static data');
  if (maxPoints < MAX_TRAIL_POINTS) parts.push(`trimmed to ${maxPoints} pts/ship`);
  storageState.note = parts.length ? parts.join(', ') : null;

  let totalFixes = 0;
  for (const ship of ships.values()) totalFixes += ship.history.length;
  let savedFixes = 0;
  for (const [, ship] of shipsToSave) savedFixes += Math.min(ship.history.length, maxPoints);
  storageState.evictedVessels = ships.size - shipsToSave.size;
  storageState.evictedFixes = totalFixes - savedFixes;
  storageState.usedKB = sizeKB;
  updateDebugStorageRows();

  flashStorageIndicator(storageState.note ? `✅ Saved (${storageState.note})` : '✅ Saved');
}

function reportSaveFailed(e) {
  if (e) console.warn('localStorage save failed:', e.message);
  else console.warn('localStorage: cannot fit data even after full eviction');
  storageState.note = 'save failed';
  updateDebugStorageRows();
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
function compressInWorker(shipsObj, staticObj, compress) {
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
    worker.postMessage({ id, shipsObj, staticObj, compress });
  });
}

// Guards against periodic ticks overlapping a still-in-flight save — there's
// no correctness need to run two at once, and the next tick 30s later will
// just pick up fresher data anyway.
let saveInFlight = false;

export async function saveVesselData() {
  if (filterState.maxStorageKB === 0) return; // disabled — disableLocalStorage() already removed any existing save
  if (saveInFlight) return;
  saveInFlight = true;
  storageState.quotaFailKB = null; // fresh per attempt — see trackQuotaFailure
  const compress = filterState.compressStorage; // fixed for this whole attempt, even if the checkbox changes mid-save
  try {
    // Apply any messages still sitting in the batch queue first — otherwise
    // a save could persist stale ship state that's about to change the
    // instant the next periodic flush runs.
    flushMessageQueue();
    setStorageIndicator('💾 Saving…', 'busy');
    for (const { shipsToSave, saveStatic, maxPoints, step } of evictionSteps()) {
      try {
        const { shipsObj, staticObj } = buildSavePayload(shipsToSave, saveStatic, maxPoints);
        const { shipsStr, staticStr } = await compressInWorker(shipsObj, staticObj, compress);
        checkUserStorageLimit(shipsStr, staticStr);
        commitSave(shipsStr, staticStr, step, maxPoints, shipsToSave, compress);
        return;
      } catch (e) {
        if (!isQuotaError(e)) { reportSaveFailed(e); return; }
        trackQuotaFailure(e);
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
  if (filterState.maxStorageKB === 0) return; // disabled — disableLocalStorage() already removed any existing save
  storageState.quotaFailKB = null; // fresh per attempt — see trackQuotaFailure
  const compress = filterState.compressStorage; // fixed for this whole attempt
  flushMessageQueue();
  setStorageIndicator('💾 Saving…', 'busy');
  for (const { shipsToSave, saveStatic, maxPoints, step } of evictionSteps()) {
    try {
      const { shipsObj, staticObj } = buildSavePayload(shipsToSave, saveStatic, maxPoints);
      const shipsJson  = JSON.stringify(shipsObj);
      const staticJson = JSON.stringify(staticObj);
      // Compression here runs synchronously on the main thread (this is the
      // one save path that can't offload to the worker — see the comment
      // above saveVesselDataSync) — that's real, unavoidable CPU time when
      // compress is on. main.mjs's saveWithBanner shows "Saving..." and
      // forces a layout flush right before calling this, as a best-effort
      // mitigation; there's no way to *guarantee* a paint before a long
      // synchronous block on the web platform.
      const shipsStr  = compress ? LZString.compressToUTF16(shipsJson)  : shipsJson;
      const staticStr = compress ? LZString.compressToUTF16(staticJson) : staticJson;
      checkUserStorageLimit(shipsStr, staticStr);
      commitSave(shipsStr, staticStr, step, maxPoints, shipsToSave, compress);
      return;
    } catch (e) {
      if (!isQuotaError(e)) { reportSaveFailed(e); return; }
      trackQuotaFailure(e);
    }
  }
  reportSaveFailed(null);
}

export function loadVesselData() {
  if (filterState.maxStorageKB === 0) { showIdleStorageIndicator(); return; }
  try {
    const savedAt = parseInt(localStorage.getItem(STORAGE_KEY_META) ?? '0', 10);
    if (!savedAt || Date.now() - savedAt > STORAGE_TTL_MS) { showIdleStorageIndicator(); return; }
    // A missing/mismatched version means this save predates today's
    // packFix/packShip/packStatic schema (or a future one) — unpacking it
    // with the wrong index constants would silently misread fields by
    // position rather than failing loudly, so just treat it as nothing to
    // load (same as an expired save) instead of guessing.
    const version = parseInt(localStorage.getItem(STORAGE_KEY_VERSION) ?? '0', 10);
    if (version !== STORAGE_FORMAT_VERSION) { showIdleStorageIndicator(); return; }
    setStorageIndicator('📂 Loading…', 'busy');
    const cutoff  = Date.now() - STORAGE_TTL_MS;

    // Set alongside the save itself (commitSave) — undefined for a save from
    // before this key existed, in which case isCompressed stays false below
    // and the plain-JSON-first fallback chain in lzParse handles it.
    const isCompressed = localStorage.getItem(STORAGE_KEY_COMPRESSED) === 'true';
    const lzParse = (raw) => {
      if (!raw) return null;
      if (isCompressed) return JSON.parse(LZString.decompressFromUTF16(raw));
      // Plain JSON is the expectation now (compressStorage defaults to
      // off) — but for a pre-STORAGE_KEY_COMPRESSED save that was actually
      // compressed, fall back to decompressing.
      try { return JSON.parse(raw); } catch (_) {}
      return JSON.parse(LZString.decompressFromUTF16(raw));
    };

    const staticRaw = localStorage.getItem(STORAGE_KEY_STATIC);
    if (staticRaw) {
      for (const [mmsi, packed] of Object.entries(lzParse(staticRaw))) staticData.set(mmsi, unpackStatic(packed));
    }

    const shipsRaw = localStorage.getItem(STORAGE_KEY_SHIPS);
    if (!shipsRaw) { flashStorageIndicator('🕐 Nothing to load'); return; }
    for (const [mmsi, packed] of Object.entries(lzParse(shipsRaw))) {
      // Static data (just loaded, above) is the name source on reload — no
      // need for the ship record to carry its own copy of a name that's
      // already sitting in ais_static under the same mmsi key.
      const sd    = staticData.get(mmsi);
      const saved = unpackShip(mmsi, packed, sd?.name);
      // The real per-point courseTrue/sog/headingTrue/navStatus are persisted
      // verbatim (see saveVesselData) — no fabricating them from position
      // deltas. Older saves (before this) won't have `history` at all;
      // those vessels just don't restore, rather than restoring with made-up
      // kinematics.
      const history = (saved.history ?? []).filter((h) => h.ts >= cutoff);
      if (!history.length) continue;
      const positions  = history.map((h) => [h.lat, h.lon]);
      const timestamps = history.map((h) => h.ts);

      const data  = saved.data;
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
      const { heading, usingLastKnown } = resolveHeading(data.courseTrue, data.headingTrue, null);
      const dotAngle = !cogBad(data.courseTrue) ? data.courseTrue : heading;
      const trail  = L.polyline(positions, { color: trailColor, weight: 1.5, opacity: 0.6 });
      // data.lat/data.lon already IS the hull's middle — it was stored that
      // way (see updateShip in messages.mjs) before ever being saved here.
      const middle = [data.lat, data.lon];
      const marker = L.marker(wrapLatLngNearCenter(middle), { icon: shipIcon(heading, dotAngle, data.sog, sd?.typeCode, sd?.dim, isFloating) });
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
