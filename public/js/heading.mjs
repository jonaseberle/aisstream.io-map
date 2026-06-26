export function hdgBad(headingTrue) { return headingTrue == null || headingTrue === 0 || headingTrue === 360 || headingTrue === 511; }
export function cogBad(courseTrue) { return courseTrue == null || courseTrue === 0 || courseTrue >= 360; }

// Returns best available heading (true north) — the bow's actual
// orientation. HDG preferred: per ITU-R M.1371, AIS "True Heading" is
// already true north (gyrocompass-derived), not magnetic, so no declination
// correction applies despite the field's colloquial name. COG is also
// already true north (GPS-derived track).
export function bestHeading(courseTrue, headingTrue) {
  if (!hdgBad(headingTrue)) return headingTrue;
  if (!cogBad(courseTrue)) return courseTrue;
  return null;
}

// Returns best available course over ground (true north) — the direction
// the vessel is actually translating, which is what its track/position
// follows. COG preferred (it's the GPS-derived track itself); HDG (the bow's
// orientation, which can differ under leeway/current) only as a fallback —
// already true north, same as bestHeading.
export function bestCourse(courseTrue, headingTrue) {
  if (!cogBad(courseTrue)) return courseTrue;
  if (!hdgBad(headingTrue)) return headingTrue;
  return null;
}

// Falls back to the last known good heading/course when both headingTrue and
// courseTrue are currently unreliable, so the marker doesn't snap to a
// default orientation. Returns the heading to use plus whether it's a
// fallback (vs. a fresh reading).
export function resolveHeading(courseTrue, headingTrue, lastGoodHeading) {
  const fresh = bestHeading(courseTrue, headingTrue);
  if (fresh != null) return { heading: fresh, usingLastKnown: false };
  return { heading: lastGoodHeading ?? null, usingLastKnown: lastGoodHeading != null };
}
