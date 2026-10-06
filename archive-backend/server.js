const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const sharp = require("sharp");
const archiver = require("archiver");
const mime = require("mime-types");
const compression = require("compression");
const { execFile } = require("child_process");
const crypto = require("crypto");

const ARCHIVE_ROOT = "/srv/data";
const THUMB_CACHE_DIR = path.join(__dirname, ".thumb-cache");
const TIMELINE_FILE = path.join(__dirname, "data", "timeline.json");
// Written by the image classifier: share keys of photos that look clinical, or like documents.
const FLAGS_FILE = path.join(__dirname, "data", "flags.json");
// Defaults the admin login sets for everyone: folder path -> hidden?, share keys of photos
// hidden one by one, and share keys of photos shown even though their folder is hidden.
const DEFAULTS_FILE = path.join(__dirname, "data", "defaults.json");
// nginx passes the basic-auth username; the backend only listens on localhost, so only nginx can set it.
const ADMIN_USERS = new Set(["Parcley27"]);
const FLAG_FOLDERS = {
  medical: "Auto-flagged (classifier)/Possibly medical",
  document: "Auto-flagged (classifier)/Documents & screenshots",
};
const PORT = process.env.PORT || 4029;

// Folders the photo timeline hides until someone ticks them in the sidebar:
// Paul's clinical/work photos, medical photos, financial and insurance
// paperwork, scans, and the Windows recycle bin. Matched against any segment
// of the folder path, so every copy of a folder is covered.
const DEFAULT_HIDDEN = [
  /^\$Recycle\.Bin(\/|$)/,
  /(^|\/)(work pics|work photos[^/]*|[^/]*plastic surgery[^/]*|[^/]*hernia surgery[^/]*)(\/|$)/i,
  /(^|\/)(insurance pics|family \(financial and insur\)|paul personal|scans|my scans|scanned documents)(\/|$)/i,
  /(^|\/)(offce financials 2015 on|office financials|payroll)$/i,
];

// Also hidden by default, but softly: a photo from one of these folders still
// shows if it was also filed somewhere visible. Paul's raw phone dumps mix family
// shots with patient photos; the family ones were copied into proper albums.
const SOFT_HIDDEN = [/(^|\/)[^/]*paul ?(phone|cell)[^/]*(\/|$)/i];

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif"]);
const HIDDEN_NAMES = new Set([
  "$Recycle.Bin",
  "System Volume Information",
  "Config.Msi",
  "Thumbs.db",
  "desktop.ini",
  ".DS_Store",
  "lost+found",
]);

fs.mkdirSync(THUMB_CACHE_DIR, { recursive: true });

const app = express();
app.use(express.json());

// Resolve a client-supplied relative path safely against ARCHIVE_ROOT.
// Throws if the result would escape the archive root.
function resolveSafe(relPath) {
  const clean = path.normalize(path.join("/", relPath || "")).replace(/^\/+/, "");
  const full = path.join(ARCHIVE_ROOT, clean);
  const resolved = path.resolve(full);
  const rootResolved = path.resolve(ARCHIVE_ROOT);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error("Path escapes archive root");
  }
  return resolved;
}

app.get("/list", async (req, res) => {
  try {
    const dir = resolveSafe(req.query.path);
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) return res.status(400).json({ error: "Not a directory" });

    const names = await fsp.readdir(dir);
    const entries = [];
    for (const name of names) {
      if (HIDDEN_NAMES.has(name) || name.startsWith(".")) continue;
      try {
        const st = await fsp.stat(path.join(dir, name));
        const ext = path.extname(name).toLowerCase();
        entries.push({
          name,
          isDir: st.isDirectory(),
          size: st.size,
          mtime: st.mtimeMs,
          ext,
          isImage: IMAGE_EXTS.has(ext),
        });
      } catch {
        // skip unreadable entries (broken symlinks, permission issues, etc.)
      }
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    res.json({ path: req.query.path || "", entries });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/thumb", async (req, res) => {
  try {
    const file = resolveSafe(req.query.path);
    const ext = path.extname(file).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) return res.status(415).json({ error: "Not an image" });

    const size = Math.min(Math.max(parseInt(req.query.size, 10) || 400, 50), 1000);
    const stat = await fsp.stat(file);
    const cacheKey = Buffer.from(`${file}:${stat.mtimeMs}:${size}`).toString("base64url");
    const cachePath = path.join(THUMB_CACHE_DIR, cacheKey + ".jpg");

    if (fs.existsSync(cachePath)) {
      res.set("Content-Type", "image/jpeg");
      res.set("Cache-Control", "public, max-age=604800");
      return fs.createReadStream(cachePath).pipe(res);
    }

    const buf = await sharp(file, { failOn: "none" })
      .rotate()
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();

    await fsp.writeFile(cachePath, buf);
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "public, max-age=604800");
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/file", async (req, res) => {
  try {
    const file = resolveSafe(req.query.path);
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return res.status(400).json({ error: "Not a file" });

    const type = mime.lookup(file) || "application/octet-stream";
    res.set("Content-Type", type);
    res.set("Content-Length", stat.size);
    if (req.query.download) {
      res.set("Content-Disposition", `attachment; filename="${path.basename(file).replace(/"/g, "")}"`);
    }
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.post("/zip", async (req, res) => {
  try {
    const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
    if (paths.length === 0) return res.status(400).json({ error: "No paths given" });

    const resolved = paths.map(resolveSafe);

    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", `attachment; filename="archive-selection.zip"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (e) => { throw e; });
    archive.pipe(res);

    for (const full of resolved) {
      const stat = await fsp.stat(full);
      const name = path.relative(ARCHIVE_ROOT, full);
      if (stat.isDirectory()) {
        archive.directory(full, name);
      } else {
        archive.file(full, { name });
      }
    }
    await archive.finalize();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ---------- photo timeline (index built by indexer.js) ----------

let timeline = null;
let timelineStamp = "";

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// Reloads whenever indexer.js rewrites the index or the classifier rewrites its flags.
function getTimeline() {
  try {
    const stamp = `${fs.statSync(TIMELINE_FILE).mtimeMs}:${mtimeOf(FLAGS_FILE)}:${mtimeOf(DEFAULTS_FILE)}`;
    if (!timeline || stamp !== timelineStamp) {
      const raw = JSON.parse(fs.readFileSync(TIMELINE_FILE, "utf8"));
      // Share links use a hash of the file's path rather than its index, so they survive a re-index.
      const keys = raw.items.map((it) => shareKey(it.p));
      const byKey = new Map(keys.map((k, i) => [k, raw.items[i].id]));

      // Classifier flags become extra folders, hidden by default like the clinical ones.
      const folders = raw.folders.slice();
      const extra = new Map(); // item id -> extra folder idxs
      const flagIdxs = [];
      let flags = null;
      try {
        flags = JSON.parse(fs.readFileSync(FLAGS_FILE, "utf8"));
      } catch {}
      for (const [group, name] of Object.entries(FLAG_FOLDERS)) {
        const list = (flags && flags[group]) || [];
        if (!list.length) continue;
        const idx = folders.push(name) - 1;
        flagIdxs.push(idx);
        for (const k of list) {
          const id = byKey.get(k);
          if (id === undefined) continue;
          if (!extra.has(id)) extra.set(id, []);
          extra.get(id).push(idx);
        }
      }

      const matching = (rules) => folders.map((f, i) => (rules.some((re) => re.test(f)) ? i : -1)).filter((i) => i >= 0);
      const soft = matching(SOFT_HIDDEN);
      const hiddenSet = new Set([...matching(DEFAULT_HIDDEN), ...soft, ...flagIdxs]);
      // The admin's choices override the built-in rules either way.
      const defaults = readDefaults();
      folders.forEach((f, i) => {
        if (f in defaults.folders) defaults.folders[f] ? hiddenSet.add(i) : hiddenSet.delete(i);
      });
      const hidden = [...hiddenSet];
      const known = (list) => list.filter((k) => byKey.has(k)).map((k) => [byKey.get(k), k]);
      const hiddenItems = known(defaults.items);
      const shownItems = known(defaults.shown);
      // Compact rows for the browser: [id, date, approxDate, w, h, isVideo, folderIdxs]
      const rows = raw.items.map((it) => [it.id, it.d, it.a, it.w, it.h, it.v, extra.has(it.id) ? [...it.f, ...extra.get(it.id)] : it.f]);
      timeline = { raw, keys, byKey, payload: JSON.stringify({ built: raw.built, folders, hidden, soft, hiddenItems, shownItems, items: rows }) };
      timelineStamp = stamp;
    }
  } catch (e) {
    if (!timeline) throw e;
  }
  return timeline;
}

function readDefaults() {
  try {
    const d = JSON.parse(fs.readFileSync(DEFAULTS_FILE, "utf8"));
    return { folders: d.folders || {}, items: d.items || [], shown: d.shown || [] };
  } catch {
    return { folders: {}, items: [], shown: [] };
  }
}

function shareKey(relPath) {
  return crypto.createHash("sha1").update(relPath).digest("base64url").slice(0, 12);
}

function itemById(id) {
  const tl = getTimeline();
  const it = tl.raw.items[Number(id)];
  if (!it) throw new Error("No such item");
  return it;
}

app.get("/timeline", compression(), (req, res) => {
  try {
    res.type("application/json").send(getTimeline().payload);
  } catch (e) {
    res.status(503).json({ error: "photo index not built yet" });
  }
});

app.get("/item/:id", (req, res) => {
  try {
    const it = itemById(req.params.id);
    res.json({ id: it.id, key: getTimeline().keys[it.id], path: it.p, date: it.d, approx: !!it.a, size: it.s, video: !!it.v, w: it.w, h: it.h });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

function videoFrame(file) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-v", "error", "-ss", "1", "-i", file, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-"],
      { encoding: "buffer", maxBuffer: 50 * 1024 * 1024, timeout: 30000 },
      (err, stdout) => {
        if (stdout && stdout.length) return resolve(stdout);
        // very short clips have no frame at 1s; fall back to the first frame
        execFile("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-"],
          { encoding: "buffer", maxBuffer: 50 * 1024 * 1024, timeout: 30000 },
          (err2, out2) => (out2 && out2.length ? resolve(out2) : reject(err2 || err || new Error("no frame"))));
      });
  });
}

// Share link key -> timeline id.
app.get("/resolve/:key", (req, res) => {
  const id = getTimeline().byKey.get(req.params.key);
  if (id === undefined) return res.status(404).json({ error: "No such photo" });
  res.json({ id });
});

// Optional one-off greeting shown on login, e.g. a birthday:
// data/greeting.json = { "users": [...], "until": ISO time, "title": "...", "message": "...", "button": "..." }
const GREETING_FILE = path.join(__dirname, "data", "greeting.json");

app.get("/me", (req, res) => {
  const user = req.get("X-Remote-User") || "";
  let greeting = null;
  try {
    const g = JSON.parse(fs.readFileSync(GREETING_FILE, "utf8"));
    if (g.users.includes(user) && Date.now() < Date.parse(g.until)) greeting = { title: g.title, message: g.message, button: g.button };
  } catch {}
  res.json({ user, admin: ADMIN_USERS.has(user), greeting });
});

// Admin only: change what everyone sees by default.
// Body: { folders: {path: true|false|null}, items: {key: "hide"|"show"|null}, resetFolders: true }
// (null drops a folder override, back to the built-in rule).
app.post("/defaults", (req, res) => {
  if (!ADMIN_USERS.has(req.get("X-Remote-User") || "")) return res.status(403).json({ error: "Only the admin login can change defaults" });
  const d = readDefaults();
  if (req.body.resetFolders) d.folders = {};
  for (const [f, v] of Object.entries(req.body.folders || {})) {
    if (v === null) delete d.folders[f];
    else d.folders[f] = !!v;
  }
  const hide = new Set(d.items), show = new Set(d.shown);
  for (const [k, v] of Object.entries(req.body.items || {})) {
    hide.delete(k);
    show.delete(k);
    if (v === "hide" || v === true) hide.add(k);
    if (v === "show") show.add(k);
  }
  d.items = [...hide];
  d.shown = [...show];
  const tmp = DEFAULTS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d, null, 1));
  fs.renameSync(tmp, DEFAULTS_FILE);
  res.json({ ok: true, folders: Object.keys(d.folders).length, hidden: d.items.length, shown: d.shown.length });
});

// Batch lookups for photos hidden one at a time, which the page stores by share key.
app.post("/keys", (req, res) => {
  const tl = getTimeline();
  const out = {};
  for (const id of Array.isArray(req.body.ids) ? req.body.ids.slice(0, 20000) : []) {
    if (tl.keys[id] !== undefined) out[id] = tl.keys[id];
  }
  res.json(out);
});
app.post("/resolve-many", (req, res) => {
  const tl = getTimeline();
  const out = {};
  for (const k of Array.isArray(req.body.keys) ? req.body.keys.slice(0, 20000) : []) {
    if (tl.byKey.has(k)) out[k] = tl.byKey.get(k);
  }
  res.json(out);
});

// Thumbnail by timeline id; videos get a still from about a second in.
app.get("/t/:id", async (req, res) => {
  try {
    const it = itemById(req.params.id);
    const file = resolveSafe(it.p);
    const size = Math.min(Math.max(parseInt(req.query.s, 10) || 300, 50), 1600);
    const stat = await fsp.stat(file);
    const cacheKey = crypto.createHash("sha1").update(`${file}:${stat.mtimeMs}:${size}`).digest("hex");
    const cachePath = path.join(THUMB_CACHE_DIR, "t-" + cacheKey + ".jpg");

    res.set("Cache-Control", "private, max-age=2592000");
    res.set("Content-Type", "image/jpeg");
    if (fs.existsSync(cachePath)) return fs.createReadStream(cachePath).pipe(res);

    const input = it.v ? await videoFrame(file) : file;
    const buf = await sharp(input, { failOn: "none" })
      .rotate()
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    await fsp.writeFile(cachePath, buf);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function downloadName(it) {
  const stamp = it.d.slice(0, 10);
  return `${stamp} ${path.basename(it.p)}`.replace(/["\\]/g, "");
}

// Original file by timeline id. sendFile handles Range requests, so videos can seek.
app.get("/m/:id", (req, res) => {
  try {
    const it = itemById(req.params.id);
    const file = resolveSafe(it.p);
    if (req.query.download) res.attachment(downloadName(it));
    res.sendFile(file, { dotfiles: "allow", maxAge: "30d" }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "file not found" });
    });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Zip of selected timeline items, named by date so they sort chronologically.
// Photos and videos are already compressed, so they're stored rather than deflated.
app.post("/zip-items", express.urlencoded({ extended: false, limit: "5mb" }), async (req, res) => {
  try {
    // JSON array from scripts, or a comma-separated form field from the page's download form.
    const raw = req.body && req.body.ids;
    const ids = Array.isArray(raw) ? raw : String(raw || "").split(",").filter(Boolean);
    if (ids.length === 0) return res.status(400).json({ error: "No items given" });
    const items = ids.map(itemById);

    res.set("Content-Type", "application/zip");
    res.attachment(`photos-${new Date().toISOString().slice(0, 10)}.zip`);
    const archive = archiver("zip", { store: true });
    archive.on("warning", (e) => console.warn("zip warning:", e.message));
    archive.on("error", (e) => {
      console.error("zip error:", e.message);
      res.destroy(e);
    });
    archive.pipe(res);

    const used = new Set();
    for (const it of items) {
      let name = downloadName(it);
      const ext = path.extname(name);
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${path.basename(downloadName(it), ext)} (${n})${ext}`;
      used.add(name.toLowerCase());
      archive.file(resolveSafe(it.p), { name });
    }
    await archive.finalize();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get("/search", async (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  if (!q) return res.json({ results: [], truncated: false });

  let scope;
  try {
    scope = resolveSafe(req.query.path);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const MAX_RESULTS = 300;
  const MAX_DIRS = 20000;
  const TIME_BUDGET_MS = 8000;
  const started = Date.now();

  const results = [];
  const stack = [scope];
  let dirsVisited = 0;
  let truncated = false;

  while (stack.length && results.length < MAX_RESULTS) {
    if (Date.now() - started > TIME_BUDGET_MS || dirsVisited > MAX_DIRS) {
      truncated = true;
      break;
    }
    const dir = stack.pop();
    dirsVisited++;
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (HIDDEN_NAMES.has(name) || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }
      if (name.toLowerCase().includes(q)) {
        const ext = path.extname(name).toLowerCase();
        results.push({
          name,
          path: path.relative(ARCHIVE_ROOT, full),
          isDir: st.isDirectory(),
          size: st.size,
          mtime: st.mtimeMs,
          ext,
          isImage: IMAGE_EXTS.has(ext),
        });
        if (results.length >= MAX_RESULTS) break;
      }
      if (st.isDirectory()) stack.push(full);
    }
  }

  res.json({ results, truncated: truncated || stack.length > 0 });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`archive backend listening on 127.0.0.1:${PORT}, root=${ARCHIVE_ROOT}`);
});
