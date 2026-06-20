export const SPOOF_SPEED_KNOTS = 102.2; // AIS SOG field maxes out at 102.2 kts; above this is invalid/spoofed

// Below this, GPS jitter (a vessel's antenna fix wobbling by a few tens of
// meters between reports) can transiently imply an absurd speed over a
// short enough time/distance even though nothing's actually wrong — not
// worth flagging as "position unreliable" until the jump is large enough
// that jitter alone can't explain it.
export const MIN_SPOOF_DISTANCE_NM = 0.5;

export function haversineKnots(lat1, lon1, lat2, lon2, ms) {
  // A non-positive elapsed time is a data-pipeline artifact (two reports for
  // the same ship landing in the same batch/millisecond, ts collision, etc),
  // not evidence of vessel speed — returning Infinity here regardless of
  // actual distance falsely flagged vessels whose fixes were genuinely ~0 NM
  // apart. The reported-SOG check (messages.mjs) is the real spoof-speed
  // detector; this one specifically needs a usable time delta to mean
  // anything.
  if (ms <= 0) return 0;
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a)) / 1852 / (ms / 3600000);
}
