export const MAX_TRAIL_POINTS = 600; // 30min at ~3s intervals

export const NAV_STATUS = [
  'Under way (engine)', 'At anchor', 'Not under command',
  'Restricted maneuverability', 'Constrained by draught', 'Moored', 'Aground',
  'Engaged in fishing', 'Under way (sailing)',
];

// mmsi → { marker, trail, data, positions, timestamps, onMap, trailOnMap, spoofSuspected, maxImpliedKnots, inBounds, timedOut }
export const ships = new Map();
// mmsi → { typeCode, typeLabel, name, dim, draught, callSign, imo, destination }
export const staticData = new Map();
