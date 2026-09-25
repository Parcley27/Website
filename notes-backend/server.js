const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { execFile } = require("child_process");
const { writeStatus, readAllStatuses } = require("./status");

const DATA_DIR = path.join(__dirname, "data", "classes");
const STATUS_DATA_DIR = path.join(__dirname, "data");
const MEDIA_DIR = path.join(__dirname, "media");
const INCOMING_DIR = path.join(__dirname, "incoming");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(INCOMING_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, INCOMING_DIR),
    filename: (req, file, cb) => {
      // Keep the original name (it carries the class label) but make it unique
      // so two same-named uploads in a row don't clobber each other.
      const ext = path.extname(file.originalname);
      const base = path.basename(file.originalname, ext);
      cb(null, `${base}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
});

const app = express();
app.use("/media", express.static(MEDIA_DIR));

app.post("/upload", upload.single("audio"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file received" });

  writeStatus(STATUS_DATA_DIR, req.file.filename, {
    stage: "queued",
    originalName: req.file.originalname,
  });

  // Deliberately NOT kicking off ingest.js here anymore. It used to fire
  // immediately on upload for a faster start, but that raced with /process's
  // own ingest step whenever cron's trigger fired mid-upload or mid-transcribe
  // (both would see "not yet transcribed" and call Deepgram on the same file
  // concurrently, corrupting one or both responses). /process alone now owns
  // the entire pipeline for every file, serialized by the lock below — cron's
  // trigger still picks this up within ~10s, which is fast enough.
  res.json({ ok: true, filename: req.file.filename });
});

app.get("/status", (req, res) => res.json(readAllStatuses(STATUS_DATA_DIR)));

app.get("/classes", (req, res) => {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  const classes = files.map((f) => {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
    const lectures = data.lectures || [];
    const latest = lectures.length ? lectures[lectures.length - 1].date : null;
    return {
      slug: data.slug,
      displayName: data.displayName,
      lectureCount: lectures.length,
      latestDate: latest,
    };
  });
  classes.sort((a, b) => a.displayName.localeCompare(b.displayName));
  res.json(classes);
});

app.get("/classes/:slug", (req, res) => {
  const file = path.join(DATA_DIR, `${req.params.slug}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "not found" });
  res.json(JSON.parse(fs.readFileSync(file, "utf8")));
});

// Runs the full ingest -> correct -> notesgen -> finalize pipeline over
// whatever's sitting in incoming/, plus stuck-file alerting. Called by cron's
// push-based check (only when its cheap shell gate finds a file present), so
// this can safely do real work without being on a tight poll interval itself.
// Text response is either newline-joined "what happened" lines, or NO_REPLY.
//
// Serialized by an in-memory lock: if a run is already in flight when another
// /process request arrives (e.g. two uploads landing close together, or cron
// firing again before a long transcription finishes), the new request is a
// no-op rather than spawning a second overlapping process.js — process.js
// already loops over every file in incoming/ in one run, and the lock just
// stops two runs from grabbing the same not-yet-finished file at once. A file
// that arrives mid-run gets picked up by the next (unlocked) cron trigger.
let isProcessing = false;

app.post("/process", (req, res) => {
  if (isProcessing) {
    return res.type("text/plain").send("NO_REPLY");
  }
  isProcessing = true;
  execFile("node", ["process.js"], { cwd: __dirname, timeout: 20 * 60 * 1000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    isProcessing = false;
    if (err && !stdout) {
      console.error("process.js failed:", err.message, stderr);
      return res.status(500).type("text/plain").send(`process.js error: ${err.message}`);
    }
    res.type("text/plain").send(stdout.trim() || "NO_REPLY");
  });
});

const PORT = 4032;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`notes backend listening on 127.0.0.1:${PORT}`);
});
