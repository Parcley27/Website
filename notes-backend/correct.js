// LLM correction pass: cleans up the raw Deepgram transcript via the Anthropic API.
// Usage: node correct.js <raw-transcript-path> <out-path>
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

const SYSTEM_PROMPT = `You are cleaning up a raw speech-to-text transcript of a university lecture, recorded on a phone (sometimes from across a room, with group discussion mixed in). Your job:

- Fix clear STT mishearings: words or phrases that don't make sense in context, especially technical/academic terms that got misheard as an unrelated common word.
- Lightly clean up disfluencies (false starts, excessive "right"/"okay"/"you know" filler, stutters and word repeats) ONLY where removing them doesn't lose meaning. Keep the lecturer's actual explanations, examples, and the substance of any class discussion intact.
- Add paragraph breaks and light punctuation for readability.
- Do NOT summarize, shorten, paraphrase away detail, or omit any real content. Do NOT invent content that wasn't there. If a passage is genuinely unintelligible, leave your best-guess reconstruction rather than deleting it.

Return ONLY the corrected transcript text — no preamble, no headers, no explanation of your changes.`;

async function main() {
  const [rawTranscriptPath, outPath] = process.argv.slice(2);
  if (!rawTranscriptPath || !outPath) {
    console.error("Usage: node correct.js <raw-transcript-path> <out-path>");
    process.exit(1);
  }
  const raw = fs.readFileSync(rawTranscriptPath, "utf8");
  const corrected = await callAnthropic(SYSTEM_PROMPT, raw, 16000);
  fs.writeFileSync(outPath, corrected.trim() + "\n");
  console.log(outPath);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
