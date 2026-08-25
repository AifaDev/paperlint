#!/usr/bin/env node
/**
 * install-glossary.mjs — install a curated vocabulary as the glossary this
 * pipeline checks against.
 *
 *   node scripts/install-glossary.mjs <path-to-glossary.json> [--name "Its Name"] [--url https://…]
 *   npm run glossary:install -- <path> --name "Its Name"
 *
 * A raw export is usually a bare JSON array, which carries no record of where
 * it came from. Copying one in with `cp` therefore installs a vocabulary the UI
 * cannot credit, and the credit is lost again the next time the file is copied.
 * This wraps it in the attributed envelope the loader also accepts, so the
 * attribution travels inside the data.
 *
 * It writes data/glossary.json, which the loader prefers over the bundled
 * example with no further configuration.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readGlossaryFile, toSeedTerms } from "./glossary-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith("--"));
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1] ?? null;
};

if (!source) {
  console.error(
    `usage: node scripts/install-glossary.mjs <path-to-glossary.json> [--name "Its Name"] [--url https://…]\n\n` +
      `Installs a curated vocabulary at data/glossary.json. The loader picks it up\n` +
      `automatically; nothing else needs configuring.`,
  );
  process.exit(1);
}
if (!fs.existsSync(source)) {
  console.error(`No such file: ${source}`);
  process.exit(1);
}

let entries;
try {
  ({ entries } = readGlossaryFile(path.resolve(source)));
} catch (err) {
  console.error(`That file is not a glossary this pipeline can read.\n  ${err.message}`);
  process.exit(1);
}

/* Refuse input that would install silently: the matcher reads the English term
   off every entry, so a file without one can never produce a finding. */
const usable = toSeedTerms(entries);
if (usable.length === 0) {
  console.error(
    `Read ${entries.length} entries, but none carry an English term (en.term), so the\n` +
      `glossary check could never fire. Nothing was installed.`,
  );
  process.exit(1);
}

const name = flag("name");
const url = flag("url");
const envelope = {
  ...(name ? { source: name } : {}),
  ...(url ? { source_url: url } : {}),
  ...(name
    ? {
        attribution:
          `Vocabulary (c) ${name}. Bundled with paperlint and credited as its owner's work. ` +
          `The MIT licence covering paperlint's code does not govern this vocabulary; ` +
          `keep this attribution with it.`,
      }
    : {}),
  count: entries.length,
  terms: entries,
};

const target = path.join(ROOT, "data", "glossary.json");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(envelope, null, 0)}\n`);

console.log(`Installed ${entries.length} entries (${usable.length} with an English term) -> data/glossary.json`);
if (name) {
  console.log(`Credited to: ${name}${url ? ` (${url})` : ""}`);
} else {
  console.log(
    `No --name given, so the interface will name the file rather than a vocabulary.\n` +
      `Re-run with --name "…" to have it credited by name.`,
  );
}
console.log("Restart the server to pick it up.");
