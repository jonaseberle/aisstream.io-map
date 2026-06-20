const EARTH_R = 6371000;

// Destination point given a start point, an initial bearing (deg, true
// north) and a distance (m) — the standard spherical-earth "direct"
// geodesic formula. Works fine with a negative distance (equivalent to the
// reciprocal bearing).
export function destinationPoint(lat, lon, bearingDeg, distanceM) {
  const δ = distanceM / EARTH_R;
  const θ = bearingDeg * Math.PI / 180;
  const φ1 = lat * Math.PI / 180, λ1 = lon * Math.PI / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [φ2 * 180 / Math.PI, λ2 * 180 / Math.PI];
}

// AIS position reports give the GPS antenna's position, not the hull's
// geometric middle — and the antenna is often well off-center (esp. on
// container ships, where it sits far forward). dim holds the antenna's
// distance to each side of the hull (A=bow, B=stern, C=port, D=starboard).
// Offsets the antenna fix by half the bow/stern and port/starboard
// imbalance, rotated by the current heading, to get the hull's middle.
export function shipMiddlePosition(lat, lon, heading, dim) {
  if (!dim || !Number.isFinite(heading)) return [lat, lon];
  const { A = 0, B = 0, C = 0, D = 0 } = dim;
  const forward = (A - B) / 2;  // +distance towards the bow
  const lateral = (D - C) / 2;  // +distance towards starboard
  if (!forward && !lateral) return [lat, lon];
  const [latF, lonF] = forward ? destinationPoint(lat, lon, heading, forward) : [lat, lon];
  return lateral ? destinationPoint(latF, lonF, heading + 90, lateral) : [latF, lonF];
}

// Inverse of shipMiddlePosition — recovers the GPS antenna's actual fix from
// a stored middle position. The middle is "the ship position" everywhere
// now (stored once, on ingestion); this is only for the rare spot that
// specifically wants the real antenna fix (e.g. a diagnostic popup).
export function gpsAntennaPosition(lat, lon, heading, dim) {
  if (!dim || !Number.isFinite(heading)) return [lat, lon];
  const { A = 0, B = 0, C = 0, D = 0 } = dim;
  const forward = (B - A) / 2;  // +distance towards the bow (reverse of shipMiddlePosition's offset)
  const lateral = (C - D) / 2;  // +distance towards starboard
  if (!forward && !lateral) return [lat, lon];
  const [latF, lonF] = forward ? destinationPoint(lat, lon, heading, forward) : [lat, lon];
  return lateral ? destinationPoint(latF, lonF, heading + 90, lateral) : [latF, lonF];
}
