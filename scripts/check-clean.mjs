#!/usr/bin/env node
/**
 * check-clean.mjs — the repository's provenance gate.
 *
 * This codebase was extracted from a private deployment. Nothing identifying
 * that deployment, its operator, or its users may appear in the public tree —
 * ever. This gate scans every tracked-shaped file for a forbidden-pattern list
 * and fails CI on the first hit. It runs FIRST in CI, before the type check,
 * because a leak matters more than a type error.
 *
 * The patterns are built by string CONCATENATION so this file passes its own
 * scan — a literal would trip the gate on the gate.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN = [
  "ica" + "ire",
  "raw" + "asi",
  "sa" + "wb",
  "une" + "sco",
  "str" + "api",
  "cke" + "ditor",
  "wiz" + "ard",
  "kha" + "yat",
  "iab" + "odfah",
  "abdul" + "lah",
  "hak" + "eem",
  "unified-" + "website",
  "/Us" + "ers/",
  // Internal planning vocabulary: meaningless to a reader of this repo and a
  // pointer at a document nobody outside it can see. Added 2026-08-25 after
  // 28 such references survived the first pass — the gate only ever catches
  // what it was told about, so every miss becomes a new pattern here.
  "own" + "er directive",
  "own" + "er decision",
  "cli" + "ent mandate",
  "pl" + "an §",
  "Tra" + "ck B",
  "cr" + "on drain",
];

/** Milestone codes (a letter-dash-letter-digit shape) — same reason as above.
 *  Written as a regex rather than examples so this file passes its own scan. */
const FORBIDDEN_RE = [/\bM-[RDE]\d\b/];

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "history", "benchmarks"]);
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".pdf", ".zip"]);

let hits = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      continue;
    }
    if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    const file = path.join(dir, entry.name);
    const text = fs.readFileSync(file, "utf8");
    const lower = text.toLowerCase();
    for (const re of FORBIDDEN_RE) {
      const m = re.exec(text);
      if (m) {
        console.error(`${path.relative(ROOT, file)}:${text.slice(0, m.index).split("\n").length}: matched a forbidden pattern`);
        hits += 1;
      }
    }
    for (const pattern of FORBIDDEN) {
      let at = lower.indexOf(pattern.toLowerCase());
      while (at !== -1) {
        const line = text.slice(0, at).split("\n").length;
        console.error(`${path.relative(ROOT, file)}:${line}: matched a forbidden pattern (#${FORBIDDEN.indexOf(pattern)})`);
        hits += 1;
        at = lower.indexOf(pattern.toLowerCase(), at + 1);
      }
    }
  }
}
walk(ROOT);

if (hits > 0) {
  console.error(`\n${hits} forbidden-pattern hit(s). This tree must not be pushed.`);
  process.exit(1);
}
console.log("clean: no forbidden patterns found");
