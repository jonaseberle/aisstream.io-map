export function hdgBad(hdg) { return hdg == null || hdg === 0 || hdg === 360 || hdg === 511; }
export function cogBad(cog) { return cog == null || cog === 0 || cog >= 360; }

// Returns best available heading (true north) — the bow's actual
// orientation. HDG preferred, corrected for local magnetic declination (in
// case the transponder reports magnetic heading). COG is already true
// north (GPS-derived), so no correction needed.
export function bestHeading(cog, hdg, declination) {
  if (!hdgBad(hdg)) return (hdg + (declination || 0) + 360) % 360;
  if (!cogBad(cog)) return cog;
  return null;
}

// Returns best available course over ground (true north) — the direction
// the vessel is actually translating, which is what its track/position
// follows. COG preferred (it's the GPS-derived track itself); HDG (the bow's
// orientation, which can differ under leeway/current) only as a fallback,
// corrected for declination same as bestHeading.
export function bestCourse(cog, hdg, declination) {
  if (!cogBad(cog)) return cog;
  if (!hdgBad(hdg)) return (hdg + (declination || 0) + 360) % 360;
  return null;
}

// Falls back to the last known good heading/course when both hdg and cog are
// currently unreliable, so the marker doesn't snap to a default orientation.
// Returns the heading to use plus whether it's a fallback (vs. a fresh reading).
export function resolveHeading(cog, hdg, declination, lastGoodHeading) {
  const fresh = bestHeading(cog, hdg, declination);
  if (fresh != null) return { heading: fresh, usingLastKnown: false };
  return { heading: lastGoodHeading ?? null, usingLastKnown: lastGoodHeading != null };
}
