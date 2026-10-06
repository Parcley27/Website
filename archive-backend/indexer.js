// Builds data/timeline.json: every personal photo/video under the archive root,
// deduplicated, with a best-guess capture date, for the chronological photo view.
// Read-only against the archive. Usage: node indexer.js  (re-run after adding photos)
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const sharp = require("sharp");
const exifReader = require("exif-reader");

const ARCHIVE_ROOT = "/srv/data";
const OUT = path.join(__dirname, "data", "timeline.json");

const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".tif", ".tiff"]);
const VIDEO_EXTS = new Set([".mov", ".mp4", ".m4v", ".avi", ".mpg", ".3gp", ".wmv"]);

// Program files, OS folders and saved-webpage asset folders: never photos people took.
const SKIP_DIR = /(^|\/)(Program Files( \(x86\))?|ProgramData|AppData|Windows|WindowsApps|Common Files|System Volume Information|\$WinREAgent|Intel|PerfLogs|AccountPictures)(\/|$)|_files$|\.app(\/|$)/i;
const RECYCLE = /^\$Recycle\.Bin(\/|$)/;

// Smallest photo worth showing; filters icons, buttons and web thumbnails.
const MIN_PHOTO_PX = 320;

sharp.cache(false);
sharp.concurrency(1);

async function walk(dir, out) {
  let names;
  try {
    names = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of names) {
    if (d.name.startsWith(".") || d.name === "Thumbs.db" || d.name === "desktop.ini") continue;
    const full = path.join(dir, d.name);
    const rel = path.relative(ARCHIVE_ROOT, full);
    if (d.isDirectory()) {
      if (!SKIP_DIR.test(rel)) await walk(full, out);
    } else if (d.isFile()) {
      const ext = path.extname(d.name).toLowerCase();
      if (PHOTO_EXTS.has(ext) || VIDEO_EXTS.has(ext)) out.push({ rel, full, ext, video: VIDEO_EXTS.has(ext) });
    }
  }
}

// Size plus the first and last 64 KB identifies a copy without reading whole videos.
async function fingerprint(full, size) {
  const fh = await fsp.open(full, "r");
  try {
    const n = Math.min(65536, size);
    const head = Buffer.alloc(n);
    await fh.read(head, 0, n, 0);
    const tail = Buffer.alloc(n);
    await fh.read(tail, 0, n, Math.max(0, size - n));
    return crypto.createHash("sha1").update(String(size)).update(head).update(tail).digest("base64url").slice(0, 16);
  } finally {
    await fh.close();
  }
}

const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const plausible = (y) => y >= 1990 && y <= new Date().getFullYear();

function exifDate(exifBuf) {
  try {
    const e = exifReader(exifBuf);
    const d = (e.Photo && (e.Photo.DateTimeOriginal || e.Photo.DateTimeDigitized)) || (e.Image && e.Image.DateTime);
    // exif-reader returns EXIF's naive local time as if it were UTC; keep the wall-clock digits.
    if (d instanceof Date && !isNaN(d) && plausible(d.getUTCFullYear())) {
      return d.toISOString().slice(0, 19).replace("T", " ");
    }
  } catch {
    // corrupt EXIF block
  }
  return null;
}

function videoDate(full) {
  return new Promise((resolve) => {
    execFile("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_entries", "format_tags=creation_time:stream=width,height", full], { timeout: 20000 }, (err, stdout) => {
      if (err) return resolve({});
      try {
        const j = JSON.parse(stdout);
        const v = (j.streams || []).find((s) => s.width) || {};
        const ct = j.format && j.format.tags && j.format.tags.creation_time;
        const d = ct ? new Date(ct) : null;
        resolve({ w: v.width, h: v.height, date: d && !isNaN(d) && plausible(d.getFullYear()) && d.getFullYear() > 1990 ? fmt(d) : null });
      } catch {
        resolve({});
      }
    });
  });
}

// IMG_20140512_..., 2014-05-12 ..., VID_20140512 etc.
function filenameDate(name) {
  const m = name.match(/(?:^|[^0-9])((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_ T]?([01]\d|2[0-3])[-_.:]?([0-5]\d)[-_.:]?([0-5]\d))?/);
  if (!m || !plausible(+m[1])) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4] || "12"}:${m[5] || "00"}:${m[6] || "00"}`;
}

function folderYear(rel) {
  const years = [...path.dirname(rel).matchAll(/(?:^|[^0-9])((?:19|20)\d{2})(?![0-9])/g)].map((m) => +m[1]).filter(plausible);
  return years.length ? years[years.length - 1] : null;
}

async function describe(f) {
  const st = await fsp.stat(f.full);
  if (st.size < 8192) return null;
  const item = { rel: f.rel, size: st.size, video: f.video };
  let date = null;
  let source = "mtime";
  if (f.video) {
    const v = await videoDate(f.full);
    item.w = v.w || 0;
    item.h = v.h || 0;
    if (v.date) {
      date = v.date;
      source = "meta";
    }
  } else {
    let meta;
    try {
      meta = await sharp(f.full, { failOn: "none" }).metadata();
    } catch {
      return null;
    }
    if (!meta.width || Math.max(meta.width, meta.height) < MIN_PHOTO_PX) return null;
    const rotated = meta.orientation >= 5;
    item.w = rotated ? meta.height : meta.width;
    item.h = rotated ? meta.width : meta.height;
    if (meta.exif) {
      date = exifDate(meta.exif);
      if (date) source = "exif";
    }
  }
  if (!date) {
    date = filenameDate(path.basename(f.rel));
    if (date) source = "name";
  }
  if (!date) {
    // mtime is often just when the file was copied; trust the folder's year over it when they disagree.
    const m = new Date(st.mtimeMs);
    const fy = folderYear(f.rel);
    if (fy && Math.abs(m.getFullYear() - fy) > 1) {
      date = `${fy}-01-01 00:00:00`;
      source = "folder";
    } else {
      date = fmt(m);
    }
  }
  item.date = date;
  item.source = source;
  item.fp = await fingerprint(f.full, st.size);
  return item;
}

async function pool(items, n, fn, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          results[i] = await fn(items[i]);
        } catch {
          results[i] = null;
        }
        if (++done % 2000 === 0) onProgress(done, items.length);
      }
    })
  );
  return results;
}

// Which copy to show when a photo exists in several places: the organized Dropbox
// copy first, recovered and recycle-bin copies last.
function rank(rel) {
  if (RECYCLE.test(rel)) return 4;
  if (rel.startsWith("Recovered/")) return 3;
  if (rel.startsWith("Ext Drive - Old Stuff/")) return 2;
  if (rel.includes("Organized Photos") || rel.includes("Photos (organized)")) return 0;
  return 1;
}

async function main() {
  const started = Date.now();
  const files = [];
  await walk(ARCHIVE_ROOT, files);
  console.log(`found ${files.length} candidate files in ${((Date.now() - started) / 1000).toFixed(0)}s`);

  const described = await pool(files, 6, describe, (d, t) => console.log(`  ${d}/${t}`));

  const byFp = new Map();
  for (const it of described) {
    if (!it) continue;
    if (!byFp.has(it.fp)) byFp.set(it.fp, []);
    byFp.get(it.fp).push(it);
  }

  const folders = [];
  const folderIdx = new Map();
  const fid = (dir) => {
    if (!folderIdx.has(dir)) {
      folderIdx.set(dir, folders.length);
      folders.push(dir);
    }
    return folderIdx.get(dir);
  };

  const items = [];
  for (const copies of byFp.values()) {
    copies.sort((a, b) => rank(a.rel) - rank(b.rel) || a.rel.length - b.rel.length);
    // Recycle-bin copies only count when the photo exists nowhere else.
    const kept = copies.filter((c) => !RECYCLE.test(c.rel));
    const members = kept.length ? kept : copies;
    const best = members[0];
    // Prefer the most trustworthy date any copy has.
    const order = { exif: 0, meta: 0, name: 1, folder: 2, mtime: 3 };
    const dated = [...copies].sort((a, b) => order[a.source] - order[b.source])[0];
    items.push({
      p: best.rel,
      d: dated.date,
      a: dated.source === "folder" || dated.source === "mtime" ? 1 : 0,
      w: best.w,
      h: best.h,
      v: best.video ? 1 : 0,
      s: best.size,
      f: [...new Set(members.map((c) => fid(path.dirname(c.rel))))],
    });
  }
  items.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : a.p.localeCompare(b.p)));
  items.forEach((it, i) => (it.id = i));

  await fsp.mkdir(path.dirname(OUT), { recursive: true });
  const tmp = OUT + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify({ built: new Date().toISOString(), folders, items }));
  await fsp.rename(tmp, OUT);

  const sources = {};
  for (const it of described) if (it) sources[it.source] = (sources[it.source] || 0) + 1;
  console.log(`indexed ${described.filter(Boolean).length} files -> ${items.length} unique items in ${((Date.now() - started) / 60000).toFixed(1)} min; date sources:`, sources);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
