// Off-main-thread JSON.stringify + LZString compression for localStorage
// saves. This is pure CPU work — no DOM/localStorage access needed here —
// and is what actually caused the "UI hangs while saving" symptom: a
// fleet's worth of ship history serializing+compressing into a real-sized
// string, synchronously, on the main thread. localStorage itself has no
// async API, so the actual .setItem() write still happens on the main
// thread (see storage.js) — but with the string already built, that part
// is fast.
importScripts('https://cdnjs.cloudflare.com/ajax/libs/lz-string/1.5.0/lz-string.min.js');

self.onmessage = (e) => {
  const { id, shipsObj, staticObj } = e.data;
  const shipsStr = LZString.compressToUTF16(JSON.stringify(shipsObj));
  const staticStr = LZString.compressToUTF16(JSON.stringify(staticObj));
  self.postMessage({ id, shipsStr, staticStr });
};
