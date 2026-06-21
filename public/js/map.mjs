function viewFromHash() {
  const parts = location.hash.replace('#', '').split('/');
  if (parts.length === 3) {
    const z = parseInt(parts[0]), lat = parseFloat(parts[1]), lon = parseFloat(parts[2]);
    if (!isNaN(z) && !isNaN(lat) && !isNaN(lon)) return { lat, lon, z };
  }
  return null;
}

const initial = viewFromHash();
export const map = L.map('map', { preferCanvas: true })
  .setView(initial ? [initial.lat, initial.lon] : [30, 0], initial ? initial.z : 3);

// Switchable base tile sources — kept dependency-free (no filterState import)
// so map.mjs stays early/foundational in the import graph; legend.mjs owns
// wiring the radio buttons + persisted choice and calls setMapSource().
export const MAP_SOURCES = {
  dark: 'Dark',
  voyager: 'Voyager (light, clearer water)',
  openseamap: 'OpenSeaMap (nautical detail)',
};

let activeLayers = [];
export function setMapSource(key) {
  for (const layer of activeLayers) map.removeLayer(layer);
  activeLayers = [];
  if (key === 'voyager') {
    activeLayers.push(L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO', maxZoom: 20,
    }));
  } else if (key === 'openseamap') {
    // Seamark symbols (buoys, channels, depth areas) are an overlay, not a
    // full basemap — drawn on its own designed for a light background, so
    // pair it with plain OSM tiles rather than the dark base.
    activeLayers.push(L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
    }));
    activeLayers.push(L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenSeaMap contributors', maxZoom: 18,
    }));
  } else {
    activeLayers.push(L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO', maxZoom: 19,
    }));
  }
  for (const layer of activeLayers) layer.addTo(map);
}
setMapSource('dark'); // default — legend.mjs re-applies the saved choice, if any, once it loads

// Leaflet's tile layers repeat infinitely as you pan (no maxBounds/noWrap
// set), but a marker only ever exists at its one literal longitude — pan
// far enough to be looking at a repeated copy of the world and any marker
// outside ±180° of THAT copy's center just isn't there. Shifting each
// marker's longitude by the nearest multiple of 360° to the map's current
// center renders it in whichever copy is actually on screen — always
// exactly once, never duplicated, never missing — instead of leaving it
// stuck wherever its raw, un-shifted longitude happens to fall.
export function wrapLonNearCenter(lon) {
  const center = map.getCenter().lng;
  return lon + 360 * Math.round((center - lon) / 360);
}
export function wrapLatLngNearCenter([lat, lon]) {
  return [lat, wrapLonNearCenter(lon)];
}

export function updateHash() {
  const c = map.getCenter();
  history.replaceState(null, '', `#${map.getZoom()}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}`);
}
