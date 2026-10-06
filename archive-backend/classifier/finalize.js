// Turns classify.js scores into flags.json for the archive backend.
// Thresholds come from eval-out-clip.json (160 known clinical vs 320 known family photos):
// summed "medical" score > 0.7 caught 87% of clinical with 2% of family photos flagged;
// > 0.3 caught 91% with 9% flagged. The loose threshold is only used inside raw phone
// dumps, where clinical photos actually turn up; everything else gets the strict one.
// Usage: node finalize.js [out=flags.json]
const fs = require("fs");
const http = require("http");
const LABELS = require("./labels.js");
const PORT = process.env.PORT || 4029;
const STRICT = 0.7, LOOSE = 0.3, DOC = 0.6;
// Paul's raw phone dumps (where patient photos turned up); everyone else's phone dumps get the strict threshold.
const RAW_DUMP = /paul ?(phone|cell)|offce financials[^/]*\/cell phone download/i;

const get = (path) =>
  new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path }, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => resolve(Buffer.concat(c).toString()));
    }).on("error", reject);
  });

(async () => {
  const tl = JSON.parse(await get("/timeline"));
  const raw = new Set(tl.items.filter((r) => r[6].some((i) => RAW_DUMP.test(tl.folders[i]))).map((r) => r[0]));
  const med = LABELS.map((l, i) => (l.group === "medical" ? i : -1)).filter((i) => i >= 0);
  const doc = LABELS.map((l, i) => (l.group === "document" ? i : -1)).filter((i) => i >= 0);
  const flags = { built: new Date().toISOString(), model: "Xenova/clip-vit-base-patch32", medical: [], document: [] };
  let n = 0;
  for (const line of fs.readFileSync(__dirname + "/results.jsonl", "utf8").split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line);
    n++;
    const m = med.reduce((a, i) => a + r.s[i], 0);
    const d = doc.reduce((a, i) => a + r.s[i], 0);
    if (m > (raw.has(r.id) ? LOOSE : STRICT)) flags.medical.push(r.k);
    else if (d > DOC) flags.document.push(r.k);
  }
  const out = process.argv[2] || __dirname + "/flags.json";
  fs.writeFileSync(out, JSON.stringify(flags));
  console.log(`${n} scored: ${flags.medical.length} possibly medical, ${flags.document.length} documents/screenshots -> ${out}`);
})();
