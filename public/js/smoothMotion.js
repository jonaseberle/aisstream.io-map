import { map } from './map.js';
import { ships, staticData } from './state.js';
import { shipIcon } from './icons.js';
import { bestHeading, cogBad, hdgBad, resolveHeading } from './heading.js';

// "Smooth motion" trades immediacy for smoothness: instead of snapping each
// marker to its latest reported position the instant a message arrives, it
// displays — and filters — the vessel state DELTA seconds in the past. At
// each real report it shows exactly that report's position and cog/heading;
// between reports it dead-reckons along a circular arc sized by the ship's
// realistic turning ability, corrected to land exactly on the next report.
export const MIN_DELTA_SECONDS = 60;
export const MAX_DELTA_SECONDS = 1200;
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
// Realistic rate-of-turn heuristic: bigger ships turn slower at sea speed —
// but at harbour/maneuvering speeds (<10kts, tugs/thrusters/slow-speed
// handling) any ship can pivot much tighter, so the cap ramps up sharply as
// speed drops. Used only as a plausibility check (see below), not a hard
// cap — landing exactly on the next real report at the right time always wins.
//
// Baseline (sea-speed, hard-rudder) rate of turn by length is calibrated
// against typical reported figures — large vessels (250m+) generally turn at
// roughly 0.3-0.5 deg/s at speed, mid-size (~100m) around 1-1.5 deg/s, and
// small craft (<30m) several deg/s up to tens of deg/s for very small/fast
// boats — then scaled by 1.5x as a margin, since this is only a sanity check.
function maxTurnRateDegPerSec(lengthM, speedKn) {
  const L = lengthM && lengthM > 0 ? lengthM : 50; // assume mid-size when unknown
  const base = Math.min(10, Math.max(0.4, 150 / L)) * 1.5;
  if (speedKn == null || speedKn >= 10) return base;
  const boost = 1 + 7 * (1 - speedKn / 10); // 1x at 10kts -> 8x near dead slow
  return Math.min(60, base * boost);
}

// Shortest signed angle from a to b, in (-180, 180].
function angleDiff(a, b) {
  return ((b - a + 540) % 360) - 180;
}

// Resolves a single canonical heading for history[index], independent of
// which neighboring segment is asking. If the point's own heading isn't
// reliable, carries the nearest reliable heading forward from before it (or,
// failing that, backward from after it) — the SAME resolution every time,
// so the segment ending at this point and the segment starting from it
// always agree exactly. Without this, each segment fell back independently
// (e.g. L→R borrowing L's heading, R→R2 borrowing R2's heading, for the same
// unreliable point R), producing a visible kink/jump right at that node.
function resolveHeadingAt(history, index) {
  const pt = history[index];
  if (pt.headingReliable) {
    const h = bestHeading(pt.cog, pt.hdg, pt.declination);
    if (h != null) return h;
  }
  for (let i = index - 1; i >= 0; i--) {
    if (history[i].headingReliable) {
      const h = bestHeading(history[i].cog, history[i].hdg, history[i].declination);
      if (h != null) return h;
    }
  }
  for (let i = index + 1; i < history.length; i++) {
    if (history[i].headingReliable) {
      const h = bestHeading(history[i].cog, history[i].hdg, history[i].declination);
      if (h != null) return h;
    }
  }
  return null;
}

const M_PER_DEG_LAT = 111320;

// Initial bearing from (lat1,lon1) to (lat2,lon2), in degrees clockwise from north.
function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Displacement (north/east meters) of a straight run at speed v (m/s),
// heading hRad, over duration t (s).
function straightDisplacement(v, hRad, t) {
  return [v * Math.cos(hRad) * t, v * Math.sin(hRad) * t];
}
function destFromDisplacement(lat, lon, dN, dE) {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180) || 1;
  return [lat + dN / M_PER_DEG_LAT, lon + dE / mPerDegLon];
}

// Smooth ease-in/ease-out (zero rate at both ends) — used for the turn so it
// blends seamlessly into the straight runs on either side instead of
// kinking sharply at the join, like a ship gradually applying (and easing
// off) rudder rather than snapping to a new heading.
function smoothstep(x) {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

const TURN_TABLE_STEPS = 16;

// Numerically integrates position (cumulative north/east meters from the
// turn's start) across the eased turn, sampled at TURN_TABLE_STEPS points —
// the eased heading has no simple closed-form position integral, unlike a
// constant-rate turn or a straight run.
function buildTurnTable(vAvg, h0, dh, turnDuration) {
  const table = [{ t: 0, dN: 0, dE: 0 }];
  if (turnDuration <= 0) return table;
  let dN = 0, dE = 0;
  const dt = turnDuration / TURN_TABLE_STEPS;
  for (let i = 1; i <= TURN_TABLE_STEPS; i++) {
    const tMid = (i - 0.5) * dt;
    const headingMid = h0 + dh * smoothstep(tMid / turnDuration);
    const rad = headingMid * Math.PI / 180;
    dN += vAvg * Math.cos(rad) * dt;
    dE += vAvg * Math.sin(rad) * dt;
    table.push({ t: i * dt, dN, dE });
  }
  return table;
}
// Interpolates the turn table for any t within [0, turnDuration].
function sampleTurnTable(table, t) {
  const last = table[table.length - 1];
  if (t <= 0) return table[0];
  if (t >= last.t) return last;
  for (let i = 1; i < table.length; i++) {
    if (table[i].t >= t) {
      const a = table[i - 1], b = table[i];
      const span = b.t - a.t;
      const f = span > 0 ? (t - a.t) / span : 0;
      return { dN: a.dN + (b.dN - a.dN) * f, dE: a.dE + (b.dE - a.dE) * f };
    }
  }
  return last;
}

// Precomputes a "turn then straight" model for the L→R segment: the ship
// eases from heading h0 to h1 over a realistic-for-its-size turn (bounded by
// maxTurnRateDegPerSec, but spread over a generous chunk of the segment, not
// crammed into an instant), then travels straight on the new heading for the
// remainder — a continuous, kink-free curve rather than two straight lines
// joined by a sharp corner. If the turn itself needs the whole segment, there
// is no straight part. The dead-reckoned endpoint corrects the position so
// it lands exactly on R at frac=1 regardless.
function buildSegment(history, li, ri, lengthM) {
  const L = history[li], R = history[ri];
  const T = (R.ts - L.ts) / 1000; // seconds
  // Resolved per-index (not per-segment), so the segment ending at a point
  // and the segment starting from it always agree on its heading exactly —
  // see resolveHeadingAt for why that matters.
  const h0Resolved = resolveHeadingAt(history, li);
  const h1Resolved = resolveHeadingAt(history, ri);
  // Known iff a heading can be RESOLVED for this segment — i.e. either end has
  // a reliably reported heading, or can borrow the nearest one (resolveHeadingAt
  // only ever returns headings from headingReliable reports). Keying off the
  // resolved value rather than the endpoints' OWN reliability is what lets
  // "Hide unreliable heading/course" keep a vessel whose current bracket reports
  // happened to omit cog/hdg but which clearly has a usable course nearby — the
  // icon is drawn along that course, so it mustn't be filtered as headingless.
  // Synthesized history (restored ships, whose per-point cog/hdg are derived
  // from position deltas with headingReliable=false) still resolves to null and
  // stays filtered, since resolveHeadingAt ignores unreliable points.
  const headingKnown = h0Resolved != null || h1Resolved != null;
  // h1Resolved can only be null when h0Resolved is too (resolveHeadingAt
  // searches the whole history both ways), so no need for a cross-fallback here.
  const h0 = h0Resolved ?? 0;
  const h1 = h1Resolved ?? 0;
  const dh = angleDiff(h0, h1); // signed, shortest turn from h0 to h1
  const avgSogKn = ((L.sog ?? 0) + (R.sog ?? 0)) / 2;
  const vAvg = avgSogKn * 0.514444; // knots -> m/s

  const turnRateMax = maxTurnRateDegPerSec(lengthM, avgSogKn);
  const minTurnDuration = T > 0 ? Math.abs(dh) / Math.max(turnRateMax, 0.01) : 0;
  // Use at least 30% of the segment for the turn (a real, visible maneuver)
  // even when the physically-required minimum is much shorter — but never
  // less than that minimum, and never more than the whole segment.
  const turnDuration = T > 0 ? Math.min(T, Math.max(minTurnDuration, T * 0.3)) : 0;
  const h1Rad = h1 * Math.PI / 180;

  const turnTable = buildTurnTable(vAvg, h0, dh, turnDuration);
  const turnEnd = turnTable[turnTable.length - 1];
  const [midLat, midLon] = destFromDisplacement(L.lat, L.lon, turnEnd.dN, turnEnd.dE);
  const [dNStraight, dEStraight] = straightDisplacement(vAvg, h1Rad, T - turnDuration);
  const [arcEndLat, arcEndLon] = destFromDisplacement(midLat, midLon, dNStraight, dEStraight);

  return { T, h0, h1, dh, h1Rad, turnDuration, vAvg, turnTable, midLat, midLon, arcEndLat, arcEndLon, headingKnown };
}

// Position + heading at fraction `frac` (0..1) of the L→R segment.
function kinematicPoint(L, R, frac, seg) {
  const t = frac * seg.T;
  let lat, lon, heading;
  if (t <= seg.turnDuration) {
    const turnFrac = seg.turnDuration > 0 ? t / seg.turnDuration : 1;
    heading = seg.h0 + seg.dh * smoothstep(turnFrac); // lands exactly on h1 by turnDuration
    const s = sampleTurnTable(seg.turnTable, t);
    [lat, lon] = destFromDisplacement(L.lat, L.lon, s.dN, s.dE);
  } else {
    heading = seg.h1;
    const [dN, dE] = straightDisplacement(seg.vAvg, seg.h1Rad, t - seg.turnDuration);
    [lat, lon] = destFromDisplacement(seg.midLat, seg.midLon, dN, dE);
  }
  // Blend in the residual error between the idealized turn-then-straight
  // path and the real next report, so we still land exactly on R at frac=1.
  lat += (R.lat - seg.arcEndLat) * frac;
  lon += (R.lon - seg.arcEndLon) * frac;
  return { lat, lon, heading, headingKnown: seg.headingKnown };
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
  // Known when a heading resolves (own or borrowed from the nearest reliable
  // report) — see buildSegment for why this keys off the resolved value, not
  // L's own headingReliable flag.
  let headingKnown = heading != null;
  let sog = L.sog;
  if (li !== ri) {
    const span = R.ts - L.ts;
    const frac = span > 0 ? (targetTs - L.ts) / span : 0;
    const seg = buildSegment(history, li, ri, lengthM);
    const pt = kinematicPoint(L, R, frac, seg);
    lat = pt.lat; lon = pt.lon; heading = pt.heading; headingKnown = pt.headingKnown;
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
  // cog and hdg both carry the same interpolated heading — at this point
  // there's no longer a meaningful difference between the two to preserve.
  // When neither bracket report had a reliable heading, keep both null so
  // filters like "Hide unreliable heading/course" still treat it as unknown
  // instead of seeing the 0° fallback used internally for the math.
  const headingOut = headingKnown ? heading : null;
  return {
    data: { lat, lon, sog, cog: headingOut, hdg: headingOut, navStatus: L.navStatus, declination: L.declination, ts: L.ts },
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
  ship.marker.setLatLng([d.lat, d.lon]);
  // Re-render the icon at the LIVE heading/course. While smooth motion was on,
  // the loop pointed it along the lagged/interpolated track — which no longer
  // matches the now-current position — so restore the live orientation the
  // same way the live-mode message handler does.
  const sd = staticData.get(mmsi);
  const { heading } = resolveHeading(d.cog, d.hdg, d.declination, ship.lastGoodHeading);
  const dotAngle = !cogBad(d.cog) ? d.cog : heading;
  ship.marker.setIcon(shipIcon(heading, dotAngle, d.sog, sd?.typeCode, sd?.dim, ship.isFloating));
  removeAheadLine(ship);
  removePastTrail(ship);
  removeFixCircles(ship);
  // Clear frame-to-frame heading tracking so re-enabling doesn't briefly use
  // a bearing computed against a now-stale previous position, and drop the
  // smooth-loop icon cache so a later re-enable redraws cleanly.
  ship.smoothPrevLatLng = null;
  ship.smoothLastHeading = null;
  ship.smoothIconHeading = null;
  ship.smoothIconFloating = null;
}

// Snap a marker to its lagged (smooth-motion) position AND orientation right
// when smooth motion is switched on, rather than leaving the live position/
// rotation in place until the first loop tick (up to 100ms later) repaints it.
// Seeds the loop's frame-to-frame heading tracking so it carries on smoothly.
function snapToSmooth(mmsi, ship, targetTs) {
  const sd = staticData.get(mmsi);
  const dim = sd?.dim;
  const lengthM = dim ? (dim.A || 0) + (dim.B || 0) : null;
  const snap = historicalState(ship, targetTs, lengthM);
  if (!snap) return;
  const here = [snap.data.lat, snap.data.lon];
  ship.marker.setLatLng(here);
  // No previous frame to derive a bearing from yet — use the interpolated
  // course at targetTs (falling back to the last known heading).
  const heading = snap.data.cog ?? ship.smoothLastHeading ?? ship.lastGoodHeading ?? 0;
  ship.marker.setIcon(shipIcon(heading, heading, snap.data.sog, sd?.typeCode, dim, ship.isFloating));
  ship.smoothIconHeading = heading;
  ship.smoothIconFloating = ship.isFloating;
  ship.smoothPrevLatLng = here;
  ship.smoothLastHeading = heading;
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
    if (slider) slider.disabled = !smoothMotionState.enabled;
    checkbox.addEventListener('change', (e) => {
      setSmoothMotionEnabled(e.target.checked);
      if (slider) slider.disabled = !e.target.checked;
    });
  }

  if (slider) {
    setSmoothMotionDelta(smoothMotionState.deltaSec); // clamp in case a saved value is out of range
    slider.value = String(smoothMotionState.deltaSec);
    if (label) label.textContent = `${smoothMotionState.deltaSec}s in the past`;
    slider.addEventListener('input', (e) => {
      setSmoothMotionDelta(parseInt(e.target.value, 10));
      if (label) label.textContent = `${smoothMotionState.deltaSec}s in the past`;
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

// Marker-consistent [lat,lon] at the given (segIdx, frac) — the same
// turn-then-straight kinematic position the marker uses, evaluated at a
// trail/lead window edge.
function edgePoint(history, sf, lengthM) {
  const seg = buildSegment(history, sf.segIdx, sf.segIdx + 1, lengthM);
  const p = kinematicPoint(history[sf.segIdx], history[sf.segIdx + 1], sf.frac, seg);
  return [p.lat, p.lon];
}

function lerpPt(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

// Centripetal Catmull-Rom spline through `pts`, inserting `sub` points between
// each pair. Real AIS reports arrive too sparsely (~60s apart) for the
// per-segment dead-reckoning arc to bend visibly — over one report interval a
// ship turns only a few degrees, so each segment is essentially a straight
// chord and the rendered track is a polygon with a corner at every fix. Fitting
// a spline through the fixes rounds those corners into a continuous smooth
// curve. Centripetal parameterisation (alpha=0.5) avoids the cusps/self-loops a
// uniform Catmull-Rom produces on unevenly-spaced points. Passes through every
// input point, so the fix circles still sit exactly on the line.
function smoothCurve(pts, sub = 10) {
  const P = [];
  for (const p of pts) {
    if (!P.length || Math.hypot(p[0] - P[P.length - 1][0], p[1] - P[P.length - 1][1]) > 1e-7) P.push(p);
  }
  if (P.length < 3) return P;
  const d = (p, q) => Math.sqrt(Math.hypot(q[0] - p[0], q[1] - p[1])) || 1e-6;
  const out = [P[0]];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[i - 1] ?? P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] ?? P[i + 1];
    const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    for (let s = 1; s <= sub; s++) {
      const t = t1 + (t2 - t1) * (s / sub);
      const A1 = lerpPt(p0, p1, (t - t0) / (t1 - t0));
      const A2 = lerpPt(p1, p2, (t - t1) / (t2 - t1));
      const A3 = lerpPt(p2, p3, (t - t2) / (t3 - t2));
      const B1 = lerpPt(A1, A2, (t - t0) / (t2 - t0));
      const B2 = lerpPt(A2, A3, (t - t1) / (t3 - t1));
      out.push(lerpPt(B1, B2, (t - t1) / (t2 - t1)));
    }
  }
  return out;
}

// The smooth trail BEHIND the marker, covering the last `trailSec` seconds up
// to targetTs. Returns `control`: the window-start position, every real AIS
// report inside the window, then the window-end (marker) position — fitted to a
// smooth curve by the caller (see smoothCurve for why a spline through the
// fixes, rather than the dead-reckoning arc, is what bends visibly). Also
// returns those reports as `waypoints` (with each one's canonical heading /
// course) for the fix circles and tick marks. Null when there's nothing to draw.
export function pastTrackPoints(ship, targetTs, lengthM, trailSec) {
  const history = ship.history;
  if (!history || history.length < 2 || !trailSec || trailSec <= 0) return null;
  const fromTs = targetTs - trailSec * 1000;
  if (fromTs >= targetTs) return null;

  const start = timeToSegFrac(history, fromTs);
  const end = timeToSegFrac(history, targetTs);
  if (start.segIdx === end.segIdx && start.frac >= end.frac) return null; // no span to draw

  const control = [edgePoint(history, start, lengthM)];
  const waypoints = [];
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (h.ts > fromTs && h.ts < targetTs) control.push([h.lat, h.lon]);
    if (h.ts >= fromTs && h.ts <= targetTs) {
      waypoints.push({
        ts: h.ts, lat: h.lat, lon: h.lon,
        heading: h.headingReliable ? bestHeading(h.cog, h.hdg, h.declination) : null,
        cog: cogBad(h.cog) ? null : h.cog,
      });
    }
  }
  control.push(edgePoint(history, end, lengthM));
  return { control, waypoints };
}

// The smooth track AHEAD of the marker, covering the next `leadSec` seconds
// from targetTs, clamped to the newest known report (the lead never
// extrapolates past data we have). Returns `control`: the marker position,
// every real report strictly ahead of it within the window, then the
// window-end position — splined by the caller like the past trail. `waypoints`
// are the reports ahead of the marker, for the fix circles / tick marks. Null
// when there's nothing to draw.
export function leadTrackPoints(ship, targetTs, lengthM, leadSec) {
  const history = ship.history;
  if (!history || history.length < 2 || !leadSec || leadSec <= 0) return null;
  const toTs = targetTs + leadSec * 1000;

  const start = timeToSegFrac(history, targetTs);
  const end = timeToSegFrac(history, toTs);
  if (start.segIdx === end.segIdx && start.frac >= end.frac) return null; // no span to draw

  // Reports strictly ahead of the marker (ts > targetTs) so a report at the
  // marker isn't drawn on both the past trail and the lead.
  const control = [edgePoint(history, start, lengthM)];
  const waypoints = [];
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (h.ts > targetTs && h.ts < toTs) control.push([h.lat, h.lon]);
    if (h.ts > targetTs && h.ts <= toTs) {
      waypoints.push({
        ts: h.ts, lat: h.lat, lon: h.lon,
        heading: h.headingReliable ? bestHeading(h.cog, h.hdg, h.declination) : null,
        cog: cogBad(h.cog) ? null : h.cog,
      });
    }
  }
  control.push(edgePoint(history, end, lengthM));
  return { control, waypoints };
}

// Endpoint of a short tick mark from a waypoint pointing along `angleDeg`
// (compass bearing). Length scaled to the ship's own size, so it reads
// sensibly across very different vessel sizes. Used for both the reported
// AIS heading and the reported AIS course-over-ground ticks.
function tickEndpoint(lat, lon, angleDeg, lengthM) {
  const tickLenM = lengthM ? Math.min(60, Math.max(15, lengthM * 0.6)) : 25;
  const rad = angleDeg * Math.PI / 180;
  return destFromDisplacement(lat, lon, tickLenM * Math.cos(rad), tickLenM * Math.sin(rad));
}

// Draws a fix's heading (solid tick) and course-over-ground (dashed tick) into
// `marks` — cheap, ephemeral overlays recreated every frame. The fix CIRCLE
// itself is drawn separately (reconcileFixCircles) so it can persist across
// frames and hold a clickable popup. `opacity` lets the lead render fainter.
function pushTicks(marks, wp, lengthM, color, opacity) {
  if (wp.heading != null) {
    const [tLat, tLon] = tickEndpoint(wp.lat, wp.lon, wp.heading, lengthM);
    marks.push(L.polyline([[wp.lat, wp.lon], [tLat, tLon]], { color, weight: 1.5, opacity }).addTo(map));
  }
  // The reported course-over-ground, as a distinct dashed tick (vs. the solid
  // heading tick above) — the two diverge under leeway/current.
  if (wp.cog != null) {
    const [cLat, cLon] = tickEndpoint(wp.lat, wp.lon, wp.cog, lengthM);
    marks.push(L.polyline([[wp.lat, wp.lon], [cLat, cLon]], { color, weight: 1.5, opacity, dashArray: '2,3' }).addTo(map));
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
function haversineNM(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const φ1 = aLat * Math.PI / 180, φ2 = bLat * Math.PI / 180;
  const dφ = (bLat - aLat) * Math.PI / 180, dλ = (bLon - aLon) * Math.PI / 180;
  const x = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x)) / 1852;
}
function fmtNM(nm) {
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
  const cogStr = cogBad(f.cog) ? `${f.cog != null ? f.cog.toFixed(1) : '—'} (n/a)` : `${f.cog.toFixed(1)}°`;
  const hdgStr = f.hdg === 511 ? '0x1FF (n/a)'
    : hdgBad(f.hdg) ? `${f.hdg != null ? f.hdg.toFixed(1) : '—'} (unreliable)`
    : `${f.hdg.toFixed(1)}°`;
  return `
    <div class="popup-name">${name}</div>
    ${popupRow('MMSI', mmsi)}
    ${popupRow('AIS COG', cogStr)}
    ${popupRow('AIS HDG', hdgStr)}
    ${popupRow('Position', `lat=${f.lat.toFixed(5)} lon=${f.lon.toFixed(5)}`)}
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

// Updates marker positions 10x/second while smooth motion is on, so motion
// looks continuous rather than ticking once per second. Also draws, ahead of
// the marker, the planned "lead" track for the next `getLeadSec()`
// seconds (clamped to the data we have) — plus, behind the marker, the smooth
// (kinematic) trail for the last `getTrailSec()` seconds. Along BOTH, a circle
// marks each real AIS report, with a solid heading tick and a dashed course
// tick. Both lines use the vessel's category (or spoof) colour — the same
// colour as the live-mode trail — with the lead drawn more transparently.
export function startSmoothMotionLoop(getTrailSec, getLeadSec, getShowFixes) {
  let lastTargetTs = null;
  setInterval(() => {
    if (!smoothMotionState.enabled) return;
    const targetTs = targetTimestamp();
    // Normally targetTs creeps forward with the wall clock, so the frame-to-
    // frame bearing below points along the direction of travel. But dragging
    // the delta slider toward a bigger lag rewinds targetTs backward (faster
    // than real time), which would flip every bearing 180° and reverse all the
    // icons. Only trust the frame-to-frame bearing while time advances; when
    // scrubbing into the past, hold each ship's last forward-facing heading.
    const advancing = lastTargetTs == null || targetTs > lastTargetTs;
    lastTargetTs = targetTs;
    for (const [mmsi, ship] of ships) {
      const sd = staticData.get(mmsi);
      const dim = sd?.dim;
      const lengthM = dim ? (dim.A || 0) + (dim.B || 0) : null;
      const snap = historicalState(ship, targetTs, lengthM);
      if (!snap) continue;
      const here = [snap.data.lat, snap.data.lon];
      ship.marker.setLatLng(here);

      // Point the bow towards where the marker is actually moving frame to
      // frame, rather than the analytic heading formula — guarantees the
      // icon's rotation always matches the drawn path exactly (no jumpiness
      // from any mismatch between the two), and is what's drawn matters more
      // than what the model "intended". Skip tiny/no movement (e.g. dead
      // slow, or the position held at the nearest known report) — bearing
      // between two nearly-identical points is numerically unstable — and
      // keep the last good heading instead.
      let renderHeading = ship.smoothLastHeading ?? snap.data.cog ?? 0;
      if (advancing && ship.smoothPrevLatLng) {
        const [pLat, pLon] = ship.smoothPrevLatLng;
        const dN = (here[0] - pLat) * M_PER_DEG_LAT;
        const dE = (here[1] - pLon) * M_PER_DEG_LAT * Math.cos(here[0] * Math.PI / 180);
        if (Math.hypot(dN, dE) > 0.3) {
          renderHeading = bearingDeg(pLat, pLon, here[0], here[1]);
        }
      }
      ship.smoothPrevLatLng = here;
      ship.smoothLastHeading = renderHeading;

      // setIcon() replaces the marker's DOM element — doing that every 100ms
      // raced with click handling and broke popups. Only redraw when the
      // heading has actually moved enough to notice, or floating changed.
      const headingChanged = ship.smoothIconHeading == null
        || Math.abs(angleDiff(ship.smoothIconHeading, renderHeading)) > 2;
      if (headingChanged || ship.smoothIconFloating !== ship.isFloating) {
        ship.marker.setIcon(shipIcon(renderHeading, renderHeading, snap.data.sog, sd?.typeCode, dim, ship.isFloating));
        ship.smoothIconHeading = renderHeading;
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
        const leadLine = smoothCurve(lead.control);
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
          pushTicks(ship.smoothAheadMarks, wp, lengthM, trailColor, LEAD_TRAIL_OPACITY);
          fixSet.set(wp.ts, { lat: wp.lat, lon: wp.lon, opacity: LEAD_TRAIL_OPACITY });
        }
      } else {
        removeAheadLine(ship);
      }

      const trailSec = getTrailSec ? getTrailSec() : 0;
      const past = ship.onMap ? pastTrackPoints(ship, targetTs, lengthM, trailSec) : null;
      if (past) {
        const pastLine = smoothCurve(past.control);
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
          pushTicks(ship.smoothPastMarks, wp, lengthM, trailColor, PAST_TRAIL_OPACITY);
          fixSet.set(wp.ts, { lat: wp.lat, lon: wp.lon, opacity: PAST_TRAIL_OPACITY });
        }
      } else {
        removePastTrail(ship);
      }

      reconcileFixCircles(ship, mmsi, fixSet, trailColor);
    }
  }, 100);
}
