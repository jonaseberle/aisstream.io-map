import './legend.mjs'; // instantiates the legend/filter control as a side effect (also loads saved UI settings, via settings.mjs)
import { loadVesselData, saveVesselData, saveVesselDataSync, storageSummaryText } from './storage.mjs';
import { startStatsLoop } from './stats.mjs';
import { initWebSocket } from './websocket.mjs';
import { flushMessageQueue, pruneOldFixes, initLabelViewport } from './messages.mjs';
import { initSmoothMotionControls, startSmoothMotionLoop, setVisibilityRefresher } from './smoothMotion.mjs';
import { loadSettings, resetSettings, saveSettings } from './settings.mjs';
import { filterState, applyVisibility } from './visibility.mjs';
import { ships } from './state.mjs';
import { initFixesPanel, refreshFixesPanel } from './fixesPanel.mjs';

loadVesselData();
setInterval(saveVesselData, 30_000);
setInterval(saveSettings, 5_000);
// Incoming AIS messages are queued (websocket.mjs) rather than applied the
// instant each one arrives — drained in one coalesced batch every
// filterState.messageFlushMs (Debug slider, cookie-saved), so a burst of
// reports for the same ship costs one icon/trail redraw instead of one per
// message. saveVesselData() also flushes the queue itself (see storage.mjs)
// before reading ship state, so a save can't catch stale, not-yet-applied
// data sitting in the queue. Re-scheduled (rather than setInterval) so it
// always picks up the slider's current value on its next tick.
// pruneOldFixes() rides the same loop — every ship (not just ones that just
// got a message) needs its oldest fixes continuously trimmed once they're
// older than anything smooth motion/trail could ever display.
// refreshFixesPanel() also rides it (a no-op while the panel's closed) — so
// the open panel's list keeps up with the lead/trail window sliding forward
// and new fixes arriving.
(function scheduleMessageFlush() {
  setTimeout(() => { flushMessageQueue(); pruneOldFixes(); refreshFixesPanel(); scheduleMessageFlush(); }, filterState.messageFlushMs);
})();
startStatsLoop();
initWebSocket();
initLabelViewport();
initFixesPanel();
// Lets smoothMotion.mjs refresh every ship's visibility when smooth motion is
// toggled (so the straight-segment trail appears/disappears at once), without
// importing visibility.mjs — which already imports from smoothMotion.mjs.
setVisibilityRefresher(() => { for (const mmsi of ships.keys()) applyVisibility(mmsi); });
initSmoothMotionControls();
// Passed in (rather than imported by smoothMotion.mjs) to avoid a circular
// import: visibility.mjs already imports smoothMotionState/historicalState
// from smoothMotion.mjs.
startSmoothMotionLoop(() => filterState.trailSec, () => filterState.leadSec, () => filterState.showFixes);

// The periodic saves above can miss the last few seconds of changes if the
// page is reloaded/closed in between — flush immediately whenever the page
// is about to go away or the tab is hidden (covers reloads, closes, and
// switching away on mobile, where timers may get suspended).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveVesselDataSync();
});

// beforeunload/pagehide both fire for an actual close/reload/navigation (as
// opposed to visibilitychange above, which also fires for a plain tab
// switch) — exactly the "leaving the page" case worth a full-screen heads-up
// that a save is in progress. Both can fire for the same navigation, so a
// guard makes sure the (synchronous, so it's safe to only run once) save
// itself only runs once; a second firing just re-shows the same result.
//
// Built and inserted into the DOM right away (hidden via CSS), not at
// unload time — so showing it there is just adding a class and writing
// text to an element the browser already has laid out, with no element
// creation/insertion cost in between the event firing and the banner being
// on screen.
const unloadBanner = document.createElement('div');
unloadBanner.id = 'unload-banner';
unloadBanner.className = 'unload-banner';
document.body.appendChild(unloadBanner);

let unloadSaveDone = false;
function saveWithBanner() {
  unloadBanner.textContent = '💾 Saving...';
  unloadBanner.classList.add('visible');
  // Best-effort nudge at an actual paint before the blocking save below —
  // reading a layout property forces synchronous style/layout right now,
  // which is necessary (though still not a guaranteed paint) for the
  // browser to have any chance of showing this text before the page
  // freezes. There's no way to *guarantee* a paint before a long
  // synchronous block on the web platform — if compression (Debug:
  // "Compress localStorage data") is on, this can still take a while.
  void unloadBanner.offsetHeight;
  if (!unloadSaveDone) {
    unloadSaveDone = true;
    saveVesselDataSync();
  }
  unloadBanner.textContent = storageSummaryText();
}
window.addEventListener('beforeunload', saveWithBanner);
window.addEventListener('pagehide', saveWithBanner);

document.getElementById('reset-settings-button').addEventListener(
  'click',
  () => {
    resetSettings();
    loadSettings();
    location.reload();
  }
);
