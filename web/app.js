/* =============================================================================
   paperlint — The Plate. Vanilla JS, no build step.

   Three steps, one on screen at a time: hand over the paper, read what the 16
   checks found, then step into the text. The world's rule carried into
   behaviour: severity is diameter, and the same ramp is used by the legend, the
   check rows and the canvas — so a big dot means the same thing everywhere.
   ========================================================================== */

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const KEY_STORE = "paperlint.api_key";
const URL_STORE = "paperlint.base_url";
const MODEL_STORE = "paperlint.model";

let serverKey = false;
let lastSource = { kind: "paste", filename: null };
/** Blocks from the last upload, or null when the text was pasted. */
let uploadedBlocks = null;
/** The Editor.js instance, created on first use. */
let editor = null;
/** True once the author has changed anything, which makes the marks stale. */
let edited = false;
let current = null;      // { result, layers, checks, text, blocks, source }
let selectedId = null;

/* --- severity ------------------------------------------------------------- */
const MAG = { error: 0, high: 0, critical: 0, warning: 2, warn: 2, medium: 2, info: 4, low: 4, notice: 4 };
const magOf = (f) => MAG[String(f.severity || "info").toLowerCase()] ?? 4;
const radiusOf = (mag) => 7 - mag;          // mag 0 -> 7px, mag 2 -> 5px, mag 4 -> 3px
const SEVERITY_WORD = { 0: "major", 2: "moderate", 4: "minor" };

/* A tap anywhere else closes an open explanation. Registered once, not per render. */
document.addEventListener("click", () => {
  for (const b of document.querySelectorAll('.info[aria-expanded="true"]')) {
    b.setAttribute("aria-expanded", "false");
  }
});

/* --- steps ---------------------------------------------------------------- */
const STEPS = ["compose", "results", "text"];
let step = "compose";

function goTo(next) {
  step = next;
  $("step-compose").hidden = next !== "compose";
  $("step-results").hidden = next !== "results";
  $("step-text").hidden = next !== "text";
  STEPS.forEach((name, i) => {
    const li = $(`step-${i + 1}`);
    li.classList.toggle("on", name === next);
    li.classList.toggle("done", STEPS.indexOf(next) > i);
  });
  $("new-scan").hidden = next === "compose";
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  if (next === "results") fireReveal();
  if (next === "text") drawChart();
}

$("new-scan").onclick = () => goTo("compose");
$("new-scan-2").onclick = () => goTo("compose");
$("back-compose").onclick = () => goTo("compose");
$("back-results").onclick = () => goTo("results");
$("to-text").onclick = () => goTo("text");

/* --- source tabs ---------------------------------------------------------- */
function showTab(which) {
  const paste = which === "paste";
  $("tab-paste").classList.toggle("active", paste);
  $("tab-upload").classList.toggle("active", !paste);
  $("tab-paste").setAttribute("aria-selected", String(paste));
  $("tab-upload").setAttribute("aria-selected", String(!paste));
  $("pane-paste").hidden = !paste;
  $("pane-upload").hidden = paste;
}
$("tab-paste").onclick = () => showTab("paste");
$("tab-upload").onclick = () => showTab("upload");

/* --- provider & key ------------------------------------------------------- */
const currentKey = () => localStorage.getItem(KEY_STORE) || "";
const currentBaseUrl = () => ($("provider").value === "custom" ? $("base-url").value.trim() : $("provider").value);
const currentModel = () => $("model").value.trim();
function providerLabel() {
  try { return new URL(currentBaseUrl()).host; } catch { return "provider"; }
}
function paintInstrument() {
  const dd = $("ro-model");
  const active = Boolean(currentKey()) || serverKey;
  if (currentKey()) { dd.className = "on"; dd.textContent = "on · " + providerLabel(); }
  else if (serverKey) { dd.className = "on"; dd.textContent = "on · server key"; }
  else { dd.className = "off"; dd.textContent = "off — 12 of 16 checks"; }
  const notice = $("ai-notice");
  if (notice) notice.hidden = active;
}

/* Both nudges open the same panel and put the cursor in the key field, so the
   suggestion and the means to act on it are never more than one click apart. */
function openKeyPanel() {
  $("key-panel").open = true;
  $("key-panel").scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => $("key").focus(), 320);
}
$("open-key").onclick = openKeyPanel;
$("open-key-2").onclick = () => { goTo("compose"); openKeyPanel(); };

$("key").oninput = () => {
  const v = $("key").value.trim();
  if (v) localStorage.setItem(KEY_STORE, v); else localStorage.removeItem(KEY_STORE);
  paintInstrument();
};
$("provider").onchange = () => {
  $("custom-row").hidden = $("provider").value !== "custom";
  localStorage.setItem(URL_STORE, $("provider").value);
  paintInstrument();
};
$("base-url").oninput = () => {
  localStorage.setItem(URL_STORE, "custom:" + $("base-url").value.trim());
  paintInstrument();
};
$("model").oninput = () => localStorage.setItem(MODEL_STORE, $("model").value.trim());
$("key-show").onclick = () => {
  const hidden = $("key").type === "password";
  $("key").type = hidden ? "text" : "password";
  $("key-show").textContent = hidden ? "Hide" : "Show";
};
$("key-clear").onclick = () => {
  localStorage.removeItem(KEY_STORE);
  $("key").value = "";
  paintInstrument();
};
$("key-test").onclick = async () => {
  $("status").textContent = "Testing the key…";
  try {
    const res = await fetch("/api/key-check", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: currentKey(), baseUrl: currentBaseUrl() }),
    }).then((r) => r.json());
    $("status").textContent = res.ok
      ? "Key works — the 4 AI checks will run."
      : "That key was rejected: " + (res.error || "no reason given") + ". The 12 other checks still run.";
  } catch (err) {
    $("status").textContent = "Could not reach the provider — " + err.message;
  }
};

/* --- upload --------------------------------------------------------------- */
async function handleFile(file) {
  $("drop-status").textContent = `Reading ${file.name}…`;
  try {
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-filename": encodeURIComponent(file.name),
      },
      body: file,
    }).then((r) => r.json());
    if (!res.ok) throw new Error(res.error);
    $("text").value = res.text;
    // Keep the rich document: the textarea can only hold the flattened text, but
    // the tables and images live in the blocks and must survive to the editor.
    uploadedBlocks = res.blocks || null;
    lastSource = { kind: res.kind, filename: res.filename, rich: Boolean(res.rich), counts: res.counts || null };
    $("drop-status").textContent =
      `Got ${res.words.toLocaleString()} words` +
      (res.pages ? ` from ${res.pages} pages` : "") +
      (res.truncated ? " — cut off at the 2 MB limit" : "") +
      ". Check it in the editor, then run the checks.";
    showTab("paste");
  } catch (err) {
    $("drop-status").textContent = "Could not read that file — " + err.message;
  }
}
$("file").onchange = () => $("file").files[0] && handleFile($("file").files[0]);
const drop = $("drop");
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("hot"); };
drop.ondragleave = () => drop.classList.remove("hot");
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove("hot");
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
};

/* --- sample --------------------------------------------------------------- */
$("sample").onclick = () => {
  $("text").value = [
    "Introduction",
    "",
    "We evaluate a kernel support machine for named entity extraction across three benchmarks [1], [2].",
    "Prior work on protein structure prediction (doi:10.1038/s41586-021-03819-2) and on attention-based",
    "sequence models (arXiv:1706.03762) informs the design. A further study (doi:10.9999/not-a-real-doi)",
    "reports similar gains. Our approach always outperforms every baseline in all configurations tested.",
    "As shown in Figure 2, the margin widens with corpus size.",
    "",
    "References",
    "",
    "[1] A. Researcher, Benchmarking entity recognition at scale, 2021.",
    "[2] B. Author, Sequence labelling with transformers, 2020.",
    "[3] C. Writer, A reference nobody cites in the text, 2019.",
  ].join("\n");
  $("brief").value = "Accuracy improved by 45% over the baseline.";
  lastSource = { kind: "paste", filename: null };
  uploadedBlocks = null;
  $("status").textContent = "Sample loaded — it trips several checks at once.";
};

/* --- run ------------------------------------------------------------------ */
$("run").onclick = async () => {
  const btn = $("run");
  if (!$("text").value.trim()) {
    $("status").textContent = "Add some text first, or press “Try a sample”.";
    return;
  }
  btn.disabled = true;
  $("status").textContent = "Checking…";
  try {
    const res = await fetch("/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: $("text").value,
        brief: $("brief").value || null,
        key: currentKey() || null,
        baseUrl: currentBaseUrl() || null,
        model: currentModel() || null,
        source: lastSource,
      }),
    }).then((r) => r.json());
    if (!res.ok) throw new Error(res.error);
    render({
      result: res.result, layers: res.layers, checks: res.checks,
      text: $("text").value,
      // Pasted text becomes paragraphs; an upload keeps its real structure.
      blocks: uploadedBlocks || window.plBlocks.textToBlocks_($("text").value),
      source: lastSource,
    }, true);
    $("status").textContent = "";
    goTo("results");
    loadHistory();
  } catch (err) {
    $("status").textContent = "The run failed — " + err.message;
  } finally {
    btn.disabled = false;
  }
};

/* --- render --------------------------------------------------------------- */
function render(data, fresh) {
  current = data;
  selectedId = null;
  if (fresh) {
    // A new run means a new document: tear the editor down so it cannot show
    // the previous paper's blocks.
    if (editor && editor.destroy) { try { editor.destroy(); } catch {} }
    editor = null;
    edited = false;
    const stale = $("stale-bar");
    if (stale) stale.hidden = true;
    $("manuscript").classList.remove("stale");
    $("view-marked").textContent = "Issues marked";
    showTextMode("marked");
  }
  const r = data.result;
  const c = r.counts || {};
  const findings = r.findings || [];
  const checks = data.checks || [];

  /* Honest banners: an unchecked paper is not a clean one. */
  const banner = $("banner");
  if (r.skipped_reason) {
    banner.hidden = false;
    banner.innerHTML = `<b>Nothing was checked.</b> ${esc(r.skipped_reason)}. We are not saying this paper is clean — we are saying we did not look.`;
  } else if (r.partial) {
    banner.hidden = false;
    banner.innerHTML = `<b>This run stopped early.</b> A budget or rate limit cut it short, so some checks did not finish. Skipped: ${esc((r.dropped || []).join("; ") || "not recorded")}.`;
  } else {
    banner.hidden = true;
  }

  $("results-title").textContent =
    data.source && data.source.filename ? data.source.filename : "What we found";

  /* --- the overview: how bad, how much ran, and all 16 at a glance ------- */
  const ran = checks.filter((x) => x.status === "ran");
  const needKey = checks.filter((x) => x.status === "inactive");
  const withIssues = checks.filter((x) => x.count > 0);
  const bySev = { 0: 0, 2: 0, 4: 0 };
  for (const f of findings) bySev[magOf(f)] += 1;

  $("ov-count").textContent = findings.length;
  $("ov-count").classList.toggle("is-clean", findings.length === 0);
  $("ov-label").textContent = findings.length === 1 ? "issue found" : "issues found";

  // Severity bar. Zero-width segments are omitted so the bar never lies.
  const sevSegs = [[0, "seg-major", "major"], [2, "seg-mod", "moderate"], [4, "seg-minor", "minor"]]
    .filter(([m]) => bySev[m] > 0);
  $("sev-bar").innerHTML = findings.length
    ? sevSegs.map(([m, cls, word]) =>
        `<span class="${cls}" style="width:${(bySev[m] / findings.length) * 100}%" title="${bySev[m]} ${word}"></span>`).join("")
    : `<span class="seg-ran" style="width:100%" title="no issues"></span>`;

  // How much of the tool actually ran.
  $("run-bar").innerHTML =
    `<span class="seg-ran" style="width:${(ran.length / checks.length) * 100}%" title="${ran.length} ran"></span>` +
    `<span class="seg-idle" style="width:${(needKey.length / checks.length) * 100}%" title="${needKey.length} not run"></span>`;

  $("ov-legend").innerHTML = findings.length
    ? `<b>${bySev[0]}</b> major · <b>${bySev[2]}</b> moderate · <b>${bySev[4]}</b> minor — ` +
      `found by <b>${withIssues.length}</b> of the <b>${ran.length}</b> checks that ran` +
      (needKey.length ? `. <b>${needKey.length}</b> did not run (no API key).` : ".")
    : `<b>${ran.length}</b> checks ran and every one came back clean` +
      (needKey.length ? `. <b>${needKey.length}</b> did not run (no API key).` : ".");

  // One square per check: the state of the whole tool in a single glance.
  $("ov-grid").innerHTML = checks.map((c) => {
    const st = c.count > 0 ? "st-bad" : c.status === "ran" ? "st-ok" : "st-idle";
    const word = c.count > 0 ? `${plural(c.count, "issue", "issues")}` : c.status === "ran" ? "clean" : "not run";
    return `<span class="ov-cell ${st}" title="${esc(c.label)} — ${esc(word)}"></span>`;
  }).join("");

  const words = (c.words ?? 0).toLocaleString();
  const ids = c.identifiers ?? 0;
  const facts = `${words} words · ${(r.detected_language || "?").toUpperCase()}` +
    (ids ? ` · ${plural(ids, "DOI or arXiv ID", "DOIs and arXiv IDs")} looked up` : "") +
    (c.ai_calls ? ` · ${plural(c.ai_calls, "AI call", "AI calls")}` : "");
  $("results-title").textContent =
    data.source && data.source.filename ? data.source.filename : "What we found";
  $("head-facts").textContent = facts;

  $("ramp-text").innerHTML = `<span>Dot size = severity</span>` +
    [0, 2, 4].map((m) => {
      const d = radiusOf(m) * 2;
      return `<span class="item"><span class="dot sev-${m}" style="width:${d}px;height:${d}px"></span>${SEVERITY_WORD[m]}</span>`;
    }).join("");

  const det = checks.filter((x) => !x.ai);
  const ai = checks.filter((x) => x.ai);
  $("ai-gap").hidden = !ai.every((x) => x.status === "inactive");
  $("checks-body").innerHTML = renderGroups(checks, findings);

  for (const badge of document.querySelectorAll(".info")) {
    badge.onclick = (e) => {
      e.stopPropagation();
      const open = badge.getAttribute("aria-expanded") === "true";
      for (const other of document.querySelectorAll(".info")) other.setAttribute("aria-expanded", "false");
      badge.setAttribute("aria-expanded", String(!open));
      if (!open) placeTip(badge);
    };
    badge.onmouseenter = () => placeTip(badge);
    badge.onfocus = () => placeTip(badge);
  }
  for (const toggle of document.querySelectorAll(".check-toggle")) {
    toggle.onclick = () => {
      const open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      toggle.closest(".check").querySelector(".issues").hidden = open;
    };
  }

  $("object-card").hidden = true;
  document.querySelector(".plate-body").classList.add("solo");
  paintManuscript();
  if (fresh) pendingReveal = true;
}

/* The staggered reveal is armed by render() but only ever fired once the step
   is actually on screen: a CSS animation does not start inside a display:none
   subtree, and with fill-mode `both` that used to pin every row at its
   from-state — an invisible list of checks. It is also always disarmed on a
   timer, so a dropped animationend can never leave content hidden. */
let pendingReveal = false;
let revealTimer = null;
function fireReveal() {
  if (!pendingReveal) return;
  pendingReveal = false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const lists = [$("checks-body")];
  for (const list of lists) {
    list.classList.remove("resolving");
    void list.offsetWidth;
    list.classList.add("resolving");
  }
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    for (const list of lists) list.classList.remove("resolving");
  }, 1200);
}

/* One check per row. The <li> is the grid; the disclosure control is a
   transparent button stretched across it (big target, valid markup) and the
   info button is a SIBLING — nesting a button inside a button is invalid and
   the parser hoists it out, which collapses the grid. */
function checkRow(check, findings, index) {
  const mine = findings.filter((f) => f.check === check.id);
  const state = stateWords(check);
  const expandable = mine.length > 0;
  const id = `issues-${check.id}`;
  return (
    `<li class="check${check.count > 0 ? " has-issues" : ""}" style="--i:${index}">` +
    `<div class="check-row">` +
    (expandable
      ? `<button class="check-toggle" type="button" aria-expanded="false" aria-controls="${id}"` +
        ` aria-label="Show the ${plural(mine.length, "issue", "issues")} from ${esc(check.label)}"></button>`
      : "") +
    `<span class="check-body">` +
      `<span class="check-name">${esc(check.label)}</span>` +
      (check.ai ? `<span class="ai-tag">AI</span>` : "") +
      (check.example
        ? `<button class="info" type="button" aria-expanded="false"` +
          ` aria-label="An example of what ${esc(check.label)} catches">i` +
          `<span class="tip" role="tooltip">${esc(check.example)}</span></button>`
        : "") +
      `<span class="check-about">${esc(check.about)}</span>` +
    `</span>` +
    `<span class="pill ${pillClass(check)}">${esc(state)}</span>` +
    `<span class="check-count">${check.gate ? "\u2014" : check.count}</span>` +
    (expandable
      ? `<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`
      : `<span class="chev-gap"></span>`) +
    `</div>` +
    `<ul class="issues" id="${id}" hidden>${mine.map((f) => issueRow(f)).join("")}</ul>` +
    `</li>`
  );
}

/* Checks grouped by what they examine. Each group is its own card with a
   colour that states what happened inside it — and the same thing in words,
   because colour alone is never allowed to carry a state. */
function renderGroups(checks, findings) {
  const order = [];
  const byGroup = new Map();
  checks.forEach((c) => {
    const g = c.group || "Other";
    if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
    byGroup.get(g).push(c);
  });
  let n = 0;
  return order.map((g) => {
    const rows = byGroup.get(g);
    const issues = rows.reduce((sum, x) => sum + x.count, 0);
    const notRun = rows.every((x) => x.status === "inactive");
    const cls = issues ? "has-issues" : notRun ? "not-run" : "all-clean";
    const pill = issues
      ? `<span class="pill p-bad">${plural(issues, "issue", "issues")}</span>`
      : notRun
        ? `<span class="pill p-idle">Not run</span>`
        : `<span class="pill p-ok">All clear</span>`;
    return `<section class="group-card ${cls}">` +
      `<div class="group-card-head">` +
        `<h3>${esc(g)}</h3>` +
        `<div class="g-meta"><span class="g-count">${plural(rows.length, "check", "checks")}</span>${pill}</div>` +
      `</div>` +
      `<ol class="checks">${rows.map((x) => checkRow(x, findings, n++)).join("")}</ol>` +
      `</section>`;
  }).join("");
}

/* Keep an example tooltip inside the window. A CSS anchor cannot know where the
   badge sits, so left-anchoring clipped badges near the right edge and
   right-anchoring clipped badges near the left. Measure and clamp instead. */
function placeTip(badge) {
  const tip = badge.querySelector(".tip");
  if (!tip) return;
  tip.style.left = "0px";
  const badgeLeft = badge.getBoundingClientRect().left;
  const width = tip.getBoundingClientRect().width;
  const margin = 10;
  const min = margin - badgeLeft;                              // flush to the left edge
  const max = window.innerWidth - margin - width - badgeLeft;  // flush to the right edge
  tip.style.left = `${Math.round(max < min ? min : Math.min(Math.max(0, min), max))}px`;
}

/* Colour follows the word, never replaces it. */
function pillClass(check) {
  if (check.count > 0) return "p-bad";
  if (check.status === "ran") return "p-ok";
  if (check.status === "abstained") return "p-warn";
  return "p-idle";
}

/* Plain words for every state — never a colour or an icon alone. */
function stateWords(check) {
  if (check.gate) return check.status === "skipped" ? "Stopped the run" : "Passed";
  if (check.status === "inactive") return "Needs a key";
  if (check.status === "skipped") return "Not run";
  if (check.status === "abstained") return "Nothing to check";
  return check.count === 0 ? "Clean" : plural(check.count, "issue", "issues");
}

function stateMark(check) {
  const s = 'fill="none" stroke="currentColor" stroke-width="1.1"';
  if (check.count > 0)
    return `<svg class="check-mark" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--amber)">
      <circle cx="12" cy="12" r="9" ${s}/><circle cx="12" cy="12" r="3.6" fill="currentColor"/></svg>`;
  if (check.status === "ran")
    return `<svg class="check-mark" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--chalk-faint)">
      <circle cx="12" cy="12" r="9" ${s}/></svg>`;
  if (check.status === "abstained")
    return `<svg class="check-mark" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--chalk-faint)">
      <circle cx="12" cy="12" r="9" ${s} stroke-dasharray="2.5 3"/></svg>`;
  if (check.status === "skipped")
    return `<svg class="check-mark" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--chalk-faint)">
      <circle cx="12" cy="12" r="9" ${s}/><path d="M6 18 18 6" ${s}/></svg>`;
  return `<svg class="check-mark" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--chalk-faint)">
    <circle cx="12" cy="12" r="9" ${s} stroke-dasharray="1 4"/></svg>`;
}

function issueRow(f) {
  const mag = magOf(f);
  const d = radiusOf(mag) * 2;
  const addr = addressOf(f);
  const doi = String(f.source_ref || "").match(/^doi:(.+)$/);
  const link = doi ? `<a href="https://doi.org/${esc(doi[1])}" target="_blank" rel="noopener">Open the DOI</a>` : "";
  // Every quote is labelled with whose words it is. A suggestion is labelled a
  // suggestion — the tool never rewrites the author's text.
  const wrote = f.quoted_span
    ? `<p class="quote-row"><span class="lead">Your text:</span> <span class="q">${esc(f.quoted_span)}</span></p>` : "";
  const sugg = f.suggestion
    ? `<p class="quote-row"><span class="lead">Suggested instead:</span> <span class="sugg">${esc(f.suggestion)}</span> <span>(a suggestion — nothing has been changed)</span></p>` : "";
  const src = f.evidence && f.evidence.source_quote
    ? `<p class="quote-row"><span class="lead">The cited source says:</span> <span class="q">${esc(f.evidence.source_quote)}</span></p>` : "";
  const why = f.evidence && f.evidence.reason
    ? `<p class="quote-row"><span class="lead">Why:</span> ${esc(f.evidence.reason)}</p>` : "";
  return (
    `<li class="issue" data-addr="${esc(addr)}">` +
    `<span class="issue-dot"><span class="dot sev-${mag}" style="width:${d}px;height:${d}px"></span></span>` +
    `<div>` +
    `<div class="issue-meta"><span class="addr">${esc(addr)}</span>` +
    `<span>${esc(SEVERITY_WORD[mag])}</span>` +
    `<span>${f.decided_by === "deterministic" ? "found by code" : "judged by the model"}</span>${link}</div>` +
    `<p class="issue-msg">${esc(f.message_en)}</p>` + wrote + sugg + src + why +
    `</div></li>`
  );
}

/* A short, quotable address per issue: check number, then its ordinal. */
function addressOf(f) {
  if (!current) return "—";
  const checks = current.checks || [];
  const idx = checks.findIndex((c) => c.id === f.check);
  const mine = (current.result.findings || []).filter((x) => x.check === f.check);
  return `${String(idx + 1).padStart(2, "0")}.${mine.indexOf(f) + 1}`;
}

/* --- the manuscript, marked in place -------------------------------------- */
function paintManuscript() {
  if (!current) return;
  const text = current.text || "";
  const marks = (current.result.findings || [])
    .filter((f) => Number.isInteger(f.span_start) && Number.isInteger(f.span_end) && f.span_end > f.span_start)
    .sort((a, b) => b.span_start - a.span_start);

  const pieces = [];
  let cursor = text.length;
  for (const f of marks) {
    if (f.span_end > cursor) continue; // overlapping spans: first one wins
    pieces.push(esc(text.slice(f.span_end, cursor)));
    const addr = addressOf(f);
    pieces.push(
      `<mark data-addr="${esc(addr)}" tabindex="0" role="button"` +
      ` aria-label="Flagged: ${esc(text.slice(f.span_start, f.span_end))}. Issue ${esc(addr)}.">` +
      esc(text.slice(f.span_start, f.span_end)) +
      `<span class="pin" aria-hidden="true">${esc(addr)}</span></mark>`,
    );
    cursor = f.span_start;
  }
  pieces.push(esc(text.slice(0, cursor)));
  $("manuscript").innerHTML = pieces.reverse().join("") || '<span class="empty">Nothing to show.</span>';

  for (const m of $("manuscript").querySelectorAll("mark")) {
    const pick = () => selectObject(m.dataset.addr, false);
    m.onclick = pick;
    m.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
  }
}

const findByAddress = (addr) => (current?.result.findings || []).find((f) => addressOf(f) === addr) || null;

function selectObject(addr, scroll) {
  selectedId = addr;
  for (const m of $("manuscript").querySelectorAll("mark")) m.classList.toggle("sel", m.dataset.addr === addr);
  const f = findByAddress(addr);
  const card = $("object-card");
  if (!f) { card.hidden = true; card.parentElement.classList.add("solo"); return; }
  card.parentElement.classList.remove("solo");
  const check = (current.checks || []).find((c) => c.id === f.check);
  card.hidden = false;
  card.innerHTML =
    `<div class="obj-addr"><span>${esc(addr)}</span><span class="sep">${esc(check ? check.label : "")}</span></div>` +
    `<p class="obj-msg">${esc(f.message_en)}</p>` +
    (f.quoted_span ? `<p class="obj-quote">&ldquo;${esc(f.quoted_span)}&rdquo;</p>` : "");
  if (scroll) {
    const m = $("manuscript").querySelector(`mark[data-addr="${CSS.escape(addr)}"]`);
    if (m) m.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  drawChart();
}

/* --- the chart ------------------------------------------------------------ */
let chartPoints = [];

function drawChart() {
  const canvas = $("chart");
  if (!canvas || !current || $("step-text").hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const css = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const ink = pick("--ink", "#16191D");
  const faint = pick("--ink-3", "#626B76");
  const rule = pick("--rule", "#E1E5EA");
  const sel = pick("--sev-major", "#B02A18");
  const SEV = { 0: pick("--sev-major", "#B02A18"), 2: pick("--sev-mod", "#8A5A0F"), 4: pick("--sev-minor", "#626B76") };

  // Reserve the label gutter from the widest label actually drawn, so an axis
  // name is ellipsised deliberately rather than clipped by the canvas edge.
  ctx.font = '600 10px "Public Sans", sans-serif';
  const rowsForWidth = (current.checks || []).filter((c) => c.count > 0);
  const widest = rowsForWidth.reduce((m, c) => Math.max(m, ctx.measureText(c.label.toUpperCase()).width), 0);
  const padL = Math.min(w * 0.42, Math.max(74, widest + 18));
  const padR = 18, padT = 16, padB = 26;
  const plotW = Math.max(10, w - padL - padR);
  const plotH = Math.max(10, h - padT - padB);
  const rows = (current.checks || []).filter((c) => c.count > 0);
  const rowCount = rows.length || 1;
  const rowH = plotH / rowCount;

  ctx.lineWidth = 1;
  ctx.font = '600 10px "Public Sans", sans-serif';
  ctx.textBaseline = "middle";
  for (let i = 0; i < rowCount; i += 1) {
    const y = padT + rowH * (i + 0.5);
    ctx.strokeStyle = rule;
    ctx.beginPath(); ctx.moveTo(padL, Math.round(y) + 0.5); ctx.lineTo(w - padR, Math.round(y) + 0.5); ctx.stroke();
    ctx.fillStyle = faint;
    ctx.textAlign = "right";
    const name = rows[i] ? rows[i].label.toUpperCase() : "";
    ctx.fillText(name.length > 22 ? name.slice(0, 21) + "…" : name, padL - 10, y);
  }
  ctx.textAlign = "center";
  for (let p = 0; p <= 10; p += 1) {
    const x = padL + (plotW * p) / 10;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, padT);
    ctx.lineTo(Math.round(x) + 0.5, padT + plotH);
    ctx.strokeStyle = p % 5 === 0 ? "#D2D8DF" : "#EDF0F3";
    ctx.stroke();
  }
  ctx.fillStyle = faint;
  ctx.font = '400 11px "Public Sans", sans-serif';
  ctx.fillText("start of paper", padL + plotW * 0.09, h - padB / 2);
  ctx.fillText("end", padL + plotW * 0.97, h - padB / 2);

  const textLen = Math.max(1, (current.text || "").length);
  chartPoints = [];
  const findings = (current.result.findings || []).slice().sort((a, b) => magOf(b) - magOf(a));
  for (const f of findings) {
    const li = rows.findIndex((c) => c.id === f.check);
    if (li < 0) continue;
    const pos = Number.isInteger(f.span_start) ? Math.min(1, f.span_start / textLen) : 0.5;
    const x = padL + plotW * pos;
    const y = padT + rowH * (li + 0.5);
    const mag = magOf(f);
    const r = radiusOf(mag);
    const addr = addressOf(f);
    const isSel = addr === selectedId;

    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = isSel ? sel : (SEV[mag] || ink);
    ctx.fill();
    if (isSel) {
      ctx.strokeStyle = sel; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, r + 6, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - r - 11, y); ctx.lineTo(x - r - 3, y);
      ctx.moveTo(x + r + 3, y); ctx.lineTo(x + r + 11, y);
      ctx.moveTo(x, y - r - 11); ctx.lineTo(x, y - r - 3);
      ctx.moveTo(x, y + r + 3); ctx.lineTo(x, y + r + 11);
      ctx.stroke();
    }
    chartPoints.push({ x, y, r: Math.max(r, 7), addr });
  }

  if (!findings.length) {
    ctx.fillStyle = faint;
    ctx.font = '500 13px "Public Sans", sans-serif';
    ctx.fillText("No issues to plot", padL + plotW / 2, padT + plotH / 2);
  }
}

$("chart").addEventListener("click", (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  let best = null, bestD = Infinity;
  for (const p of chartPoints) {
    const d = Math.hypot(p.x - mx, p.y - my);
    if (d < p.r + 5 && d < bestD) { best = p; bestD = d; }
  }
  if (best) selectObject(best.addr, true);
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawChart, 120);
});

/* =============================================================================
   THE EDITOR

   Step 3 has two modes over one document. "Issues marked" is the read-only view
   whose whole value is that it shows the text exactly as submitted, with the
   findings anchored to real offsets. "Edit" is the same document, editable.

   Editing invalidates the findings, and that is not a detail to paper over: a
   finding carries character offsets into the submitted text, so the moment a
   word is inserted every later offset is wrong. Rather than silently drifting
   the highlights onto the wrong words, the marks are declared STALE and a
   re-check is offered. An honest "these no longer apply" beats a highlight
   pointing confidently at the wrong sentence.
   ========================================================================== */

function showTextMode(which) {
  const marked = which === "marked";
  $("view-marked").classList.toggle("active", marked);
  $("view-edit").classList.toggle("active", !marked);
  $("view-marked").setAttribute("aria-selected", String(marked));
  $("view-edit").setAttribute("aria-selected", String(!marked));
  $("pane-marked").hidden = !marked;
  $("pane-edit").hidden = marked;
  if (marked) drawChart(); else mountEditor();
}
$("view-marked").onclick = () => showTextMode("marked");
$("view-edit").onclick = () => showTextMode("edit");

/** Create the editor once, seeded from the document the run was made against. */
async function mountEditor() {
  if (!current) return;
  if (editor) return;
  const data = window.plBlocks.toEditorData(current.blocks || []);
  editor = new window.EditorJS({
    holder: "editor",
    data,
    minHeight: 120,
    placeholder: "Your paper…",
    tools: {
      header: { class: window.Header, inlineToolbar: true, config: { levels: [1, 2, 3], defaultLevel: 2 } },
      list: { class: window.EditorjsList, inlineToolbar: true },
      quote: { class: window.Quote, inlineToolbar: true },
      code: { class: window.CodeTool },
      table: { class: window.Table, inlineToolbar: true },
      delimiter: { class: window.Delimiter },
      image: { class: window.SimpleImage },
      Marker: { class: window.Marker },
      inlineCode: { class: window.InlineCode },
      underline: { class: window.Underline },
    },
    onChange: markStale,
  });

  // Editor.js's own onChange is the intended hook, but it is the editor's
  // internal notion of a change and it does not fire for every mutation of the
  // contenteditable underneath it. Marking findings stale is a correctness
  // guarantee, not a nicety — a missed signal leaves highlights pointing
  // confidently at the wrong words — so it is backed by the DOM events too.
  const holder = $("editor");
  holder.addEventListener("input", markStale);
  holder.addEventListener("paste", markStale);
  holder.addEventListener("cut", markStale);
}

/** Declare the findings stale. Idempotent: the first edit is the only one that
 *  matters, and every later keystroke must stay cheap. */
function markStale() {
  if (edited) return;
  edited = true;
  $("stale-bar").hidden = false;
  // Grey the marks in the other view too, so switching back cannot present
  // stale highlights as if they were current.
  $("manuscript").classList.add("stale");
  $("view-marked").textContent = "Issues marked (stale)";
}

/** The document as it now stands in the editor, or the original if untouched. */
async function currentBlocks() {
  if (!editor) return current ? current.blocks || [] : [];
  const data = await editor.save();
  return window.plBlocks.fromEditorData(data);
}

/* Re-check: run the 16 checks against the EDITED text and repoint everything. */
$("recheck").onclick = async () => {
  const btn = $("recheck");
  btn.disabled = true;
  btn.textContent = "Checking…";
  try {
    const blocks = await currentBlocks();
    const { text } = window.plBlocks.serializeBlocks(blocks);
    const res = await fetch("/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text, brief: $("brief").value || null,
        key: currentKey() || null, baseUrl: currentBaseUrl() || null,
        model: currentModel() || null, source: lastSource,
      }),
    }).then((r) => r.json());
    if (!res.ok) throw new Error(res.error);
    $("text").value = text;
    edited = false;
    $("stale-bar").hidden = true;
    $("manuscript").classList.remove("stale");
    $("view-marked").textContent = "Issues marked";
    render({ result: res.result, layers: res.layers, checks: res.checks, text, blocks, source: lastSource }, false);
    loadHistory();
    goTo("results");
  } catch (err) {
    $("stale-bar").querySelector(".fine").textContent = "Re-check failed — " + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Re-check the 16 checks";
  }
};

/* --- download ------------------------------------------------------------- */
/* The export runs server-side because that is where the document writers live;
   the browser only names the file and saves it. */
async function download(format) {
  const btn = format === "pdf" ? $("dl-pdf") : $("dl-docx");
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Preparing…";
  try {
    const blocks = await currentBlocks();
    const res = await fetch("/api/export", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ format, blocks, title: docTitle() }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `export failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${docTitle()}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick: revoking synchronously can cancel the download
    // in some browsers before it has read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    btn.textContent = "Downloaded";
    setTimeout(() => { btn.textContent = was; }, 1600);
  } catch (err) {
    btn.textContent = "Failed";
    $("stale-bar").hidden = false;
    $("stale-bar").querySelector(".fine").textContent = "Download failed — " + err.message;
    setTimeout(() => { btn.textContent = was; }, 2200);
  } finally {
    btn.disabled = false;
  }
}

/** A filename from the source document, falling back to something honest. */
function docTitle() {
  const name = lastSource && lastSource.filename;
  if (name) return String(name).replace(/\.(pdf|docx?)$/i, "");
  return "paperlint-document";
}

$("dl-docx").onclick = () => download("docx");
$("dl-pdf").onclick = () => download("pdf");

/* --- previous runs -------------------------------------------------------- */
async function loadHistory() {
  const { runs } = await fetch("/api/history").then((r) => r.json());
  if (!runs.length) {
    $("history-list").innerHTML = '<div class="empty">No runs yet. Check a paper and it will appear here.</div>';
    $("clear-history").hidden = true;
    return;
  }
  $("clear-history").hidden = false;
  $("history-list").innerHTML = runs
    .map((run) => {
      const name = run.source && run.source.filename ? run.source.filename : run.title;
      return `<div class="run-row" data-id="${esc(run.id)}">` +
        `<span class="run-title">${esc(name)}</span>` +
        `<span class="run-meta">${esc(run.ts.slice(0, 16).replace("T", " "))}</span>` +
        `<span class="run-count">${plural(run.findings, "issue", "issues")}</span>` +
        `<button class="run-del" data-del="${esc(run.id)}" aria-label="Delete this run">&times;</button>` +
        `</div>`;
    })
    .join("");

  for (const row of document.querySelectorAll(".run-row")) {
    row.onclick = async (e) => {
      if (e.target.dataset.del) return;
      const rec = await fetch("/api/history/" + row.dataset.id).then((r) => r.json());
      $("text").value = rec.input.text;
      $("brief").value = rec.input.brief || "";
      lastSource = rec.input.source;
      render({
        result: rec.result, layers: rec.layers,
        checks: rec.checks || [], text: rec.input.text, source: rec.input.source,
      }, false);
      goTo("results");
    };
  }
  for (const del of document.querySelectorAll("[data-del]")) {
    del.onclick = async (e) => {
      e.stopPropagation();
      await fetch("/api/history/" + del.dataset.del, { method: "DELETE" });
      loadHistory();
    };
  }
}
$("clear-history").onclick = async () => {
  if (!confirm("Delete every saved run from this machine?")) return;
  await fetch("/api/history", { method: "DELETE" });
  loadHistory();
};

/* --- boot ----------------------------------------------------------------- */
(async function boot() {
  try {
    const status = await fetch("/api/status").then((r) => r.json());
    serverKey = Boolean(status.server_key);
    // Name the vocabulary, not just the count: "33 terms" on its own reads as a
    // weak tool rather than an uninstalled glossary.
    const terms = status.glossary_terms || 0;
    const named = status.glossary_source;
    const dd = $("ro-glossary");
    if (!terms) {
      dd.textContent = "none loaded";
    } else if (status.glossary_kind === "example") {
      dd.innerHTML = `${terms} terms <span class="ro-note">example set</span>`;
    } else {
      dd.innerHTML = `${terms.toLocaleString()} terms` + (named ? ` <span class="ro-note">${esc(named)}</span>` : "");
    }
    // The footer may only credit a glossary the run actually used.
    const credit = $("foot-credit");
    if (credit) {
      credit.textContent = named
        ? `Terminology is checked against the ${named}.`
        : status.glossary_kind === "example"
          ? "Terminology is checked against the bundled example vocabulary — drop a curated glossary at data/glossary.json to use a real one."
          : "";
    }
    $("foot-version").textContent = status.version ? `v${status.version}` : "";
  } catch {
    $("ro-glossary").textContent = "unreachable";
  }
  $("key").value = currentKey();
  const savedUrl = localStorage.getItem(URL_STORE) || "";
  if (savedUrl.startsWith("custom:")) {
    $("provider").value = "custom";
    $("custom-row").hidden = false;
    $("base-url").value = savedUrl.slice(7);
  } else if (savedUrl) {
    $("provider").value = savedUrl;
  }
  $("model").value = localStorage.getItem(MODEL_STORE) || "";
  paintInstrument();
  goTo("compose");
  loadHistory();
})();
