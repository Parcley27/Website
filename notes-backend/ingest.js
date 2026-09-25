// Deterministic half of the lecture pipeline: takes a raw voice memo file,
// figures out class + date, sends it to Deepgram for transcription, and stages
// the audio + raw transcript for the LLM correction/notes passes to pick up.
// Usage: node ingest.js <path-to-audio-file> <original-filename>
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const https = require("https");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeStatus } = require("./status");

const DATA_DIR = path.join(__dirname, "data");
const MEDIA_DIR = path.join(__dirname, "media");
const AUDIO_DIR = path.join(MEDIA_DIR, "audio");
const TRANSCRIPT_DIR = path.join(MEDIA_DIR, "transcripts");
const KEYWORDS_DIR = path.join(DATA_DIR, "keywords");
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\.[^.]+$/, "") // strip extension
    .replace(/[^a-z0-9]+/g, "");
}

function getCreationDate(filePath) {
  try {
    const out = execFileSync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_entries", "format_tags=creation_time",
      filePath,
    ]).toString();
    const parsed = JSON.parse(out);
    const creationTime = parsed.format?.tags?.creation_time;
    if (creationTime) return creationTime.slice(0, 10);
  } catch (e) {
    console.error("ffprobe metadata read failed, falling back to mtime:", e.message);
  }
  return fs.statSync(filePath).mtime.toISOString().slice(0, 10);
}

function loadKeywords(slug) {
  const file = path.join(KEYWORDS_DIR, `${slug}.txt`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// Voice-memo recordings vary a lot in loudness (phone in a pocket vs. on a
// desk vs. across a room) and it turns out raw dB level alone doesn't predict
// whether Deepgram will return a full transcript or a truncated few-hundred-
// word fragment — some -40dB recordings transcribe completely fine, some
// -29dB ones don't. So rather than guess a threshold, every file gets run
// through loudnorm before transcription; it's a no-op in effect for already-
// healthy audio and fixes the quiet ones. The original, unboosted file is
// still what's kept for the "download recording" link — this is purely a
// transcription-time preprocessing step.
function normalizeForTranscription(audioPath) {
  const tmpPath = path.join(os.tmpdir(), `notes-boost-${path.basename(audioPath)}`);
  execFileSync(
    "ffmpeg",
    ["-y", "-i", audioPath, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "16000", tmpPath],
    { stdio: ["ignore", "ignore", "ignore"] }
  );
  return tmpPath;
}

function transcribe(filePath, keywords) {
  return new Promise((resolve, reject) => {
    if (!DEEPGRAM_API_KEY) return reject(new Error("DEEPGRAM_API_KEY not set"));
    const ext = path.extname(filePath).toLowerCase();
    const mime = { ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav" }[ext] || "audio/mp4";
    const params = new URLSearchParams({
      model: "nova-3",
      smart_format: "true",
      punctuate: "true",
      paragraphs: "true",
    });
    for (const kw of keywords) params.append("keyterm", kw);

    const data = fs.readFileSync(filePath);
    const req = https.request(
      {
        hostname: "api.deepgram.com",
        path: `/v1/listen?${params.toString()}`,
        method: "POST",
        headers: {
          Authorization: `Token ${DEEPGRAM_API_KEY}`,
          "Content-Type": mime,
          "Content-Length": data.length,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`Deepgram ${res.statusCode}: ${body}`));
          resolve(JSON.parse(body));
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const [inputPath, originalName] = process.argv.slice(2);
  if (!inputPath || !originalName) {
    console.error("Usage: node ingest.js <path-to-audio-file> <original-filename>");
    process.exit(1);
  }

  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });

  // The uploaded filename (already unique, assigned at upload time) is the one
  // identifier known from the moment the file lands, so it's what the status
  // display keys off of throughout the whole pipeline.
  const statusKey = path.basename(inputPath);
  const slug = slugify(originalName);
  writeStatus(DATA_DIR, statusKey, { stage: "transcribing", slug, originalName });

  const date = getCreationDate(inputPath);
  const ext = path.extname(inputPath) || path.extname(originalName) || ".m4a";
  const baseName = `${date}-${slug}-${Date.now()}`;

  const audioDest = path.join(AUDIO_DIR, `${baseName}${ext}`);
  fs.copyFileSync(inputPath, audioDest);

  const keywords = loadKeywords(slug);
  let boostedTmpPath = null;
  let transcribeSourcePath = audioDest;
  try {
    boostedTmpPath = normalizeForTranscription(audioDest);
    transcribeSourcePath = boostedTmpPath;
  } catch (e) {
    console.error("Loudness normalization failed, falling back to original audio:", e.message);
  }

  let result;
  try {
    result = await transcribe(transcribeSourcePath, keywords);
  } catch (e) {
    writeStatus(DATA_DIR, statusKey, { stage: "error", message: e.message });
    throw e;
  } finally {
    if (boostedTmpPath) {
      try {
        fs.unlinkSync(boostedTmpPath);
      } catch {
        // best-effort cleanup, not worth failing the run over
      }
    }
  }
  const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.paragraphs?.transcript
    || result.results?.channels?.[0]?.alternatives?.[0]?.transcript
    || "";

  const rawTranscriptPath = path.join(TRANSCRIPT_DIR, `${baseName}-raw.txt`);
  fs.writeFileSync(rawTranscriptPath, transcript);

  const summary = {
    slug,
    date,
    baseName,
    audioFile: path.basename(audioDest),
    rawTranscriptFile: path.basename(rawTranscriptPath),
    rawTranscriptPath,
    audioPath: audioDest,
    durationSec: result.metadata?.duration ?? null,
  };

  writeStatus(DATA_DIR, statusKey, { stage: "transcribed", ...summary });
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
