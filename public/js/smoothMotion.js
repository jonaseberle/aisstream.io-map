import { map } from './map.js';
import { ships, staticData, NAV_STATUS } from './state.js';
import { shipIcon, pixelsPerMeter, speedDotZoomFactor, SPEED_DOT_SPACING } from './icons.js';
import { bestHeading, bestCourse, cogBad, hdgBad, resolveHeading } from './heading.js';
import { saveSettings } from './settings.js';
import { updateLabel } from './messages.js';
import { filterState, isShipMoving, navStatusUnreliable } from './visibility.js';

// "Smooth motion" trades immediacy for smoothness: instead of snapping each
// marker to its latest reported position the instant a message arrives, it
// displays — and filters — the vessel state DELTA seconds in the past. At
// each real report it shows exactly that report's position and cog/heading;
// between reports it dead-reckons along a circular arc sized by the ship's
// realistic turning ability, corrected to land exactly on the next report.
export const MIN_DELTA_SECONDS = 60;
export const MAX_DELTA_SECONDS = 3000;
export const smoothMotionState = { enabled: false, deltaSec: 300 };

// Refreshes every ship's visibility (set by main.js to avoid a circular
// import — visibility.js already imports from this module). Called when
// smooth motion is toggled, so the straight-segment trail — which is replaced
// by the smooth past line while smooth motion is on — is added/removed
// immediately rather than waiting for each ship's next message.
let refreshAllVisibility = null;
export function setVisibilityRefresher(fn) { refreshAllVisibility = fn; }

function lerp(a, b, t) { return a + (b - a) * t; }

export function targetTimestamp() {
  return Date.now() - smoothMotionState.deltaSec * 1000;
}

// Index pair in history (sorted ascending by ts) surrounding targetTs.
// Returns the same index twice when targetTs is outside the stored range.
function findBracket(history, targetTs) {
  const last = history.length - 1;
  if (targetTs <= history[0].ts) return [0, 0];
  if (targetTs >= history[last].ts) return [last, last];
  for (let i = 0; i < last; i++) {
    if (history[i].ts <= targetTs && targetTs <= history[i + 1].ts) return [i, i + 1];
  }
  return [last, last];
}

// ── Kinematic arc between two real reports ──────────────────────────────────
// Shortest signed angle from a to b, in (-180, 180].

function angleDiff(a, b) {
  return ((b - a + 540) % 360) - 180;
}

// Resolves a single canonical value for history[index] using `pick`,
// independent of which neighboring segment is asking. If the point's own
// reading isn't reliable, carries the nearest reliable one forward from
// before it (or, failing that, backward from after it) — the SAME
// resolution every time, so the segment ending at this point and the
// segment starting from it always agree exactly. Without this, each segment
// fell back independently (e.g. L→R borrowing L's value, R→R2 borrowing
// R2's, for the same unreliable point R), producing a visible kink right at
// that node.
function resolveAt(history, index, pick) {
  const pt = history[index];
  if (pt.headingReliable) {
    const v = pick(pt);
    if (v != null) return v;
  }
  for (let i = index - 1; i >= 0; i--) {
    if (history[i].headingReliable) {
      const v = pick(history[i]);
      if (v != null) return v;
    }
  }
  for (let i = index + 1; i < history.length; i++) {
    if (history[i].headingReliable) {
      const v = pick(history[i]);
      if (v != null) return v;
    }
  }
  return null;
}
// The bow's orientation (hdg preferred, cog fallback) at history[index].
function resolveHeadingAt(history, index) {
  return resolveAt(history, index, (pt) => bestHeading(pt.cog, pt.hdg, pt.declination));
}
// The actual direction of travel (cog preferred, hdg fallback) at
// history[index] — what the PATH follows, as distinct from the bow's
// orientation (resolveHeadingAt), which can differ under leeway/current.
function resolveCourseAt(history, index) {
  return resolveAt(history, index, (pt) => bestCourse(pt.cog, pt.hdg, pt.declination));
}

const M_PER_DEG_LAT = 111320;

function destFromDisplacement(lat, lon, dN, dE) {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180) || 1;
  return [lat + dN / M_PER_DEG_LAT, lon + dE / mPerDegLon];
}

// Builds the L→R segment as a cubic Hermite curve in local (north, east)
// meters: pinned to the exact reported position at both L and R, with the
// curve's tangent (direction + magnitude) at each end set to the reported
// COURSE (not heading — see below) and speed there. A previous version
// dead-reckoned a "turn then straight" arc and patched the leftover error in
// afterwards — that patch had its own (arbitrary) direction, generally
// different from the segment on the other side of L or R, so the apparent
// direction of travel kinked right at every real fix even though position
// itself was continuous. The Hermite formulation has no error to patch:
// since L's resolved course/speed (this segment's start tangent) is the
// EXACT SAME value the previous segment used as ITS end tangent
// (resolveCourseAt resolves per-point, not per-segment, and sog comes from
// that same single report), the direction of travel — not just the
// position — is continuous across every fix.
//
// The curve's own tangent direction is the COURSE (cog preferred, hdg
// fallback — resolveCourseAt), since that's what the GPS track actually
// follows. The bow's drawn orientation (heading: hdg preferred, cog
// fallback — resolveHeadingAt) can differ from course under leeway/current,
// so it isn't necessarily the curve's tangent — instead it's carried as a
// "crab" OFFSET from course (h0-c0 at L, h1-c1 at R), itself interpolated
// across the segment and added back onto the curve's live course in
// kinematicPoint. That keeps heading exactly h0/h1 at the real fixes (an
// exact pin, like position) while changing smoothly — and at the same rate
// the path curves — in between.
function buildSegment(history, li, ri) {
  const L = history[li], R = history[ri];
  const T = (R.ts - L.ts) / 1000; // seconds
  // Resolved per-index (not per-segment) — see the function comment above.
  const h0Resolved = resolveHeadingAt(history, li);
  const h1Resolved = resolveHeadingAt(history, ri);
  const c0Resolved = resolveCourseAt(history, li);
  const c1Resolved = resolveCourseAt(history, ri);
  // Known iff a heading/course can be RESOLVED for this segment — i.e. either
  // end has a reliably reported value, or can borrow the nearest one
  // (resolveHeadingAt/resolveCourseAt only ever return values from
  // headingReliable reports, and one resolves iff the other does — see
  // bestHeading/bestCourse). Keying off the resolved value rather than the
  // endpoints' OWN reliability is what lets "Hide unreliable heading/course"
  // keep a vessel whose current bracket reports happened to omit cog/hdg but
  // which clearly has a usable course nearby — the icon is drawn along that
  // course, so it mustn't be filtered as headingless.
  const headingKnown = h0Resolved != null || h1Resolved != null;
  const h0 = h0Resolved ?? 0, h1 = h1Resolved ?? 0;
  // COG is meaningless GPS-track noise once a vessel has actually stopped —
  // a moored ship can still report a "valid" (non-zero, <360) but
  // essentially random course each fix, just from position jitter at sog≈0.
  // HDG (gyrocompass-based) stays accurate at any speed, so use it as the
  // course too while not moving — otherwise that per-fix noise becomes the
  // curve's own tangent direction, and "heading" (course + crab) swings
  // arbitrarily between fixes that are really just sitting still.
  const c0 = isShipMoving(L.sog) ? (c0Resolved ?? h0Resolved ?? 0) : (h0Resolved ?? c0Resolved ?? 0);
  const c1 = isShipMoving(R.sog) ? (c1Resolved ?? h1Resolved ?? 0) : (h1Resolved ?? c1Resolved ?? 0);
  // filterState.smoothMotionTension (user-adjustable, "Smooth Motion" legend
  // group) scales the tangent vectors down from the full naive dead-
  // reckoning distance (reported speed × segment time). Reported COG
  // routinely differs from the literal point-to-point bearing by a few
  // degrees — ordinary GPS/AIS noise and leeway, not a real change of
  // direction — but a full-strength tangent commits the curve to that exact
  // (slightly off) direction for a distance comparable to the whole
  // segment, so even a small angular mismatch produces a real, visible
  // bulge. Repeated at every single fix, that's a continuous lateral
  // wiggle along the whole track. Damping the tangent doesn't touch its
  // DIRECTION (course is still exactly c0/c1 at the fixes, like heading) —
  // it just makes the curve let go of that direction sooner and blend
  // toward the next fix, so per-fix noise stays a gentle wobble instead of
  // compounding into a snake. Real turns (a large course change between
  // consecutive fixes, not just noise) still show real curvature — they're
  // damped the same way, just proportionally.
  const TENSION = filterState.smoothMotionTension;
  const v0 = (L.sog ?? 0) * 0.514444 * TENSION; // knots -> m/s
  const v1 = (R.sog ?? 0) * 0.514444 * TENSION;
  const c0Rad = c0 * Math.PI / 180, c1Rad = c1 * Math.PI / 180;
  // Tangent vectors (m/s) at each end, from COURSE+speed — these ARE the
  // curve's velocity at u=0 and u=1 by construction of the Hermite basis
  // used in kinematicPoint.
  const V0N = v0 * Math.cos(c0Rad), V0E = v0 * Math.sin(c0Rad);
  const V1N = v1 * Math.cos(c1Rad), V1E = v1 * Math.sin(c1Rad);
  // R's position, in meters north/east of L — the curve's far endpoint.
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(L.lat * Math.PI / 180) || 1;
  const P1N = (R.lat - L.lat) * M_PER_DEG_LAT, P1E = (R.lon - L.lon) * mPerDegLon;
  // Heading-vs-course "crab" offset at each end, and the shortest signed
  // delta between them — lerping this (in kinematicPoint) and adding it to
  // the curve's live course is what pins heading exactly to h0/h1 at the
  // fixes while still tracking the curve's own rotation in between.
  const crab0 = angleDiff(c0, h0);
  const crab1 = angleDiff(c1, h1);
  const crabDelta = angleDiff(crab0, crab1);
  return { L, T, P1N, P1E, V0N, V0E, V1N, V1E, h0, h1, c0, c1, crab0, crabDelta, headingKnown };
}

// Cubic Hermite basis (and its derivative) for parameter u in [0,1].
function hermiteBasis(u) {
  const u2 = u * u, u3 = u2 * u;
  return {
    p0: 2 * u3 - 3 * u2 + 1, m0: u3 - 2 * u2 + u,
    p1: -2 * u3 + 3 * u2, m1: u3 - u2,
  };
}
function hermiteBasisDeriv(u) {
  const u2 = u * u;
  return {
    p0: 6 * u2 - 6 * u, m0: 3 * u2 - 4 * u + 1,
    p1: -6 * u2 + 6 * u, m1: 3 * u2 - 2 * u,
  };
}

// Position + course + heading at fraction `frac` (0..1) of the L→R segment
// — the curve from buildSegment, evaluated at u=frac. Tangents are scaled
// by T (seconds) since the Hermite basis assumes a unit parameter range
// while V0/V1 are rates per second; dividing back by T below recovers
// `course` as the curve's actual instantaneous direction of travel — i.e.
// course changes at exactly the rate the path itself curves, not on a
// separate schedule, and is exactly c0/c1 right at L and R. `heading` (the
// bow's drawn orientation) is that same course plus the interpolated crab
// offset, so it's exactly h0/h1 at L and R for the same reason.
function kinematicPoint(L, R, frac, seg) {
  if (seg.T <= 0) return { lat: L.lat, lon: L.lon, heading: seg.h0, course: seg.c0, headingKnown: seg.headingKnown };
  const u = Math.min(1, Math.max(0, frac));
  const b = hermiteBasis(u);
  const posN = b.m0 * seg.T * seg.V0N + b.p1 * seg.P1N + b.m1 * seg.T * seg.V1N;
  const posE = b.m0 * seg.T * seg.V0E + b.p1 * seg.P1E + b.m1 * seg.T * seg.V1E;
  const [lat, lon] = destFromDisplacement(seg.L.lat, seg.L.lon, posN, posE);

  // When BOTH ends report ~0 speed, any P1N/P1E displacement between them is
  // pure GPS position jitter (a moored ship's antenna fix wobbling by a few
  // meters), not real travel — letting that drive `course` via the
  // derivative below would turn that noise into an arbitrarily swinging
  // heading mid-segment for a vessel that's actually just sitting still
  // (it's pinned correctly exactly at the fixes regardless, since the
  // tangent terms vanish there — only strictly between them does the noise
  // leak in). Skip the derivative entirely in that case.
  const stoppedBoth = Math.hypot(seg.V0N, seg.V0E) < 1e-6 && Math.hypot(seg.V1N, seg.V1E) < 1e-6;
  let course;
  if (stoppedBoth) {
    course = u < 0.5 ? seg.c0 : seg.c1;
  } else {
    const d = hermiteBasisDeriv(u);
    const velN = (d.m0 * seg.T * seg.V0N + d.p1 * seg.P1N + d.m1 * seg.T * seg.V1N) / seg.T;
    const velE = (d.m0 * seg.T * seg.V0E + d.p1 * seg.P1E + d.m1 * seg.T * seg.V1E) / seg.T;
    // Falls back to the nearest endpoint's course when the ship isn't moving
    // (zero tangent — e.g. stopped at both ends), where direction-of-travel
    // is undefined.
    course = Math.hypot(velN, velE) > 1e-6
      ? (Math.atan2(velE, velN) * 180 / Math.PI + 360) % 360
      : (u < 0.5 ? seg.c0 : seg.c1);
  }
  const crab = seg.crab0 + seg.crabDelta * u;
  const heading = (course + crab + 360) % 360;
  return { lat, lon, heading, course, headingKnown: seg.headingKnown };
}

// The ship's state as it was at targetTs. At a real report instant (frac=0
// or 1) this is exactly that report's position and cog (falling back to
// heading) — between reports it's eased along the kinematic arc above, with
// speed linearly lerped. Position is held at the nearest known report (not
// extrapolated) when targetTs falls outside the stored history, i.e.
// "assume it hasn't moved" for sparsely-reporting/non-moving targets.
export function historicalState(ship, targetTs, lengthM) {
  const history = ship.history;
  if (!history || !history.length) return null;
  const [li, ri] = findBracket(history, targetTs);
  const L = history[li], R = history[ri];
  let lat = L.lat, lon = L.lon;
  let heading = resolveHeadingAt(history, li);
  let course = resolveCourseAt(history, li);
  // Known when a heading/course resolves (own or borrowed from the nearest
  // reliable report) — see buildSegment for why this keys off the resolved
  // value, not L's own headingReliable flag.
  let headingKnown = heading != null;
  let sog = L.sog;
  if (li !== ri) {
    const span = R.ts - L.ts;
    const frac = span > 0 ? (targetTs - L.ts) / span : 0;
    const seg = buildSegment(history, li, ri);
    const pt = kinematicPoint(L, R, frac, seg);
    lat = pt.lat; lon = pt.lon; heading = pt.heading; course = pt.course; headingKnown = pt.headingKnown;
    sog = lerp(L.sog ?? 0, R.sog ?? 0, frac);
  }
  // Duration of the segment currently being interpolated (L→R) — the
  // interval actually in use for the displayed position right now. Falls
  // back to the gap before L when clamped to a single point (no active
  // segment), or null if there isn't one either (e.g. only one report ever).
  const intervalSec = li !== ri
    ? (R.ts - L.ts) / 1000
    : (li > 0 ? (history[li].ts - history[li - 1].ts) / 1000 : null);
  // How far targetTs has run past the newest known report (0 if it hasn't).
  // Positive only in the "ran out of future data" case, not when targetTs
  // is merely clamped to a too-young history (overrunSec stays 0 since
  // targetTs <= the latest report's ts in that case).
  const newest = history[history.length - 1];
  const overrunSec = Math.max(0, (targetTs - newest.ts) / 1000);
  // hdg = the (interpolated) bow orientation; cog = the (interpolated)
  // course/track — kept distinct (unlike a previous version, which merged
  // them into one value) so the icon's body and its speed-dot trail can
  // each follow the right one, exactly like live mode does. When neither
  // bracket report had a reliable reading, keep both null so filters like
  // "Hide unreliable heading/course" still treat it as unknown instead of
  // seeing the 0° fallback used internally for the math.
  const headingOut = headingKnown ? heading : null;
  const courseOut = headingKnown ? course : null;
  return {
    data: { lat, lon, sog, cog: courseOut, hdg: headingOut, navStatus: L.navStatus, declination: L.declination, ts: L.ts },
    intervalSec,
    overrunSec,
  };
}

function removeAheadLine(ship) {
  if (ship.smoothAheadLine) { ship.smoothAheadLine.remove(); ship.smoothAheadLine = null; }
  if (ship.smoothAheadMarks) { for (const m of ship.smoothAheadMarks) m.remove(); ship.smoothAheadMarks = null; }
}

function removePastTrail(ship) {
  if (ship.smoothPastLine) { ship.smoothPastLine.remove(); ship.smoothPastLine = null; }
  if (ship.smoothPastMarks) { for (const m of ship.smoothPastMarks) m.remove(); ship.smoothPastMarks = null; }
}

function snapToLatest(mmsi, ship) {
  const d = ship.data;
  // Re-render the icon at the LIVE heading/course. While smooth motion was on,
  // the loop pointed it along the lagged/interpolated track — which no longer
  // matches the now-current position — so restore the live orientation the
  // same way the live-mode message handler does.
  const sd = staticData.get(mmsi);
  const { heading } = resolveHeading(d.cog, d.hdg, d.declination, ship.lastGoodHeading);
  const dotAngle = !cogBad(d.cog) ? d.cog : heading;
  // d.lat/d.lon already IS the hull's middle (computed once on ingestion —
  // see updateShip in messages.js), so no re-deriving it here.
  ship.middle = [d.lat, d.lon];
  ship.marker.setLatLng(ship.middle);
  ship.marker.setIcon(shipIcon(heading, dotAngle, d.sog, sd?.typeCode, sd?.dim, ship.isFloating));
  updateLabel(mmsi);
  removeAheadLine(ship);
  removePastTrail(ship);
  removeFixCircles(ship);
  // Drop the smooth-loop icon cache so a later re-enable redraws cleanly.
  ship.smoothIconHeading = null;
  ship.smoothIconFloating = null;
}

// Snap a marker to its lagged (smooth-motion) position AND orientation right
// when smooth motion is switched on, rather than leaving the live position/
// rotation in place until the first loop tick (up to 100ms later) repaints it.
function snapToSmooth(mmsi, ship, targetTs) {
  const sd = staticData.get(mmsi);
  const dim = sd?.dim;
  const lengthM = dim ? (dim.A || 0) + (dim.B || 0) : null;
  const snap = historicalState(ship, targetTs, lengthM);
  if (!snap) return;
  const here = [snap.data.lat, snap.data.lon];
  // hdg drives the bow's drawn orientation (fallback: cog, then last known);
  // cog drives the speed-dot trail direction (fallback: whatever heading
  // resolved to) — same split live mode uses, just sourced from the
  // analytic interpolation instead of the latest raw report.
  const headingAngle = snap.data.hdg ?? snap.data.cog ?? ship.lastGoodHeading ?? 0;
  const dotAngle = snap.data.cog ?? headingAngle;
  ship.middle = here;
  ship.marker.setLatLng(ship.middle);
  ship.marker.setIcon(shipIcon(headingAngle, dotAngle, snap.data.sog, sd?.typeCode, dim, ship.isFloating));
  updateLabel(mmsi);
  ship.smoothIconHeading = headingAngle;
  ship.smoothIconFloating = ship.isFloating;
}

export function setSmoothMotionEnabled(enabled) {
  smoothMotionState.enabled = enabled;
  if (enabled) {
    // Snap each marker to its lagged position/orientation now, so the rotation
    // is right from the first frame. The fix circles (ship.fixCircles, shared
    // with the live trail) are reconciled to the smooth window by the loop.
    const targetTs = targetTimestamp();
    for (const [mmsi, ship] of ships) snapToSmooth(mmsi, ship, targetTs);
  } else {
    // Jump every marker back to its true latest position immediately,
    // rather than waiting for the next message to correct it.
    for (const [mmsi, ship] of ships) snapToLatest(mmsi, ship);
  }
  // Add/remove the straight-segment trail to match the new mode (it's
  // replaced by the smooth past line while smooth motion is on).
  refreshAllVisibility?.();
}

export function setSmoothMotionDelta(deltaSec) {
  smoothMotionState.deltaSec = Math.min(MAX_DELTA_SECONDS, Math.max(MIN_DELTA_SECONDS, deltaSec));
}

export function initSmoothMotionControls() {
  const checkbox = document.getElementById('smooth-motion-checkbox');
  const slider = document.getElementById('smooth-motion-slider');
  const label = document.getElementById('smooth-motion-delta-label');

  if (checkbox) {
    // Reflect the (possibly cookie-restored) saved state onto the checkbox,
    // rather than reading the checkbox's static HTML default into state.
    checkbox.checked = smoothMotionState.enabled;
    checkbox.addEventListener('change', (e) => {
      setSmoothMotionEnabled(e.target.checked);
      saveSettings();
    });
  }

  if (slider) {
    setSmoothMotionDelta(smoothMotionState.deltaSec); // clamp in case a saved value is out of range
    slider.value = String(smoothMotionState.deltaSec);
    if (label) label.textContent = `Delta(s): ${smoothMotionState.deltaSec}`;
    slider.addEventListener('input', (e) => {
      setSmoothMotionDelta(parseInt(e.target.value, 10));
      if (label) label.textContent = `Delta(s): ${smoothMotionState.deltaSec}`;
      saveSettings();
    });
  }
}

// Locates a (segment index, fraction) pair for an arbitrary timestamp,
// clamped to the valid range — segIdx always in [0, history.length-2],
// frac always in [0,1]. Used by pastTrackPoints / leadTrackPoints to find the
// window-edge positions on the same turn-then-straight model as the marker.
function timeToSegFrac(history, ts) {
  const last = history.length - 1;
  if (ts <= history[0].ts) return { segIdx: 0, frac: 0 };
  if (ts >= history[last].ts) return { segIdx: last - 1, frac: 1 };
  for (let i = 0; i < last; i++) {
    if (history[i].ts <= ts && ts <= history[i + 1].ts) {
      const span = history[i + 1].ts - history[i].ts;
      return { segIdx: i, frac: span > 0 ? (ts - history[i].ts) / span : 0 };
    }
  }
  return { segIdx: last - 1, frac: 1 };
}

// Traces the EXACT path the marker follows between (start.segIdx,start.frac)
// and (end.segIdx,end.frac), by sampling the same turn-then-straight
// kinematic model (buildSegment/kinematicPoint) the marker itself is driven
// by — rather than fitting a geometric spline through the sparse real fixes,
// which only agrees with the marker at the fixes themselves and can diverge
// visibly from it in between (e.g. across a real, sharp turn the spline has
// no knowledge of). samplesPerSegment is spread proportionally when a
// segment is only partially covered (a window edge mid-segment).
function kinematicRangePoints(history, start, end, lengthM, samplesPerSegment = 16) {
  const pts = [];
  for (let segIdx = start.segIdx; segIdx <= end.segIdx; segIdx++) {
    const fracFrom = segIdx === start.segIdx ? start.frac : 0;
    const fracTo = segIdx === end.segIdx ? end.frac : 1;
    if (fracFrom >= fracTo) continue;
    const seg = buildSegment(history, segIdx, segIdx + 1);
    const n = Math.max(1, Math.round(samplesPerSegment * (fracTo - fracFrom)));
    const L = history[segIdx], R = history[segIdx + 1];
    for (let s = (pts.length ? 1 : 0); s <= n; s++) {
      const frac = fracFrom + (fracTo - fracFrom) * (s / n);
      const p = kinematicPoint(L, R, frac, seg);
      pts.push([p.lat, p.lon]);
    }
  }
  return pts;
}

// The smooth trail BEHIND the marker, covering the last `trailSec` seconds up
// to targetTs. Returns `path`: the EXACT kinematic curve the marker actually
// travelled across that window (see kinematicRangePoints) — not a geometric
// approximation through the sparse real fixes, so it can never show the
// marker having deviated from "where the trail said it was". Also returns
// those reports as `waypoints` (with each one's canonical heading/course)
// for the fix circles and tick marks. Null when there's nothing to draw.
export function pastTrackPoints(ship, targetTs, lengthM, trailSec) {
  const history = ship.history;
  if (!history || history.length < 2 || !trailSec || trailSec <= 0) return null;
  const fromTs = targetTs - trailSec * 1000;
  if (fromTs >= targetTs) return null;

  const start = timeToSegFrac(history, fromTs);
  const end = timeToSegFrac(history, targetTs);
  if (start.segIdx === end.segIdx && start.frac >= end.frac) return null; // no span to draw

  const path = kinematicRangePoints(history, start, end, lengthM);
  const waypoints = [];
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (h.ts >= fromTs && h.ts <= targetTs) {
      waypoints.push({
        ts: h.ts, lat: h.lat, lon: h.lon, sog: h.sog,
        heading: h.headingReliable ? bestHeading(h.cog, h.hdg, h.declination) : null,
        cog: cogBad(h.cog) ? null : h.cog,
      });
    }
  }
  return { path, waypoints };
}

// The smooth track AHEAD of the marker, covering the next `leadSec` seconds
// from targetTs, clamped to the newest known report (the lead never
// extrapolates past data we have). Returns `path`: the EXACT kinematic curve
// the marker will follow from now to the window end (see
// kinematicRangePoints — this is not a geometric approximation, so it can
// never diverge from where the marker actually ends up). `waypoints` are the
// real reports ahead of the marker, for the fix circles / tick marks. Null
// when there's nothing to draw.
export function leadTrackPoints(ship, targetTs, lengthM, leadSec) {
  const history = ship.history;
  if (!history || history.length < 2 || !leadSec || leadSec <= 0) return null;
  const toTs = targetTs + leadSec * 1000;

  const start = timeToSegFrac(history, targetTs);
  const end = timeToSegFrac(history, toTs);
  if (start.segIdx === end.segIdx && start.frac >= end.frac) return null; // no span to draw

  const path = kinematicRangePoints(history, start, end, lengthM);
  // Reports strictly ahead of the marker (ts > targetTs) so a report at the
  // marker isn't drawn on both the past trail and the lead.
  const waypoints = [];
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (h.ts > targetTs && h.ts <= toTs) {
      waypoints.push({
        ts: h.ts, lat: h.lat, lon: h.lon, sog: h.sog,
        heading: h.headingReliable ? bestHeading(h.cog, h.hdg, h.declination) : null,
        cog: cogBad(h.cog) ? null : h.cog,
      });
    }
  }
  return { path, waypoints };
}

// Endpoint of a line from (lat,lon) pointing along `angleDeg` (compass
// bearing) for `lengthM` meters.
function lineEndpoint(lat, lon, angleDeg, lengthM) {
  const rad = angleDeg * Math.PI / 180;
  return destFromDisplacement(lat, lon, lengthM * Math.cos(rad), lengthM * Math.sin(rad));
}
// Endpoint of a short heading tick mark from a waypoint. Length scaled to
// the ship's own size, so it reads sensibly across very different vessel sizes.
function tickEndpoint(lat, lon, angleDeg, lengthM) {
  const tickLenM = lengthM ? Math.min(60, Math.max(15, lengthM * 0.6)) : 25;
  return lineEndpoint(lat, lon, angleDeg, tickLenM);
}

// Length (m) of the cog line, scaled by speed the same way the bow's
// speed-dot trail is (icons.js: SPEED_DOT_SPACING px per knot, halved per
// zoom step below 11) — continuous rather than floored to a dot count,
// since this is a single line rather than discrete dots.
function cogLineLengthM(lat, sog) {
  if (!Number.isFinite(sog) || sog <= 0) return 0;
  const px = (sog / speedDotZoomFactor()) * SPEED_DOT_SPACING;
  const ppm = pixelsPerMeter(lat, map.getZoom());
  return ppm > 0 ? px / ppm : 0;
}

// Opens the same fix popup the persistent circle (reconcileFixCircles) uses,
// but as a standalone map popup rather than one bound to the tick/cog line
// itself — those lines are ephemeral (recreated every frame, see below), so
// a popup bound directly to one would get yanked shut within ~100ms.
function openFixPopupAt(mmsi, ts, latlng) {
  L.popup({ maxWidth: 360 }).setLatLng(latlng).setContent(buildFixPopup(mmsi, ts)).openOn(map);
}

// Draws a fix's heading (dashed tick) and course-over-ground (solid black
// line, length scaled by sog) into `marks` — cheap, ephemeral overlays
// recreated every frame. The fix CIRCLE itself is drawn separately
// (reconcileFixCircles) so it can persist across frames and hold a
// clickable popup; clicking either line opens that same popup content.
// `opacity` lets the lead render fainter.
function pushTicks(marks, wp, lengthM, color, opacity, mmsi) {
  // Reported heading (bow direction) — dashed, fixed length; diverges from
  // cog under leeway/current.
  if (wp.heading != null) {
    const [tLat, tLon] = tickEndpoint(wp.lat, wp.lon, wp.heading, lengthM);
    const tick = L.polyline([[wp.lat, wp.lon], [tLat, tLon]], { color, weight: 1.5, opacity, dashArray: '2,3' }).addTo(map);
    tick.on('click', (e) => openFixPopupAt(mmsi, wp.ts, e.latlng));
    marks.push(tick);
  }
  // Reported course-over-ground — solid black, length scaled by sog. Kept
  // fainter than the heading tick/trail — it's a secondary detail, easily
  // overpowering the line/icon underneath at full trail opacity.
  if (wp.cog != null) {
    const cogLenM = cogLineLengthM(wp.lat, wp.sog);
    if (cogLenM > 0) {
      const [cLat, cLon] = lineEndpoint(wp.lat, wp.lon, wp.cog, cogLenM);
      const cogLine = L.polyline([[wp.lat, wp.lon], [cLat, cLon]], { color: 'black', weight: 3, opacity: opacity * 0.5 }).addTo(map);
      cogLine.on('click', (e) => openFixPopupAt(mmsi, wp.ts, e.latlng));
      marks.push(cogLine);
    }
  }
}

// ── Clickable fix circles ──────────────────────────────────────────────────
// One circle per real AIS report on the trail/lead, kept ALIVE across frames
// (keyed by report timestamp) — recreating them every 100ms like the ticks
// would slam any popup shut the instant it opened. Each circle's popup shows
// the report's identity, raw AIS cog/hdg, position, and the time/distance gaps
// to the two fixes on either side.
function popupRow(label, value) {
  return `<div class="popup-row"><span class="popup-label">${label}</span><span class="popup-value">${value}</span></div>`;
}
function warn(text) {
  return `<span class="popup-warn">${text}</span>`;
}
export function haversineNM(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const φ1 = aLat * Math.PI / 180, φ2 = bLat * Math.PI / 180;
  const dφ = (bLat - aLat) * Math.PI / 180, dλ = (bLon - aLon) * Math.PI / 180;
  const x = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x)) / 1852;
}
export function fmtNM(nm) {
  const r = Math.round(nm * 10) / 10;
  return Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1);
}
// `[<seconds>s/<distance>NM]` between history fixes a and b, or '' if either
// index is out of range (near the ends of the stored history).
function fixGap(history, a, b) {
  if (a < 0 || b < 0 || a >= history.length || b >= history.length) return '';
  const dt = Math.round((history[b].ts - history[a].ts) / 1000);
  const nm = haversineNM(history[a].lat, history[a].lon, history[b].lat, history[b].lon);
  return `[${dt}s/${fmtNM(nm)}NM]`;
}
// The time/distance gaps around fix `idx` — outer→inner before THIS, then
// inner→outer after, e.g. "[52s/0.4NM][24s/2NM] THIS [54s/2.5NM][108s/5NM]".
function adjacentFixGaps(history, idx) {
  return `${fixGap(history, idx - 2, idx - 1)}${fixGap(history, idx - 1, idx)} THIS ${fixGap(history, idx, idx + 1)}${fixGap(history, idx + 1, idx + 2)}`;
}
// The 4 intervals leading up to fix `idx`, then THIS — oldest on the left,
// e.g. "[55s/2.8NM][60s/3NM][108s/5NM][54s/2.5NM] THIS".
function previousFixGaps(history, idx) {
  return `${fixGap(history, idx - 4, idx - 3)}${fixGap(history, idx - 3, idx - 2)}${fixGap(history, idx - 2, idx - 1)}${fixGap(history, idx - 1, idx)} THIS`;
}
// Used by the AIS Fixes side panel (fixesPanel.js), which lists ALL of a
// selected vessel's stored fixes for inspection — unbounded by the
// trail/lead sliders (as if no trail were set at all) and independent of
// the separate "Show AIS fixes" toggle (filterState.showFixes only controls
// the on-map circles). Still requires the vessel itself be currently shown,
// same as the map's own fix circles.
export function isFixInPanelRange(ship) {
  return ship.onMap;
}

// The fix-gap line for a whole ship, showing the 4 intervals BEFORE the fix
// at/just before the instant the marker is currently showing (live → now,
// smooth motion → the lagged instant).
export function shipFixGaps(mmsi) {
  const ship = ships.get(mmsi);
  if (!ship?.history?.length) return '';
  const instant = smoothMotionState.enabled ? targetTimestamp() : Date.now();
  let idx = 0;
  for (let i = 0; i < ship.history.length; i++) {
    if (ship.history[i].ts <= instant) idx = i; else break;
  }
  return previousFixGaps(ship.history, idx);
}
export function buildFixPopup(mmsi, ts) {
  const ship = ships.get(mmsi);
  if (!ship || !ship.history) return '';
  const history = ship.history;
  const idx = history.findIndex((h) => h.ts === ts);
  if (idx < 0) return '';
  const f = history[idx];
  const sd = staticData.get(mmsi);
  const name = sd?.name || ship.data?.name || '—';
  // Same format as the vessel popup (popup.js): raw HDG is magnetic, not
  // true north — only show/use it as a heading once corrected by
  // declination, never bare. usesHdg/usesCog mirror which one the icon's
  // rotation would actually be drawn from for this fix.
  const bh = bestHeading(f.cog, f.hdg, f.declination);
  const usesHdg = bh != null && !hdgBad(f.hdg);
  const usesCog = bh != null && hdgBad(f.hdg) && !cogBad(f.cog);
  const cogStr = cogBad(f.cog) ? `${f.cog != null ? f.cog.toFixed(1) : '—'} (n/a)` : `${f.cog.toFixed(1)}°${usesCog ? ' ← rotation' : ''}`;
  const hdgVal = f.hdg === 511 ? '0x1FF (n/a)' : (f.hdg === 0 || f.hdg === 360) ? `${f.hdg.toFixed(1)} (unreliable)` : f.hdg != null ? `${f.hdg.toFixed(1)}°` : '—';
  const decStr = f.declination != null ? `${f.declination > 0 ? '+' : ''}${f.declination}°` : '—';
  const corrected = usesHdg && f.declination != null
    ? ` → ${((f.hdg + f.declination + 360) % 360).toFixed(1)}° true` : '';
  const hdgStr = `${hdgVal}${corrected}${usesHdg ? ' ← rotation' : ''}`;
  const navLabel = NAV_STATUS[f.navStatus] ?? 'Unknown';
  const navUnreliable = navStatusUnreliable(f.sog, f.navStatus);
  return `
    <div class="popup-name">${name}</div>
    ${popupRow('MMSI', mmsi)}
    ${popupRow('Fix time', new Date(f.ts).toISOString())}
    ${popupRow('Speed', `${f.sog != null ? f.sog.toFixed(1) : '—'} kn`)}
    ${popupRow('Course', cogStr)}
    ${popupRow('Heading (mag.)', hdgStr)}
    <div class="legend-hint">Map ticks: solid black = COG, dashed = HDG</div>
    ${popupRow('Mag. decl.', decStr)}
    ${popupRow('Nav status', `${f.navStatus} (${navLabel})${navUnreliable ? ' ' + warn('⚠ unreliable (sog ≥ 0.5kn)') : ''}`)}
    ${popupRow('Position (middle)', `lat=${f.lat.toFixed(5)} lon=${f.lon.toFixed(5)}`)}
    <div class="popup-fixgaps"><span class="popup-label">Fix intervals</span><br>${adjacentFixGaps(history, idx)}</div>
  `;
}
// Reconcile a ship's persistent, clickable fix circles against the set of
// fixes (ts → {lat,lon,opacity}) currently in view. Adds new ones (with a
// popup), removes departed ones, and restyles survivors — leaving an open popup
// untouched as long as its fix stays in view. Shared by both modes: the
// smooth-motion loop drives it for the lagged trail+lead, and the live trail
// (visibility.js) drives it for the real-time fixes.
export function reconcileFixCircles(ship, mmsi, fixSet, color) {
  if (!ship.fixCircles) ship.fixCircles = new Map();
  const cur = ship.fixCircles;
  for (const [ts, m] of cur) {
    if (!fixSet.has(ts)) { m.remove(); cur.delete(ts); }
  }
  for (const [ts, info] of fixSet) {
    let m = cur.get(ts);
    if (!m) {
      // fill (transparent) so the whole disc is clickable, not just the ring.
      m = L.circleMarker([info.lat, info.lon], {
        radius: 4, color, weight: 1.5, opacity: info.opacity, fill: true, fillColor: color, fillOpacity: 0,
      });
      m.bindPopup(() => buildFixPopup(mmsi, ts), { maxWidth: 360 });
      m.addTo(map);
      cur.set(ts, m);
    } else {
      m.setStyle({ color, fillColor: color, opacity: info.opacity });
      if (!map.hasLayer(m)) m.addTo(map);
    }
  }
}
export function removeFixCircles(ship) {
  if (ship.fixCircles) {
    for (const m of ship.fixCircles.values()) m.remove();
    ship.fixCircles.clear();
  }
}

export const PAST_TRAIL_OPACITY = 0.45; // the observed (smoothed) past track
export const LEAD_TRAIL_OPACITY = 0.2;  // more transparent than the past — it's a projection, not where the ship has been

// While the user is actively dragging/zooming the map, Leaflet repositions
// everything already on the map for free (a single CSS transform on the
// shared panes) — no per-layer work needed. The expensive part is this
// loop's own per-ship work below (marker/icon/trail/tick/fix-circle
// updates, 10x/second, for every ship), which keeps running regardless of
// interaction and competes with the browser for the same frame budget,
// which is exactly when it's most visible as jank. So: do none of that
// work at all while interacting — every position is a pure function of
// elapsed real time (no per-tick accumulation), so nothing drifts; it
// simply resumes exactly where it should be the instant the gesture ends.
let interacting = false;
map.on('movestart zoomstart', () => { interacting = true; });
map.on('moveend zoomend', () => { interacting = false; });

// AIS-fix circles (and their popups) are real interactive layers, each
// independently positioned by Leaflet — hidden outright while panning so
// there's nothing for Leaflet to reposition/repaint per fix per ship during
// the drag, not just visually faded. Restored the instant the gesture ends,
// before the next loop tick even runs (which would otherwise recreate them).
function setAllFixCirclesHidden(hidden) {
  for (const ship of ships.values()) {
    if (!ship.fixCircles) continue;
    for (const m of ship.fixCircles.values()) {
      if (hidden && map.hasLayer(m)) m.remove();
      else if (!hidden && !map.hasLayer(m)) m.addTo(map);
    }
  }
}
map.on('movestart zoomstart', () => setAllFixCirclesHidden(true));
map.on('moveend zoomend', () => setAllFixCirclesHidden(false));

// Updates marker positions 10x/second while smooth motion is on, so motion
// looks continuous rather than ticking once per second. Also draws, ahead of
// the marker, the planned "lead" track for the next `getLeadSec()`
// seconds (clamped to the data we have) — plus, behind the marker, the smooth
// (kinematic) trail for the last `getTrailSec()` seconds. Along BOTH, a circle
// marks each real AIS report, with a solid heading tick and a dashed course
// tick. Both lines use the vessel's category (or spoof) colour — the same
// colour as the live-mode trail — with the lead drawn more transparently.
export function startSmoothMotionLoop(getTrailSec, getLeadSec, getShowFixes) {
  setInterval(() => {
    if (!smoothMotionState.enabled || interacting) return;
    const targetTs = targetTimestamp();
    for (const [mmsi, ship] of ships) {
      const sd = staticData.get(mmsi);
      const dim = sd?.dim;
      const lengthM = dim ? (dim.A || 0) + (dim.B || 0) : null;
      const snap = historicalState(ship, targetTs, lengthM);
      if (!snap) continue;
      const here = [snap.data.lat, snap.data.lon];
      // `here` is already the hull's middle (historicalState interpolates
      // between history points stored as the middle).
      ship.middle = here;
      ship.marker.setLatLng(ship.middle);
      updateLabel(mmsi);

      // hdg drives the bow's drawn orientation (fallback: cog, then the
      // icon's last drawn heading); cog drives the speed-dot trail direction
      // (fallback: whatever heading resolved to) — same split live mode
      // uses. Both are now the curve's own exact analytic values (see
      // kinematicPoint) rather than a frame-to-frame bearing estimate — a
      // previous version derived heading from the position delta between
      // animation ticks instead, as a workaround for the old dead-reckoning
      // model's heading not reliably matching its own drawn path; the
      // Hermite curve here doesn't have that mismatch; its heading already
      // IS the path's tangent (plus the heading/course crab offset).
      const headingAngle = snap.data.hdg ?? snap.data.cog ?? ship.smoothIconHeading ?? ship.lastGoodHeading ?? 0;
      const dotAngle = snap.data.cog ?? headingAngle;

      // setIcon() replaces the marker's DOM element — doing that every 100ms
      // raced with click handling and broke popups. Only redraw when the
      // heading has actually moved enough to notice, or floating changed.
      const headingChanged = ship.smoothIconHeading == null
        || Math.abs(angleDiff(ship.smoothIconHeading, headingAngle)) > 2;
      if (headingChanged || ship.smoothIconFloating !== ship.isFloating) {
        ship.marker.setIcon(shipIcon(headingAngle, dotAngle, snap.data.sog, sd?.typeCode, dim, ship.isFloating));
        ship.smoothIconHeading = headingAngle;
        ship.smoothIconFloating = ship.isFloating;
      }

      const trailColor = ship.trail.options.color;
      // Real fixes (both trail and lead) get a persistent, clickable circle and
      // heading/course ticks — but only when "Show AIS Fixes" is on. Gather the
      // circle set here and reconcile once after drawing both lines (an empty
      // set removes any that were showing).
      const showFixes = getShowFixes ? getShowFixes() : false;
      const fixSet = new Map();

      const leadSec = getLeadSec ? getLeadSec() : 0;
      const lead = ship.onMap ? leadTrackPoints(ship, targetTs, lengthM, leadSec) : null;
      if (lead) {
        const leadLine = lead.path;
        if (!ship.smoothAheadLine) {
          ship.smoothAheadLine = L.polyline(leadLine, { color: trailColor, weight: 1.5, opacity: LEAD_TRAIL_OPACITY }).addTo(map);
        } else {
          ship.smoothAheadLine.setLatLngs(leadLine);
          ship.smoothAheadLine.setStyle({ color: trailColor });
          if (!map.hasLayer(ship.smoothAheadLine)) ship.smoothAheadLine.addTo(map);
        }
        // Heading/course ticks (ephemeral); circles handled by reconcile below.
        if (ship.smoothAheadMarks) for (const m of ship.smoothAheadMarks) m.remove();
        ship.smoothAheadMarks = [];
        if (showFixes) for (const wp of lead.waypoints) {
          pushTicks(ship.smoothAheadMarks, wp, lengthM, trailColor, LEAD_TRAIL_OPACITY, mmsi);
          fixSet.set(wp.ts, { lat: wp.lat, lon: wp.lon, opacity: LEAD_TRAIL_OPACITY });
        }
      } else {
        removeAheadLine(ship);
      }

      const trailSec = getTrailSec ? getTrailSec() : 0;
      const past = ship.onMap ? pastTrackPoints(ship, targetTs, lengthM, trailSec) : null;
      if (past) {
        const pastLine = past.path;
        if (!ship.smoothPastLine) {
          ship.smoothPastLine = L.polyline(pastLine, { color: trailColor, weight: 1.5, opacity: PAST_TRAIL_OPACITY }).addTo(map);
        } else {
          ship.smoothPastLine.setLatLngs(pastLine);
          ship.smoothPastLine.setStyle({ color: trailColor });
          if (!map.hasLayer(ship.smoothPastLine)) ship.smoothPastLine.addTo(map);
        }
        if (ship.smoothPastMarks) for (const m of ship.smoothPastMarks) m.remove();
        ship.smoothPastMarks = [];
        if (showFixes) for (const wp of past.waypoints) {
          pushTicks(ship.smoothPastMarks, wp, lengthM, trailColor, PAST_TRAIL_OPACITY, mmsi);
          fixSet.set(wp.ts, { lat: wp.lat, lon: wp.lon, opacity: PAST_TRAIL_OPACITY });
        }
      } else {
        removePastTrail(ship);
      }

      // fixSet only ever contains waypoints from the lead/past windows above
      // (both gated on ship.onMap) — so a fix only ever shows up here when
      // the vessel is currently shown AND its age falls between
      // delta-lead and delta+trail. No exception for the newest real
      // report: if it falls outside both windows, it simply doesn't get a
      // circle, same as any other out-of-range fix.
      reconcileFixCircles(ship, mmsi, fixSet, trailColor);
    }
  }, 100);
}
