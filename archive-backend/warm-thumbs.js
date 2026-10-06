// Pre-builds the timeline's grid thumbnails so scrolling never waits on sharp/ffmpeg.
// Run after indexer.js, while the server is up: nice node warm-thumbs.js
const http = require("http");

const PORT = process.env.PORT || 4029;
const SIZE = 400; // must match thumbPx in the page

// Asks the server for the list, so folders it leaves out of the timeline aren't warmed.
function fetchTimeline() {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path: "/timeline" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(JSON.parse(body).items.map(([id]) => ({ id }))));
    }).on("error", reject);
  });
}

function get(id) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: `/t/${id}?s=${SIZE}` }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", () => resolve(0));
    req.setTimeout(60000, () => req.destroy());
  });
}

(async () => {
  const items = await fetchTimeline();
  let next = 0;
  let failed = 0;
  const started = Date.now();
  await Promise.all(
    [0, 1].map(async () => {
      while (next < items.length) {
        const i = next++;
        let code = await get(items[i].id);
        // 0 = server unreachable (e.g. mid-restart): wait for it rather than skipping ahead.
        for (let tries = 0; code === 0 && tries < 60; tries++) {
          await new Promise((r) => setTimeout(r, 5000));
          code = await get(items[i].id);
        }
        if (code !== 200) failed++;
        if (i % 2000 === 0) console.log(`${i}/${items.length} (${failed} failed, ${((Date.now() - started) / 60000).toFixed(1)} min)`);
      }
    })
  );
  console.log(`done: ${items.length} items, ${failed} failed, ${((Date.now() - started) / 60000).toFixed(1)} min`);
})();
