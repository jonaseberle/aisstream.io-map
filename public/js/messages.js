import { map } from './map.js';
import { ships, staticData, MAX_TRAIL_POINTS } from './state.js';
import { CATEGORIES, shipCategory, shipTypeLabel } from './categories.js';
import { shipIcon } from './icons.js';
import { resolveHeading, cogBad, bestHeading } from './heading.js';
import { SPOOF_SPEED_KNOTS, haversineKnots } from './spoof.js';
import { applyVisibility, refreshTrail, isFloatingNow, filterState } from './visibility.js';
import { buildPopup, refreshPopupIfOpen } from './popup.js';
import { smoothMotionState } from './smoothMotion.js';
import { destinationPoint, shipMiddlePosition } from './geo.js';

// Gap (m) between the hull's geometric middle and its name label, offset to
// starboard and rotated around the middle as heading changes — so the label
// stays glued to the ship's beam instead of a fixed screen-space direction.
const LABEL_OFFSET_M = 10;

// Permanent name label anchored at the ship's middle (not the GPS antenna
// fix the marker itself sits at). Static data (with the authoritative name)
// often arrives after the first position report, so this needs to be
// refreshed independently of marker creation — and again whenever onMap or
// the middle position changes.
export function updateLabel(mmsi) {
  const ship = ships.get(mmsi);
  if (!ship) return;
  const name = filterState.showLabels ? (staticData.get(mmsi)?.name || ship.data.name || null) : null;
  if (!name || !ship.onMap) {
    if (ship.label) { ship.label.remove(); ship.label = null; }
    return;
  }
  const middle = ship.middle || [ship.data.lat, ship.data.lon];
  const heading = ship.lastGoodHeading;
  const labelPos = Number.isFinite(heading) ? destinationPoint(middle[0], middle[1], heading + 90, LABEL_OFFSET_M) : middle;
  if (ship.label) {
    ship.label.setLatLng(labelPos);
    ship.label.setContent(name);
  } else {
    ship.label = L.tooltip(labelPos, { permanent: true, direction: 'center', className: 'ship-label', interactive: false })
      .setContent(name).addTo(map);
  }
}

export function refreshIcon(mmsi) {
  const ship = ships.get(mmsi);
  if (!ship) return;
  const d = ship.data;
  const sd = staticData.get(mmsi);
  ship.isFloating = isFloatingNow(ship.history, d.ts);
  const { heading, usingLastKnown } = resolveHeading(d.cog, d.hdg, d.declination, ship.lastGoodHeading);
  ship.usingLastKnownHeading = usingLastKnown;
  if (!usingLastKnown && heading != null) ship.lastGoodHeading = heading;
  const dotAngle = !cogBad(d.cog) ? d.cog : heading;
  // With smooth motion on, orienting the icon by the *live* heading here
  // would momentarily point it the wrong way relative to the marker's
  // lagged position/track — leave orientation to the smooth-motion loop,
  // which uses a heading consistent with where the marker is actually
  // drawn. Just invalidate its cached heading so it redraws next tick even
  // if the rendered heading itself hasn't moved (e.g. only typeCode/dim changed).
  if (smoothMotionState.enabled) {
    ship.smoothIconHeading = null;
  } else {
    // d.lat/d.lon already IS the hull's middle — computed once, on ingestion
    // of the position report (see updateShip below), and remembered as the
    // ship's position from then on. If static data (dim) arrives only after
    // that, this report stays uncorrected until the next one arrives with
    // dim known; no re-deriving the middle from here.
    ship.middle = [d.lat, d.lon];
    ship.marker.setLatLng(ship.middle);
    ship.marker.setIcon(shipIcon(heading, dotAngle, d.sog, sd?.typeCode, sd?.dim, ship.isFloating));
  }
  ship.trail.setStyle({ color: ship.spoofSuspected ? '#ff4444' : CATEGORIES[shipCategory(sd?.typeCode)].color });
  applyVisibility(mmsi);
  updateLabel(mmsi);
  refreshPopupIfOpen(mmsi);
}

// ── Batched ingestion ─────────────────────────────────────────────────────
// Incoming WebSocket messages are queued here instead of being processed the
// instant they arrive — websocket.js pushes raw strings via queueMessage(),
// then a periodic flushMessageQueue() (and one right before every
// localStorage save, so saved data isn't stale relative to the queue) drains
// the whole batch at once. Within a batch, the expensive per-ship work
// (icon redraw, trail update, label, popup) is coalesced: a ship that sent
// 5 reports in one batch window still gets its data/history/spoof-check
// applied for all 5 (updateShip below runs in full each time), but only ONE
// render pass at the end, from whichever report ended up newest.
const messageQueue = [];
const dirtyShips = new Set();

export function queueMessage(raw) {
  messageQueue.push(raw);
}

export function flushMessageQueue() {
  if (!messageQueue.length) return;
  const batch = messageQueue.splice(0, messageQueue.length);
  for (const raw of batch) {
    try {
      updateShip(JSON.parse(raw));
    } catch (err) {
      console.error('Parse error:', err, typeof raw === 'string' ? raw.slice(0, 200) : raw);
    }
  }
  for (const mmsi of dirtyShips) {
    refreshIcon(mmsi); // recomputes heading/icon/visibility/label/popup from the ship's now-latest data
    const ship = ships.get(mmsi);
    if (ship) refreshTrail(ship);
  }
  dirtyShips.clear();
}

// ── Message handling ──────────────────────────────────────────────────────
export function updateShip(msg) {
  if (msg._type === 'metaCache') {
    for (const [mmsi, m] of Object.entries(msg.data)) {
      staticData.set(mmsi, {
        typeCode: m.typeCode, typeLabel: m.label, name: m.name,
        dim: m.dim, draught: m.draught, callSign: m.callSign, imo: m.imo, destination: m.destination,
      });
      refreshIcon(mmsi);
    }
    return;
  }

  if (msg.MessageType === 'ShipStaticData') {
    const payload = msg.Message && Object.values(msg.Message)[0];
    const mmsi = String(payload?.UserID ?? msg.Metadata?.MMSI);
    const typeCode = payload?.Type;
    staticData.set(mmsi, {
      typeCode,
      typeLabel: shipTypeLabel(typeCode),
      name: payload?.Name?.trim() || msg.Metadata?.ShipName?.trim() || null,
      dim: payload?.Dimension ?? null,
      draught: payload?.MaximumStaticDraught ?? null,
      callSign: payload?.CallSign?.trim() || null,
      imo: payload?.ImoNumber ?? null,
      destination: payload?.Destination?.trim() || null,
    });
    refreshIcon(mmsi);
    return;
  }

  const meta = msg.Metadata;
  const pos = msg.Message && Object.values(msg.Message)[0];
  if (!pos) return;

  const mmsi = String(pos.UserID ?? meta?.MMSI);
  const lat = pos.Latitude ?? meta?.Latitude;
  const lon = pos.Longitude ?? meta?.Longitude;
  if (lat == null || lon == null) return;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;

  if (msg._meta) {
    const m = msg._meta;
    staticData.set(mmsi, {
      typeCode: m.typeCode, typeLabel: m.label, name: m.name,
      dim: m.dim, draught: m.draught, callSign: m.callSign, imo: m.imo, destination: m.destination,
    });
  }

  const dim = staticData.get(mmsi)?.dim;
  const data = { mmsi, name: meta?.ShipName?.trim() || null, lat, lon, cog: pos.Cog, sog: pos.Sog, hdg: pos.TrueHeading, navStatus: pos.NavigationalStatus, declination: msg._declination ?? null, ts: Date.now() };
  const typeCode = staticData.get(mmsi)?.typeCode;
  const cat = shipCategory(typeCode);
  const color = CATEGORIES[cat].color;

  if (ships.has(mmsi)) {
    const ship = ships.get(mmsi);
    const { heading, usingLastKnown } = resolveHeading(data.cog, data.hdg, data.declination, ship.lastGoodHeading);
    ship.usingLastKnownHeading = usingLastKnown;
    if (!usingLastKnown && heading != null) ship.lastGoodHeading = heading;
    // The hull's middle (not the raw antenna fix) is computed once here and
    // remembered as THE ship position from this point on — data.lat/lon,
    // positions, and history all store it directly, so nothing downstream
    // (icon, popup, label, trail, fix circles) has to re-derive it. The
    // antenna fix itself is only recovered on demand (gpsAntennaPosition),
    // for the rare spot that specifically wants it.
    const middle = shipMiddlePosition(lat, lon, heading, dim);
    data.lat = middle[0]; data.lon = middle[1];
    // Spoof detection: check implied speed against last known position,
    // and flag a reported sog above the threshold as unreliable outright.
    if (ship.positions.length) {
      const [pLat, pLon] = ship.positions[ship.positions.length - 1];
      const pTs = ship.timestamps[ship.timestamps.length - 1];
      const implied = haversineKnots(pLat, pLon, middle[0], middle[1], data.ts - pTs);
      if (implied > SPOOF_SPEED_KNOTS) {
        ship.spoofSuspected = true;
        ship.maxImpliedKnots = Math.max(ship.maxImpliedKnots ?? 0, implied);
      }
    }
    if (data.sog > SPOOF_SPEED_KNOTS) {
      ship.spoofSuspected = true;
      ship.maxImpliedKnots = Math.max(ship.maxImpliedKnots ?? 0, data.sog);
    }
    // ship.trail's color (red if spoofSuspected) is set by the deferred
    // refreshIcon below, not here — no need to touch it per-message.
    ship.positions.push(middle);
    ship.timestamps.push(data.ts);
    if (ship.positions.length > MAX_TRAIL_POINTS) { ship.positions.shift(); ship.timestamps.shift(); }
    // headingReliable reflects THIS report's own cog/hdg (not any fallback
    // to a previously-seen heading) — smooth motion's "Hide unreliable
    // heading/course" filter needs to know whether the report itself had
    // usable data, not just whether we have *some* heading to animate with.
    ship.history.push({ lat: middle[0], lon: middle[1], sog: data.sog, cog: data.cog, hdg: data.hdg, navStatus: data.navStatus, declination: data.declination, ts: data.ts, headingReliable: bestHeading(data.cog, data.hdg, data.declination) != null });
    if (ship.history.length > MAX_TRAIL_POINTS) ship.history.shift();
    // Computed after the push above, so smooth motion sees this report as
    // the newest "future" point when deciding whether we've run out of data.
    ship.isFloating = isFloatingNow(ship.history, data.ts);
    // With smooth motion on, the marker's position AND icon orientation are
    // driven by the periodic interpolation loop instead of snapping to each
    // new report — otherwise the icon would briefly point along the live
    // heading while still positioned at the lagged/interpolated spot.
    if (smoothMotionState.enabled) {
      ship.smoothIconHeading = null; // force the loop to redraw next tick regardless of its heading-change threshold
    }
    ship.data = data;
    ship.inBounds = true;
    ship.timedOut = false;
    // The actual marker move/icon redraw/trail update/label/popup refresh
    // (refreshIcon + refreshTrail) is deferred to flushMessageQueue's single
    // coalesced pass at the end of the batch — see the comment above
    // messageQueue/dirtyShips. ship.data above is already current, so
    // whichever report in this batch is newest wins by the time that runs.
    dirtyShips.add(mmsi);
  } else {
    const { heading, usingLastKnown } = resolveHeading(data.cog, data.hdg, data.declination, null);
    const dotAngle = !cogBad(data.cog) ? data.cog : heading;
    // See the existing-ship branch above: the middle is computed once and
    // remembered as the ship's position from here on.
    const middle = shipMiddlePosition(lat, lon, heading, dim);
    data.lat = middle[0]; data.lon = middle[1];
    const positions = [middle];
    const history = [{ lat: middle[0], lon: middle[1], sog: data.sog, cog: data.cog, hdg: data.hdg, navStatus: data.navStatus, declination: data.declination, ts: data.ts, headingReliable: bestHeading(data.cog, data.hdg, data.declination) != null }];
    const isFloating = isFloatingNow(history, data.ts);
    const trail = L.polyline(positions, { color, weight: 1.5, opacity: 0.6 });
    // The marker sits at the hull's middle, not the raw antenna fix — both
    // the icon's rotation pivot and the popup anchor follow from this.
    const marker = L.marker(middle, { icon: shipIcon(heading, dotAngle, data.sog, typeCode, dim, isFloating) });
    marker.bindPopup('', { maxWidth: 300 });
    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      marker.getPopup().setContent(buildPopup(mmsi));
      marker.openPopup();
    });
    const spoofSuspected = data.sog > SPOOF_SPEED_KNOTS;
    if (spoofSuspected) trail.setStyle({ color: '#ff4444' });
    const ship = {
      marker, trail, data, positions, timestamps: [data.ts], history, inBounds: true, spoofSuspected,
      maxImpliedKnots: spoofSuspected ? data.sog : 0, isFloating,
      lastGoodHeading: heading, usingLastKnownHeading: usingLastKnown,
      middle,
      onMap: false, trailOnMap: false,
    };
    ships.set(mmsi, ship);
    applyVisibility(mmsi);
    updateLabel(mmsi);
  }
}
