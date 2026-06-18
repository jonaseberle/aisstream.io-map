import { ships, staticData, MAX_TRAIL_POINTS } from './state.js';
import { CATEGORIES, shipCategory, shipTypeLabel } from './categories.js';
import { shipIcon } from './icons.js';
import { resolveHeading, cogBad, bestHeading } from './heading.js';
import { SPOOF_SPEED_KNOTS, haversineKnots } from './spoof.js';
import { applyVisibility, refreshTrail, isFloatingNow } from './visibility.js';
import { buildPopup, refreshPopupIfOpen } from './popup.js';
import { smoothMotionState } from './smoothMotion.js';

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
    ship.marker.setIcon(shipIcon(heading, dotAngle, d.sog, sd?.typeCode, sd?.dim, ship.isFloating));
  }
  ship.trail.setStyle({ color: ship.spoofSuspected ? '#ff4444' : CATEGORIES[shipCategory(sd?.typeCode)].color });
  applyVisibility(mmsi);
  refreshPopupIfOpen(mmsi);
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

  const data = { mmsi, name: meta?.ShipName?.trim() || null, lat, lon, cog: pos.Cog, sog: pos.Sog, hdg: pos.TrueHeading, navStatus: pos.NavigationalStatus, declination: msg._declination ?? null, ts: Date.now() };
  const typeCode = staticData.get(mmsi)?.typeCode;
  const cat = shipCategory(typeCode);
  const color = CATEGORIES[cat].color;

  if (ships.has(mmsi)) {
    const ship = ships.get(mmsi);
    // Spoof detection: check implied speed against last known position,
    // and flag a reported sog above the threshold as unreliable outright.
    if (ship.positions.length) {
      const [pLat, pLon] = ship.positions[ship.positions.length - 1];
      const pTs = ship.timestamps[ship.timestamps.length - 1];
      const implied = haversineKnots(pLat, pLon, lat, lon, data.ts - pTs);
      if (implied > SPOOF_SPEED_KNOTS) {
        ship.spoofSuspected = true;
        ship.maxImpliedKnots = Math.max(ship.maxImpliedKnots ?? 0, implied);
        ship.trail.setStyle({ color: '#ff4444' });
      }
    }
    if (data.sog > SPOOF_SPEED_KNOTS) {
      ship.spoofSuspected = true;
      ship.maxImpliedKnots = Math.max(ship.maxImpliedKnots ?? 0, data.sog);
      ship.trail.setStyle({ color: '#ff4444' });
    }
    const { heading, usingLastKnown } = resolveHeading(data.cog, data.hdg, data.declination, ship.lastGoodHeading);
    ship.usingLastKnownHeading = usingLastKnown;
    if (!usingLastKnown && heading != null) ship.lastGoodHeading = heading;
    const dotAngle = !cogBad(data.cog) ? data.cog : heading;
    ship.positions.push([lat, lon]);
    ship.timestamps.push(data.ts);
    if (ship.positions.length > MAX_TRAIL_POINTS) { ship.positions.shift(); ship.timestamps.shift(); }
    // headingReliable reflects THIS report's own cog/hdg (not any fallback
    // to a previously-seen heading) — smooth motion's "Hide unreliable
    // heading/course" filter needs to know whether the report itself had
    // usable data, not just whether we have *some* heading to animate with.
    ship.history.push({ lat, lon, sog: data.sog, cog: data.cog, hdg: data.hdg, navStatus: data.navStatus, declination: data.declination, ts: data.ts, headingReliable: bestHeading(data.cog, data.hdg, data.declination) != null });
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
    } else {
      ship.marker.setLatLng([lat, lon]);
      ship.marker.setIcon(shipIcon(heading, dotAngle, data.sog, typeCode, staticData.get(mmsi)?.dim, ship.isFloating));
    }
    ship.data = data;
    ship.inBounds = true;
    ship.timedOut = false;
    refreshTrail(ship);
    refreshPopupIfOpen(mmsi);
  } else {
    const positions = [[lat, lon]];
    const history = [{ lat, lon, sog: data.sog, cog: data.cog, hdg: data.hdg, navStatus: data.navStatus, declination: data.declination, ts: data.ts, headingReliable: bestHeading(data.cog, data.hdg, data.declination) != null }];
    const isFloating = isFloatingNow(history, data.ts);
    const { heading, usingLastKnown } = resolveHeading(data.cog, data.hdg, data.declination, null);
    const dotAngle = !cogBad(data.cog) ? data.cog : heading;
    const trail = L.polyline(positions, { color, weight: 1.5, opacity: 0.6 });
    const marker = L.marker([lat, lon], { icon: shipIcon(heading, dotAngle, data.sog, typeCode, staticData.get(mmsi)?.dim, isFloating) });
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
      onMap: false, trailOnMap: false,
    };
    ships.set(mmsi, ship);
    applyVisibility(mmsi);
  }
}
