# AIS Stream Live Map

Live AIS ship traffic map powered by [aisstream.io](https://aisstream.io).

## Requirements

- Node.js 18+
- An API key from [aisstream.io](https://aisstream.io)

## Run

```bash
npm install
AIS_API_KEY=your_key_here node server.js
```

Open **http://localhost:3000**.

To use a different port:

```bash
PORT=8080 AIS_API_KEY=your_key_here node server.js
```

## How it works

`server.js` proxies the browser to `wss://stream.aisstream.io` (which doesn't allow direct browser connections):

- Forwards AIS messages to all browser clients via a local WebSocket at `/ws`.
- Re-subscribes the upstream bounding box whenever a client pans/zooms (debounced 500ms).
- Caches `ShipStaticData` per MMSI and enriches position messages with it, plus magnetic declination (for true-heading correction), before forwarding.

The frontend (`public/index.html`) renders ships on a Leaflet map, with a legend/filter panel (ship type, heading reliability, speed, age, trail length), basic spoof detection (implausible implied speed), and `localStorage` persistence of recent traffic across reloads.

## Log file

The server writes a log to **`debug.log`** in the project directory (overwritten on each start), recording connection events, bounding box updates, and every received position/static-data message.
