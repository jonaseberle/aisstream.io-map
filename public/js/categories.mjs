export const CATEGORIES = {
  cargo:     { color: '#3b82f6', label: 'Cargo (70-79)' },
  tanker:    { color: '#ef4444', label: 'Tanker (80-89)' },
  passenger: { color: '#a855f7', label: 'Passenger (60-69)' },
  fishing:   { color: '#eab308', label: 'Fishing (30)' },
  sailing:   { color: '#06b6d4', label: 'Sailing / Pleasure (36-37)' },
  service:   { color: '#f97316', label: 'Service (50-59)' },
  hsc:       { color: '#84cc16', label: 'High Speed / WIG (20-49)' },
  military:  { color: '#dc2626', label: 'Military (35)' },
  other:     { color: '#6b7280', label: 'Other / Not available' },
  unknown:   { color: '#94a3b8', label: 'No static data' },
};

export function shipCategory(typeCode) {
  if (typeCode == null) return 'unknown';
  if (typeCode >= 70 && typeCode <= 79) return 'cargo';
  if (typeCode >= 80 && typeCode <= 89) return 'tanker';
  if (typeCode >= 60 && typeCode <= 69) return 'passenger';
  if (typeCode === 30) return 'fishing';
  if (typeCode === 36 || typeCode === 37) return 'sailing';
  if (typeCode >= 50 && typeCode <= 59) return 'service';
  if (typeCode >= 40 && typeCode <= 49 || typeCode >= 20 && typeCode <= 29) return 'hsc';
  if (typeCode === 35) return 'military';
  return 'other';
}

// ── AIS type label lookup ─────────────────────────────────────────────────
export const SHIP_TYPES = {
  0: 'Not available',
  20: 'WIG', 21: 'WIG (hazardous A)', 22: 'WIG (hazardous B)', 23: 'WIG (hazardous C)', 24: 'WIG (hazardous D)',
  30: 'Fishing', 31: 'Towing', 32: 'Towing (large)', 33: 'Dredging', 34: 'Diving',
  35: 'Military', 36: 'Sailing', 37: 'Pleasure craft',
  40: 'HSC', 41: 'HSC (hazardous A)', 42: 'HSC (hazardous B)', 43: 'HSC (hazardous C)', 44: 'HSC (hazardous D)',
  50: 'Pilot', 51: 'SAR', 52: 'Tug', 53: 'Port tender', 54: 'Anti-pollution',
  55: 'Law enforcement', 58: 'Medical', 59: 'Non-combatant',
  60: 'Passenger', 61: 'Passenger (hazardous A)', 62: 'Passenger (hazardous B)',
  63: 'Passenger (hazardous C)', 64: 'Passenger (hazardous D)',
  70: 'Cargo', 71: 'Cargo (hazardous A)', 72: 'Cargo (hazardous B)',
  73: 'Cargo (hazardous C)', 74: 'Cargo (hazardous D)',
  80: 'Tanker', 81: 'Tanker (hazardous A)', 82: 'Tanker (hazardous B)',
  83: 'Tanker (hazardous C)', 84: 'Tanker (hazardous D)',
  90: 'Other', 91: 'Other (hazardous A)', 92: 'Other (hazardous B)',
  93: 'Other (hazardous C)', 94: 'Other (hazardous D)',
};

export const CATEGORY_TYPES = {
  cargo:     [70, 71, 72, 73, 74],
  tanker:    [80, 81, 82, 83, 84],
  passenger: [60, 61, 62, 63, 64],
  fishing:   [30],
  sailing:   [36, 37],
  service:   [50, 51, 52, 53, 54, 55, 58, 59],
  hsc:       [20, 21, 22, 23, 24, 40, 41, 42, 43, 44],
  military:  [35],
  other:     [0, 31, 32, 33, 34, 90, 91, 92, 93, 94],
  unknown:   [],
};

export function shipTypeLabel(code) {
  if (code == null) return null;
  return SHIP_TYPES[code] ?? (code >= 20 && code <= 28 ? 'WIG' : code >= 40 && code <= 49 ? 'HSC' : `Type ${code}`);
}
