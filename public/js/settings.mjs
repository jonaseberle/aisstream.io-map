import { filterState, hiddenCategories, hiddenTypes } from './visibility.mjs';
import { smoothMotionState } from './smoothMotion.mjs';
import { boundsRectState } from './websocket.mjs';

// Persists UI settings (filters, smooth motion, the bounds-rect freeze
// toggle) across reloads via a cookie — separate from the ship/vessel DATA
// persistence in storage.mjs, which uses localStorage and is unaffected by this.
const COOKIE_NAME = 'ais_ui_settings';
const COOKIE_MAX_AGE_DAYS = 365;

function readCookie(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}
function writeCookie(name, value) {
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${COOKIE_MAX_AGE_DAYS * 86400}; path=/; SameSite=Lax`;
}

export function resetSettings() {
  writeCookie(COOKIE_NAME, JSON.stringify({}));
}

export function loadSettings() {
  const raw = readCookie(COOKIE_NAME);
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    if (s.filterState && typeof s.filterState === 'object') Object.assign(filterState, s.filterState);
    if (Array.isArray(s.hiddenCategories)) {
      hiddenCategories.clear();
      for (const c of s.hiddenCategories) hiddenCategories.add(c);
    }
    if (Array.isArray(s.hiddenTypes)) {
      hiddenTypes.clear();
      for (const t of s.hiddenTypes) hiddenTypes.add(t);
    }
    if (s.smoothMotion && typeof s.smoothMotion === 'object') Object.assign(smoothMotionState, s.smoothMotion);
    if (s.boundsRect && typeof s.boundsRect === 'object') {
      if (typeof s.boundsRect.frozen === 'boolean') boundsRectState.frozen = s.boundsRect.frozen;
      if (Array.isArray(s.boundsRect.bounds)) boundsRectState.bounds = s.boundsRect.bounds;
    }
  } catch (e) {
    console.warn('UI settings cookie load failed:', e.message);
  }
}

export function saveSettings() {
  const payload = {
    filterState,
    hiddenCategories: [...hiddenCategories],
    hiddenTypes: [...hiddenTypes],
    smoothMotion: { enabled: smoothMotionState.enabled, deltaSec: smoothMotionState.deltaSec },
    boundsRect: { frozen: boundsRectState.frozen, bounds: boundsRectState.bounds },
  };
  try {
    writeCookie(COOKIE_NAME, JSON.stringify(payload));
  } catch (e) {
    console.warn('UI settings cookie save failed:', e.message);
  }
}

// Apply any saved settings immediately as a side effect of importing this
// module — must happen before legend.mjs (or anything else) builds UI that
// reads filterState/hiddenCategories/hiddenTypes/etc., so this is imported
// as legend.mjs's very first import.
loadSettings();
