#!/usr/bin/env node
// Helps measure safegate's precision on real repositories.
//
// 1) Export findings to a labeling sheet:
//      node dist/src/cli.js check --root ../some-repo --format json --fail-on none > some-repo.json
//      node scripts/precision.mjs to-csv some-repo.json some-repo >> labels.csv
// 2) Open labels.csv, read each finding in the code, and fill the "label" column with TP or FP
//    (TP = a real bug or a real risk you would want flagged; FP = noise). Add notes.
// 3) Score it:
//      node scripts/precision.mjs score labels.csv
import fs from "node:fs";

const [, , cmd, file, repo] = process.argv;
const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

if (cmd === "to-csv") {
  if (!file || !repo) throw new Error("usage: precision.mjs to-csv <findings.json> <repo-name>");
  const { findings } = JSON.parse(fs.readFileSync(file, "utf8"));
  const header = ["repo", "rule", "severity", "file", "line", "message", "label", "notes"];
  if (!fs.existsSync("labels.csv") || fs.statSync("labels.csv").size === 0) console.log(header.join(","));
  for (const f of findings) console.log([repo, f.ruleId, f.severity, f.file, f.line, f.message, "", ""].map(csvEscape).join(","));
} else if (cmd === "score") {
  if (!file) throw new Error("usage: precision.mjs score <labels.csv>");
  const [header, ...rows] = parseCsv(fs.readFileSync(file, "utf8")).filter((r) => r.length > 1);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const by = new Map();
  let unlabeled = 0;
  for (const r of rows) {
    const label = (r[idx.label] || "").trim().toUpperCase();
    if (label !== "TP" && label !== "FP") { unlabeled++; continue; }
    for (const key of [r[idx.rule], `ALL ${r[idx.severity]}`, "ALL"]) {
      const s = by.get(key) || { tp: 0, fp: 0 };
      label === "TP" ? s.tp++ : s.fp++;
      by.set(key, s);
    }
  }
  console.log("rule".padEnd(12), "TP".padStart(4), "FP".padStart(4), "precision".padStart(10));
  for (const [k, s] of [...by].sort()) {
    const p = s.tp + s.fp ? ((100 * s.tp) / (s.tp + s.fp)).toFixed(0) + "%" : "-";
    console.log(k.padEnd(12), String(s.tp).padStart(4), String(s.fp).padStart(4), p.padStart(10));
  }
  if (unlabeled) console.log(`\n${unlabeled} rows not labeled yet`);
} else {
  console.log("usage: precision.mjs to-csv <findings.json> <repo> | score <labels.csv>");
  process.exit(2);
}
