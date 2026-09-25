// LLM notes-generation pass: turns a corrected transcript into a topic title,
// structured markdown notes, and quick-reference terms/equations, via the
// Anthropic API. Usage: node notesgen.js <corrected-transcript-path> <out-json-path>
const fs = require("fs");
const path = require("path");
const https = require("https");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-5";

function callAnthropic(system, userText, maxTokens) {
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_API_KEY) return reject(new Error("ANTHROPIC_API_KEY not set"));
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userText }],
    });
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`Anthropic ${res.statusCode}: ${data}`));
          const parsed = JSON.parse(data);
          const text = (parsed.content || []).map((b) => b.text || "").join("");
          resolve(text);
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const SYSTEM_PROMPT = `You are turning a corrected university lecture transcript into study notes for a student reviewing this lecture later.

Respond with ONLY a single valid JSON object (no markdown code fences, no extra text before or after) with this exact shape:
{
  "topic": "A short, specific topic title for this lecture, 4-10 words, summarizing what was actually covered",
  "notesMarkdown": "Structured markdown notes: use ## headings for major sections, bullet points for details, **bold** for key terms. Cover everything substantive that was taught or discussed, organized logically (not necessarily in the same order it was said). Do not pad with generic filler.",
  "quickref": {
    "terms": [{"term": "...", "definition": "..."}],
    "equations": [{"name": "...", "expression": "...", "description": "..."}]
  }
}

Only include entries in "quickref" that are genuinely reusable reference material (real definitions, named formulas) — not every detail needs one, and it's fine for either array to be empty.`;

async function main() {
  const [correctedTranscriptPath, outJsonPath] = process.argv.slice(2);
  if (!correctedTranscriptPath || !outJsonPath) {
    console.error("Usage: node notesgen.js <corrected-transcript-path> <out-json-path>");
    process.exit(1);
  }
  const transcript = fs.readFileSync(correctedTranscriptPath, "utf8");
  const raw = await callAnthropic(SYSTEM_PROMPT, transcript, 8192);

  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch (e) {
    throw new Error(`Failed to parse notes JSON from model output: ${e.message}\n---\n${raw.slice(0, 500)}`);
  }
  if (!parsed.topic || !parsed.notesMarkdown) {
    throw new Error(`Notes JSON missing required fields (topic/notesMarkdown)\n---\n${raw.slice(0, 500)}`);
  }
  parsed.quickref = parsed.quickref || { terms: [], equations: [] };

  fs.writeFileSync(outJsonPath, JSON.stringify(parsed, null, 2));
  console.log(outJsonPath);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
