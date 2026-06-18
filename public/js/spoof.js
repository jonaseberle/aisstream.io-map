export const SPOOF_SPEED_KNOTS = 102.2; // AIS SOG field maxes out at 102.2 kts; above this is invalid/spoofed

export function haversineKnots(lat1, lon1, lat2, lon2, ms) {
  if (ms <= 0) return Infinity;
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a)) / 1852 / (ms / 3600000);
}
