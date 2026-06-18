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

function connectToAIS() {
  log('Connecting to aisstream.io...');
  aisSocket = new WebSocket('wss://stream.aisstream.io/v0/stream');

  aisSocket.on('open', () => {
    log('Connected to aisstream.io');
    subscribe(currentBounds);
  });

  aisSocket.on('message', (data) => {
    const str = data.toString();
    try {
      const msg = JSON.parse(str);
      const payload = msg.Message && Object.values(msg.Message)[0];
      const mmsi = String(payload?.UserID ?? msg.Metadata?.MMSI ?? '?');

      if (msg.MessageType === 'ShipStaticData') {
        const typeCode = payload?.Type;
        const label = shipTypeLabel(typeCode);
        const name = payload?.Name?.trim() || msg.Metadata?.ShipName?.trim() || null;
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
        const name = msg.Metadata?.ShipName?.trim() || 'Unknown';
        const lat  = payload?.Latitude;
        const lon  = payload?.Longitude;
        const sog  = payload?.Sog;
        const cog  = payload?.Cog;
        const meta = shipMeta.get(mmsi);
        const typeStr = meta ? ` type=${meta.typeCode} (${meta.label})` : '';
        const boundsStr = (lat != null && lon != null)
          ? (inBounds(lat, lon) ? ' [IN]' : ` [OUT bounds=${JSON.stringify(currentBounds)}]`)
          : ' [no coords]';
        log(`[${msg.MessageType}] ${name} (${mmsi}) lat=${lat?.toFixed(4)} lon=${lon?.toFixed(4)} sog=${sog} cog=${cog}${typeStr}${boundsStr}`);
      }
    } catch (_) {}

    // Enrich position messages with cached static data + magnetic declination
    let outStr = str;
    try {
      const msg = JSON.parse(str);
      if (msg.MessageType !== 'ShipStaticData') {
        const payload = msg.Message && Object.values(msg.Message)[0];
        const mmsi = String(payload?.UserID ?? msg.Metadata?.MMSI ?? '?');
        const lat = payload?.Latitude;
        const lon = payload?.Longitude;
        const meta = shipMeta.get(mmsi);
        const extra = {};
        if (meta) extra._meta = meta;
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
    log('AIS stream closed, reconnecting in 5s...');
    setTimeout(connectToAIS, 5000);
  });

  aisSocket.on('error', (err) => {
    log('AIS stream error:', err.message);
  });
}

wss.on('connection', (ws) => {
  clients.add(ws);
  log(`Browser connected (${clients.size} total), sending ${shipMeta.size} cached ship records`);
  if (shipMeta.size > 0) {
    ws.send(JSON.stringify({ _type: 'metaCache', data: Object.fromEntries(shipMeta) }));
  }

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
