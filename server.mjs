import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs';
import geomagnetism from 'geomagnetism';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const geoModel = geomagnetism.model(); // IGRF model for current date

const LOG_FILE = path.join(__dirname, 'debug.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
}

const API_KEY = process.env.AIS_API_KEY;
if (!API_KEY) {
  console.error('Error: AIS_API_KEY environment variable is required');
  process.exit(1);
}

// Vendored front-end deps (Leaflet, lz-string) are served from disk rather
// than a CDN — copied here from node_modules on every startup instead of
// committed, so public/dist/ stays in .gitignore and always matches
// whatever's actually installed (package.json/package-lock.json is the
// source of truth, not a second copy of the files).
function vendorAssets() {
  const dist = path.join(__dirname, 'public', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.cpSync(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), path.join(dist, 'leaflet'), { recursive: true });
  fs.mkdirSync(path.join(dist, 'lz-string'), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, 'node_modules', 'lz-string', 'libs', 'lz-string.min.js'),
    path.join(dist, 'lz-string', 'lz-string.min.js')
  );
  log('Vendored Leaflet + lz-string into public/dist/');
}
vendorAssets();

const app = express();
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  cacheControl: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  },
}));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Ship type code → human label (AIS type codes)
const SHIP_TYPES = {
  0: 'Not available',
  20: 'WIG', 21: 'WIG (hazardous A)', 22: 'WIG (hazardous B)', 23: 'WIG (hazardous C)', 24: 'WIG (hazardous D)',
  30: 'Fishing',
  31: 'Towing', 32: 'Towing (large)',
  33: 'Dredging', 34: 'Diving', 35: 'Military', 36: 'Sailing', 37: 'Pleasure craft',
  40: 'HSC', 41: 'HSC (hazardous A)', 42: 'HSC (hazardous B)', 43: 'HSC (hazardous C)', 44: 'HSC (hazardous D)',
  50: 'Pilot', 51: 'SAR', 52: 'Tug', 53: 'Port tender', 54: 'Anti-pollution',
  55: 'Law enforcement', 58: 'Medical', 59: 'Non-combatant',
  60: 'Passenger', 61: 'Passenger (hazardous A)', 62: 'Passenger (hazardous B)', 63: 'Passenger (hazardous C)', 64: 'Passenger (hazardous D)',
  70: 'Cargo', 71: 'Cargo (hazardous A)', 72: 'Cargo (hazardous B)', 73: 'Cargo (hazardous C)', 74: 'Cargo (hazardous D)',
  80: 'Tanker', 81: 'Tanker (hazardous A)', 82: 'Tanker (hazardous B)', 83: 'Tanker (hazardous C)', 84: 'Tanker (hazardous D)',
  90: 'Other', 91: 'Other (hazardous A)', 92: 'Other (hazardous B)', 93: 'Other (hazardous C)', 94: 'Other (hazardous D)',
};

function shipTypeLabel(code) {
  if (code == null) return null;
  return SHIP_TYPES[code] ?? (code >= 20 && code <= 28 ? 'WIG' : code >= 40 && code <= 49 ? 'HSC' : `Type ${code}`);
}

// MMSI → { typeCode, label } from ShipStaticData messages
const shipMeta = new Map();

const clients = new Set();
let currentBounds = null; // [[s,w],[n,e]]
let aisSocket = null;

// aisstream.io's MetaData.time_utc looks like
// "2026-06-20 22:32:03.085239788 +0000 UTC" (Go's default time.Time
// stringification) — not directly parseable by Date(), so reformat to a
// standard ISO string first. Date only has ms precision anyway, so the
// rest of the fractional seconds are discarded. Returns null (caller falls
// back to local receipt time) if the field is missing or unparseable.
function parseAisTimeUtc(s) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?/.exec(s ?? '');
  if (!m) return null;
  const ms = (m[3] ?? '').padEnd(3, '0').slice(0, 3);
  const t = Date.parse(`${m[1]}T${m[2]}.${ms}Z`);
  return Number.isNaN(t) ? null : t;
}

function inBounds(lat, lon) {
  if (!currentBounds) return true;
  const [[s, w], [n, e]] = currentBounds;
  return lat >= s && lat <= n && lon >= w && lon <= e;
}

const MESSAGE_TYPES = ['PositionReport', 'StandardClassBPositionReport', 'LongRangeAisBroadcastMessage', 'ShipStaticData'];

function subscribe(bounds) {
  aisSocket.send(JSON.stringify({
    APIKey: API_KEY,
    BoundingBoxes: [bounds ?? [[-90, -180], [90, 180]]],
    FilterMessageTypes: MESSAGE_TYPES,
  }));
}

// A TCP/WebSocket connection can die silently (NAT timeout, wifi blip,
// upstream-side hiccup) without ever firing 'close' or 'error' — the socket
// just sits there reporting OPEN while no more data arrives, so the usual
// close/error-triggered reconnect never kicks in. Detected here the
// standard way (ws README's "detecting broken connections"): ping on an
// interval and require a pong (or any real message — that's just as good
// proof of life) within a generous timeout, or treat the connection as dead
// and force-reconnect.
const PING_INTERVAL_MS = 20_000;
const STALE_TIMEOUT_MS = 45_000; // > 2x ping interval, so one missed pong doesn't trip it
let pingTimer = null;
let lastAliveAt = Date.now();

function connectToAIS() {
  log('Connecting to aisstream.io...');
  aisSocket = new WebSocket('wss://stream.aisstream.io/v0/stream');
  lastAliveAt = Date.now();

  aisSocket.on('open', () => {
    log('Connected to aisstream.io');
    subscribe(currentBounds);
    lastAliveAt = Date.now();
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (aisSocket?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastAliveAt > STALE_TIMEOUT_MS) {
        log(`AIS stream stalled (no data/pong for ${Math.round((Date.now() - lastAliveAt) / 1000)}s) — forcing reconnect`);
        aisSocket.terminate(); // skips the close handshake (which a dead socket won't complete anyway); triggers 'close' below
        return;
      }
      aisSocket.ping();
    }, PING_INTERVAL_MS);
  });

  aisSocket.on('pong', () => { lastAliveAt = Date.now(); });

  aisSocket.on('message', (data) => {
    lastAliveAt = Date.now(); // real traffic is at least as good proof of life as a pong
    const str = data.toString();
    try {
      const msg = JSON.parse(str);
      const payload = msg.Message && Object.values(msg.Message)[0];
      const mmsi = String(payload?.UserID ?? msg.MetaData?.MMSI ?? '?');

      if (msg.MessageType === 'ShipStaticData') {
        const typeCode = payload?.Type;
        const label = shipTypeLabel(typeCode);
        const name = payload?.Name?.trim() || msg.MetaData?.ShipName?.trim() || null;
        const dim = payload?.Dimension ?? null;
        const draught = payload?.MaximumStaticDraught ?? null;
        const callSign = payload?.CallSign?.trim() || null;
        const imo = payload?.ImoNumber ?? null;
        const destination = payload?.Destination?.trim() || null;
        shipMeta.set(mmsi, { typeCode, label, name, dim, draught, callSign, imo, destination });
        const length = dim ? (dim.A || 0) + (dim.B || 0) : null;
        const width  = dim ? (dim.C || 0) + (dim.D || 0) : null;
        const dimStr = length ? ` dim=${length}x${width}m draught=${draught}m` : '';
        log(`[ShipStaticData] ${name || 'Unknown'} (${mmsi}) type=${typeCode} (${label})${dimStr}`);
      } else {
        const name = msg.MetaData?.ShipName?.trim() || 'Unknown';
        const lat  = payload?.Latitude;
        const lon  = payload?.Longitude;
        const sog  = payload?.Sog;
        const cog  = payload?.Cog;
        const hdg  = payload?.TrueHeading;
        const meta = shipMeta.get(mmsi);
        const typeStr = meta ? ` type=${meta.typeCode} (${meta.label})` : '';
        const boundsStr = (lat != null && lon != null)
          ? (inBounds(lat, lon) ? ' [IN]' : ` [OUT bounds=${JSON.stringify(currentBounds)}]`)
          : ' [no coords]';
        log(`[${msg.MessageType}] ${name} (${mmsi}) lat=${lat?.toFixed(4)} lon=${lon?.toFixed(4)} sog=${sog} cog=${cog} hdg=${hdg}${typeStr}${boundsStr}`);
      }
    } catch (_) {}

    // Enrich position messages with cached static data, magnetic declination,
    // and the upstream-reported timestamp (_ts)
    let outStr = str;
    try {
      const msg = JSON.parse(str);
      if (msg.MessageType !== 'ShipStaticData') {
        const payload = msg.Message && Object.values(msg.Message)[0];
        const mmsi = String(payload?.UserID ?? msg.MetaData?.MMSI ?? '?');
        const lat = payload?.Latitude;
        const lon = payload?.Longitude;
        const meta = shipMeta.get(mmsi);
        const extra = {};
        if (meta) extra._meta = meta;
        // The actual moment aisstream.io received/relayed this report —
        // used as the fix's timestamp everywhere downstream (trail/history,
        // spoof detection, fix gaps, smooth motion), instead of whatever
        // local Date.now() happened to be when our server got around to
        // processing it. Falls back to the client's own Date.now() (see
        // messages.mjs) if missing/unparseable.
        const ts = parseAisTimeUtc(msg.MetaData?.time_utc);
        if (ts != null) extra._ts = ts;
        if (lat != null && lon != null) {
          // geomagnetism expects [longitude, latitude]
          extra._declination = +geoModel.point([lon, lat]).decl.toFixed(2);
        }
        outStr = JSON.stringify(Object.assign({}, msg, extra));
      }
    } catch (_) {}

    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(outStr);
    }
  });

  aisSocket.on('close', () => {
    clearInterval(pingTimer);
    log('AIS stream closed, reconnecting in 5s...');
    setTimeout(connectToAIS, 5000);
  });

  aisSocket.on('error', (err) => {
    log('AIS stream error:', err.message);
  });
}

wss.on('connection', (ws, req) => {
  clients.add(ws);
  log(`Browser connected (${clients.size} total), sending ${shipMeta.size} cached ship records`);
  if (shipMeta.size > 0) {
    ws.send(JSON.stringify({ _type: 'metaCache', data: Object.fromEntries(shipMeta) }));
  }

  // The browser also includes its current bounds right in the connection
  // URL (in addition to sending a 'setBounds' message once open) — so a
  // freshly-(re)connecting client's bounds are known immediately, without
  // waiting on that first message round-trip. Matters most right after a
  // server restart: aisSocket reconnects to aisstream.io and re-subscribes
  // within milliseconds, well before any browser's 3s reconnect delay — if
  // that re-subscribe happened with currentBounds still unset (world-wide)
  // and stayed that way until the round-trip completed, the upstream feed
  // would sit on the wrong (much larger) subscription in the meantime.
  try {
    const bounds = JSON.parse(new URL(req.url, 'http://x').searchParams.get('bounds'));
    if (Array.isArray(bounds)) {
      currentBounds = bounds;
      const [[s, w], [n, e]] = bounds;
      log(`Bounds received with connection: SW(${s.toFixed(3)}, ${w.toFixed(3)}) NE(${n.toFixed(3)}, ${e.toFixed(3)})`);
      if (aisSocket?.readyState === WebSocket.OPEN) subscribe(bounds);
    }
  } catch (_) {}

  ws.on('close', () => {
    clients.delete(ws);
    log(`Browser disconnected (${clients.size} remaining)`);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'setBounds' && aisSocket?.readyState === WebSocket.OPEN) {
        currentBounds = msg.bounds;
        const [[s, w], [n, e]] = msg.bounds;
        log(`Bounds updated: SW(${s.toFixed(3)}, ${w.toFixed(3)}) NE(${n.toFixed(3)}, ${e.toFixed(3)})`);
        subscribe(msg.bounds);
      }
    } catch (_) {}
  });
});

connectToAIS();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log(`Open http://localhost:${PORT} in your browser`);
  log(`Logging to ${LOG_FILE}`);
});
