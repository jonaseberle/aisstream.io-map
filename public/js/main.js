import './legend.js'; // instantiates the legend/filter control as a side effect (also loads saved UI settings, via settings.js)
import { loadVesselData, saveVesselData } from './storage.js';
import { startStatsLoop } from './stats.js';
import { initWebSocket } from './websocket.js';
import { flushMessageQueue } from './messages.js';
import { initSmoothMotionControls, startSmoothMotionLoop, setVisibilityRefresher } from './smoothMotion.js';
import { loadSettings, resetSettings, saveSettings } from './settings.js';
import { filterState, applyVisibility } from './visibility.js';
import { ships } from './state.js';

loadVesselData();
setInterval(saveVesselData, 30_000);
setInterval(saveSettings, 5_000);
// Incoming AIS messages are queued (websocket.js) rather than applied the
// instant each one arrives — drained in one coalesced batch every 200ms,
// so a burst of reports for the same ship costs one icon/trail redraw
// instead of one per message. saveVesselData() also flushes the queue
// itself (see storage.js) before reading ship state, so a save can't catch
// stale, not-yet-applied data sitting in the queue.
setInterval(flushMessageQueue, 200);
startStatsLoop();
initWebSocket();
// Lets smoothMotion.js refresh every ship's visibility when smooth motion is
// toggled (so the straight-segment trail appears/disappears at once), without
// importing visibility.js — which already imports from smoothMotion.js.
setVisibilityRefresher(() => { for (const mmsi of ships.keys()) applyVisibility(mmsi); });
initSmoothMotionControls();
// Passed in (rather than imported by smoothMotion.js) to avoid a circular
// import: visibility.js already imports smoothMotionState/historicalState
// from smoothMotion.js.
startSmoothMotionLoop(() => filterState.trailSec, () => filterState.leadSec, () => filterState.showFixes);

// The periodic saves above can miss the last few seconds of changes if the
// page is reloaded/closed in between — flush immediately whenever the page
// is about to go away or the tab is hidden (covers reloads, closes, and
// switching away on mobile, where timers may get suspended).
function saveAll() { saveVesselData(); }
window.addEventListener('pagehide', saveAll);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveAll();
});

document.getElementById('reset-settings-button').addEventListener(
  'click',
  () => {
    resetSettings();
    loadSettings();
    location.reload();
  }
);
