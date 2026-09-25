// Orchestrates the full lecture pipeline end to end, fully scripted (no agent
// turn needed): ingest (Deepgram) -> correct (Anthropic) -> notesgen
// (Anthropic) -> finalize -> move original into processed/. Prints either a
// newline-joined list of human-readable "what happened" lines, or the bare
// token NO_REPLY when there's nothing worth telling Pierce about (cron's
// command-payload silent-token suppression relies on that exact bare token).
// server.js serializes calls into this script (see its /process handler) so
// two overlapping runs never grab the same in-flight file — do not remove
// that lock without replacing it with an equivalent guard here.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeStatus, readAllStatuses, clearStatus, statusPath } = require("./status");

const ROOT = __dirname;
const INCOMING_DIR = path.join(ROOT, "incoming");
const PROCESSED_DIR = path.join(INCOMING_DIR, "processed");
const DATA_DIR = path.join(ROOT, "data");
const TMP_DIR = path.join(DATA_DIR, "tmp");
const STUCK_MS = 20 * 60 * 1000;

function run() {
  fs.mkdirSync(PROCESSED_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const messages = [];

  // Alert (once) on anything that's been stuck mid-pipeline for a while.
  for (const status of readAllStatuses(DATA_DIR)) {
    if (!status.stage || status.stage === "finalized") continue;
    const ageMs = Date.now() - new Date(status.updatedAt).getTime();
    if (ageMs > STUCK_MS && !status.alerted) {
      messages.push(
        `Stuck: "${status.originalName || status.baseName}" has been at stage "${status.stage}" for over 20 minutes${status.message ? ` — ${status.message}` : ""}.`
      );
      writeStatus(DATA_DIR, status.baseName, { alerted: true });
    }
  }

  const hasKeys = !!process.env.DEEPGRAM_API_KEY && !!process.env.ANTHROPIC_API_KEY;
  const files = fs
    .readdirSync(INCOMING_DIR)
    .filter((f) => fs.statSync(path.join(INCOMING_DIR, f)).isFile());

  if (!hasKeys) {
    console.log(messages.length ? messages.join("\n") : "NO_REPLY");
    return;
  }

  for (const file of files) {
    const inputPath = path.join(INCOMING_DIR, file);
    // Strip the "-<timestamp>" suffix the upload endpoint appends before the extension.
    const originalName = file.replace(/-\d+(\.[a-zA-Z0-9]+)$/, "$1");
    try {
      // Resume from an already-completed transcription instead of re-running
      // Deepgram on every retry (e.g. when a later stage failed or the keys
      // weren't set yet when this file first landed).
      let summary = null;
      const existingStatusFile = statusPath(DATA_DIR, file);
      if (fs.existsSync(existingStatusFile)) {
        const existing = JSON.parse(fs.readFileSync(existingStatusFile, "utf8"));
        if (existing.rawTranscriptPath && fs.existsSync(existing.rawTranscriptPath)) {
          summary = existing;
        }
      }
      if (!summary) {
        const ingestOut = execFileSync("node", [path.join(ROOT, "ingest.js"), inputPath, originalName], {
          cwd: ROOT,
          encoding: "utf8",
        });
        summary = JSON.parse(ingestOut);
      }

      const correctedPath = path.join(TMP_DIR, `${summary.baseName}-corrected.txt`);
      execFileSync("node", [path.join(ROOT, "correct.js"), summary.rawTranscriptPath, correctedPath], { cwd: ROOT });
      writeStatus(DATA_DIR, file, { stage: "corrected" });

      const notesJsonPath = path.join(TMP_DIR, `${summary.baseName}-notes.json`);
      execFileSync("node", [path.join(ROOT, "notesgen.js"), correctedPath, notesJsonPath], { cwd: ROOT });
      const notesData = JSON.parse(fs.readFileSync(notesJsonPath, "utf8"));
      writeStatus(DATA_DIR, file, { stage: "notes_generated" });

      const quickrefPath = path.join(TMP_DIR, `${summary.baseName}-quickref.json`);
      fs.writeFileSync(quickrefPath, JSON.stringify(notesData.quickref || {}, null, 2));
      const notesMarkdownPath = path.join(TMP_DIR, `${summary.baseName}-notes.md`);
      fs.writeFileSync(notesMarkdownPath, notesData.notesMarkdown || "");

      const displayName = originalName.replace(/\.[^.]+$/, "").trim();

      execFileSync(
        "node",
        [
          path.join(ROOT, "finalize.js"),
          summary.slug,
          displayName,
          summary.date,
          notesData.topic,
          correctedPath,
          notesMarkdownPath,
          summary.audioFile,
          String(summary.durationSec ?? ""),
          quickrefPath,
        ],
        { cwd: ROOT }
      );

      clearStatus(DATA_DIR, file);
      fs.renameSync(inputPath, path.join(PROCESSED_DIR, file));

      messages.push(`New lecture live: ${displayName} — "${notesData.topic}" https://pierceoxley.ca/notes/${summary.slug}/`);
    } catch (e) {
      writeStatus(DATA_DIR, file, { stage: "error", message: String(e.message || e).slice(0, 500) });
    }
  }

  console.log(messages.length ? messages.join("\n") : "NO_REPLY");
}

run();
