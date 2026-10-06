// Scores CLIP zero-shot labels on photos whose category is known from their folder,
// to pick a threshold before trusting it on the mixed phone camera rolls.
const fs = require("fs");
const PORT = process.env.PORT || 4099;
const LABELS = require("./labels.js");

(async () => {
  const { pipeline, RawImage, env } = await import("@huggingface/transformers");
  env.cacheDir = __dirname + "/models";
  const MODEL = process.env.MODEL || "Xenova/clip-vit-base-patch32";
  const clf = await pipeline("zero-shot-image-classification", MODEL, { dtype: process.env.DTYPE || "q8" });
  const tl = JSON.parse(fs.readFileSync("/var/www/pierceoxley.ca/archive-backend/data/timeline.json", "utf8"));
  const photos = tl.items.filter((it) => !it.v);
  const pick = (re, n, not) => {
    const pool = photos.filter((it) => re.test(it.p) && !(not && not.test(it.p)));
    const out = [];
    for (let i = 0; i < n && pool.length; i++) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    return out;
  };
  const prev = fs.existsSync(__dirname + "/sample.json") ? JSON.parse(fs.readFileSync(__dirname + "/sample.json", "utf8")) : null;
  const byId = new Map(photos.map((p) => [p.id, p]));
  const sets = prev ? Object.fromEntries(Object.entries(prev).map(([k, ids]) => [k, ids.map((i) => byId.get(i))])) : {
    clinical: pick(/Plastic Surgery photos|\/work pics\/|skin cancers|Hand stuff|work photos 2017/, 160),
    family: pick(/Organized Photos\/20\d\d\/|Photos \(organized\)\//, 320, /Paul|paul|work|Surgery|surgery|scan/i),
  };
  if (!prev) fs.writeFileSync(__dirname + "/sample.json", JSON.stringify(Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, v.map((x) => x.id)]))));
  const out = [];
  const t0 = Date.now();
  for (const [truth, items] of Object.entries(sets)) {
    for (const it of items) {
      const img = await RawImage.read(`http://127.0.0.1:${PORT}/t/${it.id}?s=400`);
      const res = await clf(img, LABELS.map((l) => l.text), { hypothesis_template: process.env.TEMPLATE || "{}" });
      const scores = Object.fromEntries(res.map((r) => [r.label, r.score]));
      out.push({ truth, id: it.id, scores });
    }
  }
  console.log(`${out.length} images in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  fs.writeFileSync(__dirname + "/eval-out-" + (process.env.TAG || "clip") + ".json", JSON.stringify(out));
})();
