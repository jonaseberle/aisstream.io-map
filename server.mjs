import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// Vendored front-end deps (Leaflet, lz-string, Leaflet.heat) are served from disk rather
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
  fs.mkdirSync(path.join(dist, 'leaflet.heat'), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, 'node_modules', 'leaflet.heat', 'dist', 'leaflet-heat.js'),
    path.join(dist, 'leaflet.heat', 'leaflet-heat.js')
  );
  log('Vendored Leaflet + lz-string + Leaflet.heat into public/dist/');
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

// MMSI → { typeCode, name, dim, draught, callSign, imo, destination } from
// ShipStaticData messages. typeCode is exactly what AIS delivers — turning
// it into a human label ("Tanker", etc.) is presentation, not data, so
// that's left to the client (categories.mjs's shipTypeLabel), not computed
// or stored here.
const shipMeta = new Map();

const clients = new Map(); // ws -> { boxes: [[s,w],[n,e], ...] } — each client's own subscribed area(s)
let aisSocket = null;
let lastSubscribeAt = null; // set right after sending a subscribe request upstream, cleared on the next message — lets us log how long aisstream.io took to start honoring it

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

// Wraps to (-180, 180] — Leaflet's map.getBounds() (client) doesn't wrap
// longitude, so a view panned across the antimeridian (±180°) sends west/
// east values outside the standard range (e.g. west=170, east=190) here.
// Normalizing both ends means "west > east" becomes a single, reliable
// signal for "this box wraps", used consistently below.
function normalizeLon(lon) {
  return ((lon + 540) % 360) - 180;
}

function inBoundsBox(lat, lon, box) {
  const [[s, w], [n, e]] = box;
  if (lat < s || lat > n) return false;
  const west = normalizeLon(w), east = normalizeLon(e), x = normalizeLon(lon);
  return west <= east ? (x >= west && x <= east) : (x >= west || x <= east);
}

// No boxes means "no bounds set yet" — same as the old `!currentBounds`
// behavior of receiving everything.
function inAnyBounds(lat, lon, boxes) {
  if (!boxes || boxes.length === 0) return true;
  return boxes.some((box) => inBoundsBox(lat, lon, box));
}

// A client's 'setBounds'/connection-URL bounds can be either a single box
// [[s,w],[n,e]] or an array of boxes [[[s,w],[n,e]], ...] — the latter lets
// one client subscribe to multiple disjoint areas at once. Distinguish them
// by checking whether the first element is itself a box (an array) or a
// [lat,lon] pair (numbers).
function normalizeBoundsList(bounds) {
  if (!Array.isArray(bounds) || bounds.length === 0) return [];
  return Array.isArray(bounds[0][0]) ? bounds : [bounds];
}

function mergedClientBounds() {
  const all = [];
  for (const { boxes } of clients.values()) all.push(...boxes);
  return all;
}

const MESSAGE_TYPES = ['PositionReport', 'StandardClassBPositionReport', 'LongRangeAisBroadcastMessage', 'ShipStaticData'];

// aisstream.io's BoundingBoxes expects ordinary (non-wrapping) rectangles —
// a box crossing the antimeridian (west > east once normalized) is split
// into the two ordinary boxes on either side of it instead of sent as one
// box aisstream.io would likely misinterpret (or just return nothing for).
function splitAntimeridian(bounds) {
  const [[s, w], [n, e]] = bounds;
  const west = normalizeLon(w), east = normalizeLon(e);
  if (west <= east) return [[[s, west], [n, east]]];
  return [[[s, west], [n, 180]], [[s, -180], [n, east]]];
}

// Takes the merged list of every client's boxes (one upstream connection is
// shared across all clients, so its subscription has to cover the union of
// what they each want) and sends it to aisstream.io.
function subscribe(boxesList) {
  const boxes = boxesList && boxesList.length > 0
    ? boxesList.flatMap(splitAntimeridian)
    : [[[-90, -180], [90, 180]]];
  lastSubscribeAt = Date.now();
  log(`Subscribing upstream with ${boxes.length} box(es): ${JSON.stringify(boxes)}`);
  aisSocket.send(JSON.stringify({
    APIKey: API_KEY,
    BoundingBoxes: boxes,
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
    subscribe(mergedClientBounds());
    lastAliveAt = Date.now();
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (aisSocket?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastAliveAt > STALE_TIMEOUT_MS) {
        log(`AIS stream stalled (no data/pong for ${Math.round((Date.now() - lastAliveAt) / 1000)}s) — forcing reconnect`);
        aisSocket.terminate(); // skips the close handshake (which a dead socket won't complete anyway); triggers 'close' below
        return;
      }
      log(`Pinging aisstream.io (idle for ${Math.round((Date.now() - lastAliveAt) / 1000)}s)`);
      aisSocket.ping();
    }, PING_INTERVAL_MS);
  });

  aisSocket.on('pong', () => {
    log(`Pong received from aisstream.io (${Date.now() - lastAliveAt}ms since last activity)`);
    lastAliveAt = Date.now();
  });

  aisSocket.on('message', (data) => {
    lastAliveAt = Date.now(); // real traffic is at least as good proof of life as a pong
    const str = data.toString();
    let outStr = str;
    let isPosition = false;
    let lat, lon;

    try {
      const msg = JSON.parse(str);

      // aisstream.io has no explicit "bounds accepted" ack — the only signal
      // that a subscribe request took effect is that data starts flowing
      // again, so log how long that took the first time a message arrives
      // after each subscribe call.
      if (lastSubscribeAt != null) {
        log(`Upstream bounds confirmed implicitly: first message arrived ${Date.now() - lastSubscribeAt}ms after subscribe request (aisstream.io sends no explicit ack)`);
        lastSubscribeAt = null;
      }
      if (msg.error) log(`Upstream subscription error: ${msg.error}`);

      const payload = msg.Message && Object.values(msg.Message)[0];
      const mmsi = String(payload?.UserID ?? msg.MetaData?.MMSI ?? '?');

      if (msg.MessageType === 'ShipStaticData') {
        const typeCode = payload?.Type;
        const name = payload?.Name?.trim() || msg.MetaData?.ShipName?.trim() || null;
        const dim = payload?.Dimension ?? null;
        const draught = payload?.MaximumStaticDraught ?? null;
        const callSign = payload?.CallSign?.trim() || null;
        const imo = payload?.ImoNumber ?? null;
        const destination = payload?.Destination?.trim() || null;
        shipMeta.set(mmsi, { typeCode, name, dim, draught, callSign, imo, destination });
        const length = dim ? (dim.A || 0) + (dim.B || 0) : null;
        const width  = dim ? (dim.C || 0) + (dim.D || 0) : null;
        const dimStr = length ? ` dim=${length}x${width}m draught=${draught}m` : '';
        log(`[ShipStaticData] ${name || 'Unknown'} (${mmsi}) type=${typeCode}${dimStr}`);
      } else {
        isPosition = true;
        lat = payload?.Latitude;
        lon = payload?.Longitude;
        const name = msg.MetaData?.ShipName?.trim() || 'Unknown';
        const sog  = payload?.Sog;
        const courseTrue  = payload?.Cog;
        const headingTrue  = payload?.TrueHeading;
        const meta = shipMeta.get(mmsi);
        const typeStr = meta ? ` type=${meta.typeCode}` : '';
        const merged = mergedClientBounds();
        const boundsStr = (lat != null && lon != null)
          ? (inAnyBounds(lat, lon, merged) ? ' [IN]' : ` [OUT bounds=${JSON.stringify(merged)}]`)
          : ' [no coords]';
        log(`[${msg.MessageType}] ${name} (${mmsi}) lat=${lat?.toFixed(4)} lon=${lon?.toFixed(4)} sog=${sog} courseTrue=${courseTrue} headingTrue=${headingTrue}${typeStr}${boundsStr}`);

        // Enrich position messages with cached static data and the
        // upstream-reported timestamp (_ts)
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
        outStr = JSON.stringify(Object.assign({}, msg, extra));
      }
    } catch (_) {}

    // The upstream subscription is the union of every client's boxes, so
    // without per-client filtering here a client would also receive
    // position traffic meant for other clients' areas. ShipStaticData isn't
    // tied to a position, so it's still broadcast to everyone.
    for (const [ws, info] of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (isPosition && lat != null && lon != null && !inAnyBounds(lat, lon, info.boxes)) continue;
      ws.send(outStr);
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
  clients.set(ws, { boxes: [] });
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
  // that re-subscribe happened with this client's bounds still unset
  // (world-wide) and stayed that way until the round-trip completed, the
  // upstream feed would sit on the wrong (much larger) subscription in the
  // meantime.
  try {
    const bounds = JSON.parse(new URL(req.url, 'http://x').searchParams.get('bounds'));
    const boxes = normalizeBoundsList(bounds);
    if (boxes.length > 0) {
      clients.get(ws).boxes = boxes;
      log(`Bounds received with connection: ${boxes.length} box(es) ${JSON.stringify(boxes)}`);
      if (aisSocket?.readyState === WebSocket.OPEN) subscribe(mergedClientBounds());
    }
  } catch (_) {}

  ws.on('close', () => {
    clients.delete(ws);
    log(`Browser disconnected (${clients.size} remaining)`);
    if (aisSocket?.readyState === WebSocket.OPEN) subscribe(mergedClientBounds());
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'setBounds' && aisSocket?.readyState === WebSocket.OPEN) {
        const boxes = normalizeBoundsList(msg.bounds);
        clients.get(ws).boxes = boxes;
        log(`Bounds updated for client: ${boxes.length} box(es) ${JSON.stringify(boxes)}`);
        subscribe(mergedClientBounds());
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
