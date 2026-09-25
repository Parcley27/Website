// Second half of the pipeline: registers a finished lecture (corrected transcript
// + generated notes, both already written to disk by the LLM passes) into that
// class's data file. Usage:
//   node finalize.js <slug> <displayName> <date> <topic> <correctedTranscriptPath> <notesMarkdownPath> <audioFileName> <durationSec> [quickrefJsonPath]
//
// quickrefJsonPath (optional) points to a JSON file:
//   { "terms": [{"term": "...", "definition": "..."}], "equations": [{"name": "...", "expression": "...", "description": "..."}] }
// New entries are merged into the class's running keyTerms/keyEquations (deduped
// case-insensitively by term/name) — this is the per-course quick-reference list
// shown at the top of the class page, built up incrementally across lectures.
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data", "classes");
const TRANSCRIPT_DIR = path.join(__dirname, "media", "transcripts");

function mergeByKey(existing, incoming, key) {
  const list = [...(existing || [])];
  for (const item of incoming || []) {
    const idx = list.findIndex((e) => (e[key] || "").toLowerCase() === (item[key] || "").toLowerCase());
    if (idx >= 0) {
      list[idx] = item; // newer definition/expression wins
    } else {
      list.push(item);
    }
  }
  return list;
}

function main() {
  const [slug, displayName, date, topic, correctedTranscriptPath, notesMarkdownPath, audioFileName, durationSec, quickrefJsonPath] =
    process.argv.slice(2);
  if (!slug || !displayName || !date || !topic || !correctedTranscriptPath || !notesMarkdownPath || !audioFileName) {
    console.error(
      "Usage: node finalize.js <slug> <displayName> <date> <topic> <correctedTranscriptPath> <notesMarkdownPath> <audioFileName> <durationSec> [quickrefJsonPath]"
    );
    process.exit(1);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });

  const transcriptFileName = `${date}-${slug}-transcript.txt`;
  fs.copyFileSync(correctedTranscriptPath, path.join(TRANSCRIPT_DIR, transcriptFileName));

  const notesMarkdown = fs.readFileSync(notesMarkdownPath, "utf8");

  const dataFile = path.join(DATA_DIR, `${slug}.json`);
  let classData = { slug, displayName, keyTerms: [], keyEquations: [], lectures: [] };
  if (fs.existsSync(dataFile)) {
    classData = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    classData.keyTerms = classData.keyTerms || [];
    classData.keyEquations = classData.keyEquations || [];
  }

  classData.lectures.push({
    id: `${date}-${slug}`,
    date,
    topic,
    notesMarkdown,
    transcriptFile: transcriptFileName,
    audioFile: audioFileName,
    durationSec: durationSec ? Number(durationSec) : null,
    createdAt: new Date().toISOString(),
  });
  classData.lectures.sort((a, b) => a.date.localeCompare(b.date));

  if (quickrefJsonPath && fs.existsSync(quickrefJsonPath)) {
    const quickref = JSON.parse(fs.readFileSync(quickrefJsonPath, "utf8"));
    classData.keyTerms = mergeByKey(classData.keyTerms, quickref.terms, "term");
    classData.keyEquations = mergeByKey(classData.keyEquations, quickref.equations, "name");
  }

  fs.writeFileSync(dataFile, JSON.stringify(classData, null, 2));
  console.log(`Registered lecture ${date} for ${slug} (${classData.lectures.length} total lectures)`);
}

main();
