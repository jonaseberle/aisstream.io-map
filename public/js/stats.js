import { map } from './map.js';
import { ships, staticData } from './state.js';
import { pixelsPerMeter, speedDotZoomFactor } from './icons.js';
import { applyVisibility, isShipVisible, isShipMoving, isFloatingNow } from './visibility.js';
import { STORAGE_KEY_SHIPS, STORAGE_KEY_STATIC, STORAGE_KEY_META, STORAGE_QUOTA_KB, storageState } from './storage.js';
import { refreshIcon } from './messages.js';
import { refreshPopupIfOpen } from './popup.js';

function fmtSec(ms) { return `${Math.round(ms / 1000)}s`; }

let msgCount = 0;
export function incrementMsgCount() { msgCount++; }

export function startStatsLoop() {
  setInterval(() => {
    document.getElementById('msg-rate').textContent = msgCount;
    msgCount = 0;

    let visibleCount = 0, movingCount = 0, singleObsCount = 0, spoofCount = 0;
    const intervalSamples = [];

    for (const [mmsi, ship] of ships) {
      if (!ship.inBounds || !isShipVisible(mmsi)) continue;
      visibleCount++;
      if (ship.spoofSuspected) spoofCount++;

      const d = ship.data;
      const isMoving = isShipMoving(d.sog);
      if (isMoving) {
        movingCount++;
        const ts = ship.timestamps;
        if (ts.length === 1) singleObsCount++;
        // Gap between the last two position reports only — not the age of
        // the most recent one, so a ship that just went quiet doesn't skew
        // this toward "now minus last report".
        if (ts.length >= 2) {
          intervalSamples.push(ts[ts.length - 1] - ts[ts.length - 2]);
        }
      }
    }

    document.getElementById('ship-count').textContent = visibleCount;
    document.getElementById('moving-count').textContent = movingCount;
    document.getElementById('single-obs-count').textContent = singleObsCount;
    document.getElementById('spoof-count').textContent = spoofCount;

    const avgEl = document.getElementById('avg-interval');
    if (intervalSamples.length === 0) {
      avgEl.textContent = '—';
    } else {
      intervalSamples.sort((a, b) => a - b);
      const n = intervalSamples.length;
      const min  = intervalSamples[0];
      const max  = intervalSamples[n - 1];
      const p50  = intervalSamples[Math.floor(n * 0.5)];
      const p80  = intervalSamples[Math.floor(n * 0.8)];
      avgEl.textContent = `min ${fmtSec(min)} / p50 ${fmtSec(p50)} / p80 ${fmtSec(p80)} / max ${fmtSec(max)}`;
    }

    const hint = document.getElementById('dim-hint');
    if (hint) {
      const ppm = pixelsPerMeter(map.getCenter().lat, map.getZoom());
      let withDim = 0, showing = 0;
      for (const sd of staticData.values()) {
        if (!sd?.dim) continue;
        const lengthPx = ((sd.dim.A || 0) + (sd.dim.B || 0)) * ppm;
        const beamPx   = ((sd.dim.C || 0) + (sd.dim.D || 0)) * ppm;
        withDim++;
        if (lengthPx >= 8 && beamPx >= 2) showing++;
      }
      const active = withDim > 0 && showing >= withDim / 2;
      hint.classList.toggle('active', active);
    }

    const speedHint = document.getElementById('speed-hint');
    if (speedHint) {
      const factor = speedDotZoomFactor();
      speedHint.textContent = factor === 1
        ? 'Each white dot ahead of the bow = 1 knot of speed'
        : `Each white dot ahead of the bow = ${factor} knots of speed`;
    }

    // Mark vessels timed out after 5 min; refresh visibility for all.
    // isFloating depends purely on elapsed time, so it must be re-checked here
    // too — a ship can go floating without ever receiving another message.
    const timeoutCutoff = Date.now() - 5 * 60 * 1000;
    for (const [mmsi, ship] of ships) {
      if (!ship.timedOut && ship.data.ts < timeoutCutoff) ship.timedOut = true;
      const floating = isFloatingNow(ship.history, ship.data.ts);
      if (floating !== ship.isFloating) {
        ship.isFloating = floating;
        refreshIcon(mmsi); // redraws the icon (faded + "!"), applies visibility, and refreshes the popup if open
      } else {
        applyVisibility(mmsi);
        // Keep purely time-based popup fields (age, "Last reports") live
        // even when nothing else about the ship has changed this tick.
        refreshPopupIfOpen(mmsi);
      }
    }

    // localStorage usage
    try {
      const bytes = [STORAGE_KEY_SHIPS, STORAGE_KEY_STATIC, STORAGE_KEY_META]
        .reduce((sum, k) => sum + (localStorage.getItem(k)?.length ?? 0), 0);
      const kb = (bytes / 1024).toFixed(1);
      const usedKB = bytes / 1024;
      const quotaNote = ` / ~5 MB (${(usedKB / STORAGE_QUOTA_KB * 100).toFixed(1)}%)`;
      const evictNote = storageState.note ? ` (${storageState.note})` : '';
      document.getElementById('storage-usage').textContent = `${kb} KB${quotaNote}${evictNote}`;
    } catch (_) {}
  }, 1000);
}
