# Credits

## Origin

paperlint began as the submission-review pipeline for **[ICAIRE](https://icaire.org)**,
the International Center for AI Research and Ethics, and is extracted and
published here with its permission. Every design decision that survives in this
repository — deterministic candidates before any model call, abstention over
accusation, a measurement shipped beside every claim — was worked out against
real submissions there.

## The glossary layer

The terminology check (`src/matcher.ts`) uses the **ICAIRE AI Glossary** — a
curated multilingual (English/Arabic/French) vocabulary of ~1,300 AI terms,
published at **<https://icaire.org/glossary>**. That glossary is what taught this
layer its rules, and most of them are lessons learned from it rather than ideas
invented here:

- **Abstain when a surface form maps to more than one entry.** A real glossary
  is measurably many-to-many; guessing which term an author meant is how a
  terminology checker starts inventing mistakes.
- **Never flag an accepted form.** Canonical spellings and recorded variants are
  correct writing, not near-misses.
- **Exclude cross-reference stubs.** A `See "…"` entry is a pointer, not a
  concept, so it must neither fire nor be suggested.
- **Single common words need an explicit allowlist.** Entries like *Security* or
  *Frame* would otherwise flood ordinary prose with hits.

**The glossary ships with this repository**, at `data/glossary.json` — 1,297
entries in English, Arabic and French — and is loaded automatically. It carries
its own attribution header so the credit survives the file being copied
elsewhere. `data/glossary.example.json` remains as a 33-term stand-in showing
the format; `PAPERLINT_GLOSSARY` overrides both.

The vocabulary is ICAIRE's work, not paperlint's. The MIT licence on this
repository's code does not govern it: if you reuse the vocabulary, keep the
attribution with it.

The glossary is ICAIRE's work and is credited as theirs wherever it is used. If
you bundle a copy alongside this MIT-licensed code, note that the code licence
does not automatically govern the vocabulary: keep the attribution above with
it.

## Prior work this borrows from

Two student projects built on ICAIRE's AI Glossary Challenge shaped the
architecture, and the most useful thing each contributed was a negative result:

- One reported a headline accuracy near 99% that turned out, on inspection, to be
  a dictionary lookup: its own provenance field read "exact match" on every row
  and "model" on none, so the model it was built around decided nothing. Its
  honest core — look the term up, compare, report both values — became the
  glossary layer here, and the field that exposed the problem became
  `decided_by`, recorded on every finding this pipeline emits.
- The other measured whether feeding glossary definitions to a model helped, and
  published that all six retrieval variants it tried made results *worse*. That
  is why the glossary in this pipeline stays entirely in deterministic code and
  is never handed to the model layer.

The wider design also draws on published work: SciFact/VERISCI for three-way
claim verification with abstention as a first-class label, scite.ai for the
insight that most citations merely *mention* a work and assert nothing it must
support, and RAGAS/ARES for claim-level rather than sentence-level judgement.
Crossref, DataCite, doi.org, arXiv and OpenAlex provide the citation and
retraction data the deterministic layers depend on.
