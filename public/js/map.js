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
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO', maxZoom: 19,
}).addTo(map);

export function updateHash() {
  const c = map.getCenter();
  history.replaceState(null, '', `#${map.getZoom()}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}`);
}
