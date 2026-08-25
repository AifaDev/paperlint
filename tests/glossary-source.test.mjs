/**
 * Which vocabulary the terminology layer loads is a correctness question, not a
 * convenience one: a silent fall back to the 33-term example makes the layer
 * look quietly broken rather than unconfigured, and a rate measured against one
 * vocabulary means nothing quoted against another. So the resolution order and
 * both accepted file shapes are pinned here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveGlossaryPath, readGlossaryFile, loadGlossary, toSeedTerms } from "../scripts/glossary-source.mjs";

const ENTRY = { slug: "gradient-descent", en: { term: "Gradient Descent", definition: "An optimization method." } };

/** A throwaway repo root with whichever data files the case needs. */
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperlint-glossary-"));
  fs.mkdirSync(path.join(root, "data"));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, "data", name), JSON.stringify(body));
  }
  return root;
}

test("falls back to the example only when no real glossary is present", () => {
  const root = fixture({ "glossary.example.json": [ENTRY] });
  const { file, reason } = resolveGlossaryPath(root);
  assert.equal(path.basename(file), "glossary.example.json");
  assert.equal(reason, "example");
});

test("prefers data/glossary.json over the bundled example", () => {
  const root = fixture({ "glossary.example.json": [ENTRY], "glossary.json": [ENTRY, ENTRY] });
  const { file, reason } = resolveGlossaryPath(root);
  assert.equal(path.basename(file), "glossary.json");
  assert.equal(reason, "bundled");
});

test("PAPERLINT_GLOSSARY beats both", () => {
  const root = fixture({ "glossary.example.json": [ENTRY], "glossary.json": [ENTRY] });
  const custom = path.join(root, "data", "custom.json");
  fs.writeFileSync(custom, JSON.stringify([ENTRY]));
  process.env.PAPERLINT_GLOSSARY = custom;
  try {
    const { file, reason } = resolveGlossaryPath(root);
    assert.equal(file, custom);
    assert.equal(reason, "PAPERLINT_GLOSSARY");
  } finally {
    delete process.env.PAPERLINT_GLOSSARY;
  }
});

test("reads a bare array — the shape a raw glossary export arrives in", () => {
  const root = fixture({ "glossary.json": [ENTRY, ENTRY] });
  const { entries, source, attribution } = readGlossaryFile(path.join(root, "data", "glossary.json"));
  assert.equal(entries.length, 2);
  assert.equal(source, null);
  assert.equal(attribution, null);
});

test("reads an attributed envelope and keeps the credit with the data", () => {
  const root = fixture({
    "glossary.json": { source: "Example Glossary", attribution: "(c) someone", terms: [ENTRY] },
  });
  const loaded = loadGlossary(root);
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.source, "Example Glossary");
  assert.equal(loaded.attribution, "(c) someone");
  // The label is what the server prints on boot, so the source has to be in it.
  assert.match(loaded.label, /Example Glossary/);
});

test("a malformed glossary throws instead of silently loading nothing", () => {
  const root = fixture({ "glossary.json": { nope: true } });
  assert.throws(() => loadGlossary(root), /expected a JSON array of terms/);
});

test("toSeedTerms drops entries with no English term rather than emitting blanks", () => {
  const seeds = toSeedTerms([ENTRY, { slug: "ar-only", ar: { term: "لا يوجد" } }]);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].term, "Gradient Descent");
  assert.equal(seeds[0].slug, "gradient-descent");
});
