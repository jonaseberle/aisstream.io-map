// Off-main-thread JSON.stringify + LZString compression for localStorage
// saves. This is pure CPU work — no DOM/localStorage access needed here —
// and is what actually caused the "UI hangs while saving" symptom: a
// fleet's worth of ship history serializing+compressing into a real-sized
// string, synchronously, on the main thread. localStorage itself has no
// async API, so the actual .setItem() write still happens on the main
// thread (see storage.mjs) — but with the string already built, that part
// is fast.
importScripts('https://cdnjs.cloudflare.com/ajax/libs/lz-string/1.5.0/lz-string.min.js');

self.onmessage = (e) => {
  const { id, shipsObj, staticObj, compress } = e.data;
  const shipsJson = JSON.stringify(shipsObj);
  const staticJson = JSON.stringify(staticObj);
  const shipsStr = compress ? LZString.compressToUTF16(shipsJson) : shipsJson;
  const staticStr = compress ? LZString.compressToUTF16(staticJson) : staticJson;
  self.postMessage({ id, shipsStr, staticStr });
};
