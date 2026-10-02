// AI helpers for the class pages: "ask" (question answered from a whole course's
// notes, via the search bar) and "explain" (highlight a passage in one lecture's
// notes and get it expanded on). Both stream plain text back to the browser.
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const DATA_DIR = path.join(__dirname, "data", "classes");
const USAGE_FILE = path.join(__dirname, "data", "ai-usage.json");
const TRANSCRIPT_DIR = path.join(__dirname, "media", "transcripts");

const ASK_MODEL = "claude-sonnet-5-5";
const EXPLAIN_MODEL = "claude-haiku-4-5";

// Hard ceiling on AI requests per day (asks + explains combined), so a stuck
// retry loop or a bug in the page can't quietly run up the API bill.
const DAILY_LIMIT = 200;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function loadClass(slug) {
  if (!/^[a-z0-9-]+$/.test(slug || "")) return null;
  const file = path.join(DATA_DIR, `${slug}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function todayPacific() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Vancouver" });
}

// Returns false (and doesn't count the request) once today's limit is hit.
function takeUsageSlot() {
  const today = todayPacific();
  let usage = { date: today, count: 0 };
  try {
    const saved = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
    if (saved.date === today) usage = saved;
  } catch {
    // missing or unreadable file just means a fresh day
  }
  if (usage.count >= DAILY_LIMIT) return false;
  usage.count += 1;
  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));
  return true;
}

// The whole course as one stable text block. Lectures go oldest-first and every
// field is deterministic, so repeat questions on the same course hit the prompt
// cache until a new lecture lands.
function courseContext(data) {
  const lectures = [...(data.lectures || [])].sort((a, b) => a.date.localeCompare(b.date));
  const parts = [`# ${data.displayName} — course notes`];
  for (const g of data.studyGuides || []) {
    parts.push(`<study_guide cite="guide:${g.id}" title="${g.title}">\n${g.notesMarkdown}\n</study_guide>`);
  }
  for (const l of lectures) {
    parts.push(`<lecture cite="${l.date}" topic="${l.topic}">\n${l.notesMarkdown}\n</lecture>`);
  }
  return parts.join("\n\n");
}

const ASK_SYSTEM = `You answer a university student's questions about one of their courses, using the lecture notes and study guides below (generated from recordings of their own lectures).

- Ground the answer in the notes. Cite where each point comes from with the source's cite tag in square brackets, e.g. [2026-09-14] for a lecture or [guide:quiz2] for a study guide, placed right after the sentence it supports.
- If the notes don't cover something, say so plainly, then give a brief general explanation clearly marked as not from their lectures.
- Be direct and compact: a short paragraph or a few bullets is usually right. Use markdown. Write math as LaTeX between $...$ (inline) or $$...$$ (display).`;

const EXPLAIN_SYSTEM = `A university student highlighted a passage in their lecture notes and wants it explained. Explain the highlighted passage clearly and concisely: what it means, why it matters, and a quick example or intuition if one helps. Use the surrounding notes (and the lecture transcript, when given) for context, and stay consistent with how their lecturer framed it. Keep it short — a few sentences to a short paragraph, no headings. Use markdown sparingly; write math as LaTeX between $...$ or $$...$$.`;

// Pipes a Messages stream to an Express response as plain text.
async function pipeStream(stream, res, label) {
  let done = false;
  res.on("close", () => {
    if (!done) stream.abort(); // browser navigated away mid-answer
  });
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no", // otherwise nginx holds the whole answer until it's done
  });
  stream.on("text", (text) => res.write(text));
  try {
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") res.write("\n\n*(The model declined to answer this one.)*");
    else if (msg.stop_reason === "max_tokens") res.write("\n\n*(Answer cut off — try a narrower question.)*");
    const u = msg.usage;
    console.log(`${label}: ${msg.model} in=${u.input_tokens} cache_read=${u.cache_read_input_tokens || 0} cache_write=${u.cache_creation_input_tokens || 0} out=${u.output_tokens}`);
  } catch (err) {
    if (!res.writableEnded && !res.destroyed) res.write(`\n\n*(Error: ${err.message})*`);
    if (!(err instanceof Anthropic.APIUserAbortError)) console.error(`${label} failed:`, err.message);
  }
  done = true;
  res.end();
}

async function ask(req, res) {
  const { slug, question } = req.body || {};
  const data = loadClass(slug);
  if (!data) return res.status(404).json({ error: "class not found" });
  if (!question || typeof question !== "string" || question.length > 2000) {
    return res.status(400).json({ error: "question missing or too long" });
  }
  if (!takeUsageSlot()) return res.status(429).json({ error: `daily AI limit (${DAILY_LIMIT}) reached — resets at midnight` });

  const stream = client.beta.messages.stream({
    model: ASK_MODEL,
    max_tokens: 4000,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [
      { type: "text", text: ASK_SYSTEM },
      { type: "text", text: courseContext(data), cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: question }],
  });
  await pipeStream(stream, res, `ask ${slug}`);
}

async function explain(req, res) {
  const { slug, sourceId, selection, deeper } = req.body || {};
  const data = loadClass(slug);
  if (!data) return res.status(404).json({ error: "class not found" });
  if (!selection || typeof selection !== "string" || selection.length > 3000) {
    return res.status(400).json({ error: "selection missing or too long" });
  }
  const lecture = (data.lectures || []).find((l) => l.id === sourceId);
  const guide = (data.studyGuides || []).find((g) => g.id === sourceId);
  const source = lecture || guide;
  if (!source) return res.status(404).json({ error: "lecture not found" });
  if (!takeUsageSlot()) return res.status(429).json({ error: `daily AI limit (${DAILY_LIMIT}) reached — resets at midnight` });

  const title = lecture ? `${data.displayName} lecture, ${lecture.date}: ${lecture.topic}` : `${data.displayName} study guide: ${guide.title}`;
  let context = `<notes title="${title}">\n${source.notesMarkdown}\n</notes>`;
  if (deeper && lecture && lecture.transcriptFile) {
    const transcriptPath = path.join(TRANSCRIPT_DIR, path.basename(lecture.transcriptFile));
    if (fs.existsSync(transcriptPath)) {
      context += `\n\n<transcript>\n${fs.readFileSync(transcriptPath, "utf8")}\n</transcript>`;
    }
  }

  const stream = client.messages.stream({
    model: EXPLAIN_MODEL,
    max_tokens: deeper ? 2500 : 1200,
    system: EXPLAIN_SYSTEM,
    messages: [
      {
        role: "user",
        content: `${context}\n\nHighlighted passage:\n<highlight>\n${selection}\n</highlight>${deeper ? "\n\nGo deeper than the notes do — draw on the transcript for what the lecturer actually said." : ""}`,
      },
    ],
  });
  await pipeStream(stream, res, `explain ${slug}${deeper ? " (deeper)" : ""}`);
}

module.exports = { ask, explain };
