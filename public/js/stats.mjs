import { ships } from './state.mjs';
import { speedDotZoomFactor } from './icons.mjs';
import { applyVisibility, isShipVisible, isShipMoving, isFloatingNow } from './visibility.mjs';
import { refreshIcon } from './messages.mjs';
import { refreshPopupIfOpen } from './popup.mjs';

function fmtSec(ms) { return `${Math.round(ms / 1000)}s`; }

let msgCount = 0;
export function incrementMsgCount() { msgCount++; }

// These all live inside the Settings tab's content (legend.mjs) — which the
// shared side panel (sidePanel.mjs) detaches from the document whenever a
// different tab (e.g. AIS Fixes) is active. Null-guarded rather than timed
// around, since "currently detached" is an expected, recurring state now,
// not a one-off load-order race.
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

export function startStatsLoop() {
  setInterval(() => {
    setText('msg-rate', msgCount);
    msgCount = 0;

    let visibleCount = 0, movingCount = 0, singleObsCount = 0;
    const intervalSamples = [];

    for (const [mmsi, ship] of ships) {
      if (!ship.inBounds || !isShipVisible(mmsi)) continue;
      visibleCount++;

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

    setText('ship-count', visibleCount);
    setText('moving-count', movingCount);
    setText('single-obs-count', singleObsCount);

    const avgEl = document.getElementById('avg-interval');
    if (!avgEl) {
      // tab not currently shown — nothing to update
    } else if (intervalSamples.length === 0) {
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

    const speedHint = document.getElementById('speed-hint');
    if (speedHint) {
      const factor = speedDotZoomFactor();
      speedHint.textContent = `Each white dot ahead of the bow = ${factor} kn of speed`;
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
  }, 1000);
}
