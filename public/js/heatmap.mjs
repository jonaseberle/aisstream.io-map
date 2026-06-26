// ── Vessel density heatmap ──────────────────────────────────────────────
// A live snapshot of where currently-displayed ships are right now (not an
// accumulated history) — rebuilt from each visible marker's position on
// every flush tick (see main.mjs's scheduleMessageFlush), same cadence as
// every other live display in the app.
import { map, wrapLatLngNearCenter } from './map.mjs';
import { ships } from './state.mjs';
import { isShipVisible } from './visibility.mjs';

const heatLayer = L.heatLayer([], { radius: 20, blur: 15, maxZoom: 12 });

export function setHeatmapEnabled(enabled) {
  if (enabled && !map.hasLayer(heatLayer)) heatLayer.addTo(map);
  else if (!enabled && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
}

export function refreshHeatmap() {
  if (!map.hasLayer(heatLayer)) return;
  const points = [];
  // Sourced from isShipVisible (the underlying filter set) rather than
  // ship.onMap — showing the heatmap suppresses every marker's onMap state
  // (see applyVisibility in visibility.mjs), so onMap would always be false.
  //
  // Re-wrapped from the raw lat/lon on every refresh rather than read off
  // the marker — the marker's own wrapped position is only refreshed when
  // that ship's next AIS message arrives, so it goes stale relative to
  // whichever antimeridian-crossing world copy is currently on screen as
  // soon as the map is panned without a new message in between.
  for (const [mmsi, ship] of ships) {
    if (isShipVisible(mmsi) && ship.middle) points.push(wrapLatLngNearCenter(ship.middle));
  }
  heatLayer.setLatLngs(points);
}

// Re-wrap immediately on pan/zoom rather than waiting for the next
// message-flush tick — otherwise panning across the antimeridian leaves
// stale points sitting in the previous world copy until the next message
// happens to arrive.
map.on('moveend', refreshHeatmap);
