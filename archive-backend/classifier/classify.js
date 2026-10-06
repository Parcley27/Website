// Scores every timeline item (videos via their thumbnail frame) with the zero-shot labels,
// appending to results.jsonl so a restart resumes where it left off. finalize.js turns the
// scores into the archive's flags.json.
const fs = require("fs");
const http = require("http");
const PORT = process.env.PORT || 4029;
const LABELS = require("./labels.js");
const OUT = __dirname + "/results.jsonl";

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method, headers: body ? { "Content-Type": "application/json" } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    r.on("error", reject);
    r.setTimeout(120000, () => r.destroy(new Error("timeout")));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits out backend restarts instead of skipping items.
async function reqRetry(method, path, body) {
  for (let i = 0; ; i++) {
    try {
      return await req(method, path, body);
    } catch (e) {
      if (i > 120) throw e;
      await sleep(5000);
    }
  }
}

(async () => {
  const { pipeline, RawImage, env } = await import("@huggingface/transformers");
  env.cacheDir = __dirname + "/models";
  const MODEL = process.env.MODEL || "Xenova/clip-vit-base-patch32";
  const clf = await pipeline("zero-shot-image-classification", MODEL, {
    dtype: "q8",
    session_options: { intraOpNumThreads: Number(process.env.THREADS || 3) },
  });
  const texts = LABELS.map((l) => l.text);
  const template = process.env.TEMPLATE || "{}";

  const tl = JSON.parse((await reqRetry("GET", "/timeline")).body);
  const ids = tl.items.map((r) => r[0]);
  const keys = {};
  for (let i = 0; i < ids.length; i += 5000) Object.assign(keys, JSON.parse((await reqRetry("POST", "/keys", { ids: ids.slice(i, i + 5000) })).body));

  const done = new Set();
  if (fs.existsSync(OUT)) for (const line of fs.readFileSync(OUT, "utf8").split("\n")) if (line) done.add(JSON.parse(line).k);
  // Photos the family sees by default go first; already-hidden folders after.
  const hid = new Set(tl.hidden), soft = new Set(tl.soft);
  const shownByDefault = new Set(tl.items.filter((r) => !r[6].some((i) => hid.has(i) && !soft.has(i)) && !r[6].every((i) => hid.has(i))).map((r) => r[0]));
  const todo = ids.filter((id) => keys[id] && !done.has(keys[id])).sort((a, b) => shownByDefault.has(b) - shownByDefault.has(a));
  console.log(`${ids.length} items, ${done.size} already scored, ${todo.length} to go`);

  const out = fs.openSync(OUT, "a");
  const fetchImg = async (id) => {
    const r = await reqRetry("GET", `/t/${id}?s=400`);
    if (r.status !== 200) return null;
    return RawImage.fromBlob(new Blob([r.body]));
  };
  // Fetch thumbnails a few ahead so the model never waits on the server.
  const AHEAD = 4;
  const pending = new Map();
  const t0 = Date.now();
  let failed = 0;
  for (let n = 0; n < todo.length; n++) {
    for (let j = n; j < Math.min(todo.length, n + AHEAD); j++) if (!pending.has(j)) pending.set(j, fetchImg(todo[j]).catch(() => null));
    const id = todo[n];
    const img = await pending.get(n);
    pending.delete(n);
    if (!img) {
      failed++;
      continue;
    }
    const res = await clf(img, texts, { hypothesis_template: template });
    const s = Object.fromEntries(res.map((r) => [r.label, r.score]));
    fs.writeSync(out, JSON.stringify({ k: keys[id], id, s: LABELS.map((l) => +s[l.text].toFixed(4)) }) + "\n");
    if (n % 1000 === 0) console.log(`${n}/${todo.length} (${failed} failed, ${((Date.now() - t0) / 60000).toFixed(1)} min)`);
  }
  console.log(`DONE: ${todo.length} scored, ${failed} failed, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
