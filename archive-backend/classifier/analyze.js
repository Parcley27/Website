const L = require("./labels.js");
const f = process.argv[2];
const out = require("./" + f);
const grp = Object.fromEntries(L.map((l) => [l.text, l.group]));
const score = (o, g, mode) => {
  const v = Object.entries(o.scores).filter(([k]) => grp[k] === g).map(([, s]) => s);
  return mode === "max" ? Math.max(...v) : v.reduce((a, b) => a + b, 0);
};
for (const mode of ["sum", "max"]) {
  console.log(`== ${f} ${mode}`);
  const clin = out.filter((o) => o.truth === "clinical"), fam = out.filter((o) => o.truth === "family");
  for (const t of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) {
    const tp = clin.filter((o) => score(o, "medical", mode) > t).length;
    const fp = fam.filter((o) => score(o, "medical", mode) > t).length;
    const dfp = fam.filter((o) => score(o, "document", mode) > t).length;
    console.log(`t=${t}: clinical caught ${tp}/${clin.length} (${(100*tp/clin.length).toFixed(0)}%), family wrongly flagged medical ${fp}/${fam.length} (${(100*fp/fam.length).toFixed(1)}%), family flagged document ${dfp}`);
  }
  // argmax group
  const am = (o) => { let best = null; for (const [k, s] of Object.entries(o.scores)) if (!best || s > best[1]) best = [k, s]; return grp[best[0]]; };
  console.log("argmax: clinical->medical", out.filter((o) => o.truth === "clinical" && am(o) === "medical").length, "family->medical", out.filter((o) => o.truth === "family" && am(o) === "medical").length, "family->document", out.filter((o) => o.truth === "family" && am(o) === "document").length);
}
