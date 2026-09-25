// Shared status-file helper. Each in-flight upload gets a small JSON file at
// data/status/<basename>.json that both ingest.js (automatic) and the LLM
// correction/notes passes (manual, cron-triggered) update as they progress.
// Once finalize.js successfully registers a lecture, the status file is deleted —
// the lecture showing up in the class data IS the "done" signal at that point.
const fs = require("fs");
const path = require("path");

function statusDir(dataDir) {
  const dir = path.join(dataDir, "status");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function statusPath(dataDir, baseName) {
  return path.join(statusDir(dataDir), `${baseName}.json`);
}

function writeStatus(dataDir, baseName, fields) {
  const file = statusPath(dataDir, baseName);
  let current = {};
  if (fs.existsSync(file)) {
    try {
      current = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // ignore corrupt/partial reads, just overwrite
    }
  }
  const next = { ...current, ...fields, baseName, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

function readAllStatuses(dataDir) {
  const dir = statusDir(dataDir);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

function clearStatus(dataDir, baseName) {
  const file = statusPath(dataDir, baseName);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = { writeStatus, readAllStatuses, clearStatus, statusPath };
