/* paperlint frontend. Vanilla JS, no build step. */
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const KEY_STORE = "paperlint.api_key";
const URL_STORE = "paperlint.base_url";
const MODEL_STORE = "paperlint.model";
let serverKey = false;
let lastSource = { kind: "paste", filename: null };

/* ------------------------------------------------------------------ tabs */
function showTab(which) {
  $("tab-paste").classList.toggle("active", which === "paste");
  $("tab-upload").classList.toggle("active", which === "upload");
  $("pane-paste").hidden = which !== "paste";
  $("pane-upload").hidden = which !== "upload";
}
$("tab-paste").onclick = () => showTab("paste");
$("tab-upload").onclick = () => showTab("upload");

/* ------------------------------------------------------------------- key */
function currentKey() {
  return localStorage.getItem(KEY_STORE) || "";
}
/** The chosen endpoint: the dropdown, or the custom field when "Custom…". */
function currentBaseUrl() {
  const sel = $("provider").value;
  return sel === "custom" ? $("base-url").value.trim() : sel;
}
function currentModel() {
  return $("model").value.trim();
}
function providerLabel() {
  const url = currentBaseUrl();
  try {
    return new URL(url).host;
  } catch {
    return "provider";
  }
}
function paintModelState() {
  const pill = $("model-state");
  if (currentKey()) {
    pill.className = "pill on";
    pill.textContent = `AI checks: on · ${providerLabel()}`;
  } else if (serverKey) {
    pill.className = "pill on";
    pill.textContent = "AI checks: on (server key)";
  } else {
    pill.className = "pill off";
    pill.textContent = "AI checks: off — 12 deterministic checks still run";
  }
}
$("key").oninput = () => {
  const v = $("key").value.trim();
  if (v) localStorage.setItem(KEY_STORE, v);
  else localStorage.removeItem(KEY_STORE);
  paintModelState();
};
$("provider").onchange = () => {
  $("custom-row").hidden = $("provider").value !== "custom";
  localStorage.setItem(URL_STORE, $("provider").value);
  paintModelState();
};
$("base-url").oninput = () => { localStorage.setItem(URL_STORE, "custom:" + $("base-url").value.trim()); paintModelState(); };
$("model").oninput = () => localStorage.setItem(MODEL_STORE, $("model").value.trim());
$("key-show").onclick = () => {
  $("key").type = $("key").type === "password" ? "text" : "password";
};
$("key-clear").onclick = () => {
  localStorage.removeItem(KEY_STORE);
  $("key").value = "";
  paintModelState();
};
$("key-test").onclick = async () => {
  $("status").textContent = "Testing key…";
  const res = await fetch("/api/key-check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: currentKey(), baseUrl: currentBaseUrl() }),
  }).then((r) => r.json());
  $("status").textContent = res.ok ? "Key OK." : "Key failed: " + (res.error || "unknown");
};

/* ---------------------------------------------------------------- upload */
async function handleFile(file) {
  $("drop-status").textContent = `Extracting ${file.name}…`;
  try {
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream", "x-filename": encodeURIComponent(file.name) },
      body: file,
    }).then((r) => r.json());
    if (!res.ok) throw new Error(res.error);
    $("text").value = res.text;
    lastSource = { kind: res.kind, filename: res.filename };
    $("drop-status").textContent =
      `Extracted ${res.words.toLocaleString()} words` +
      (res.pages ? ` from ${res.pages} pages` : "") +
      (res.truncated ? " (TRUNCATED at the 2 MB text ceiling)" : "") +
      " — placed in the editor.";
    showTab("paste");
  } catch (err) {
    $("drop-status").textContent = "Extraction failed: " + err.message;
  }
}
$("file").onchange = () => $("file").files[0] && handleFile($("file").files[0]);
const drop = $("drop");
drop.ondragover = (e) => {
  e.preventDefault();
  drop.classList.add("hot");
};
drop.ondragleave = () => drop.classList.remove("hot");
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove("hot");
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
};

/* ---------------------------------------------------------------- sample */
$("sample").onclick = () => {
  $("text").value = [
    "Introduction",
    "",
    "We evaluate a kernel support machine for named entity extraction across three benchmarks [1], [2].",
    "Prior work on protein structure prediction (doi:10.1038/s41586-021-03819-2) and on attention-based",
    "sequence models (arXiv:1706.03762) informs the design. A further study (doi:10.9999/not-a-real-doi)",
    "reports similar gains. Our approach always outperforms every baseline in all configurations tested.",
    "",
    "References",
    "",
    "[1] A. Researcher, Benchmarking entity recognition at scale, 2021.",
    "[2] B. Author, Sequence labelling with transformers, 2020.",
    "[3] C. Writer, A reference nobody cites in the text, 2019.",
  ].join("\n");
  $("brief").value = "Accuracy improved by 45% over the baseline.";
  lastSource = { kind: "paste", filename: null };
};

/* ------------------------------------------------------------------- run */
$("run").onclick = async () => {
  const btn = $("run");
  btn.disabled = true;
  $("status").textContent = "Running…";
  try {
    const res = await fetch("/api/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
    render(res);
    $("status").textContent = `Done in ${res.ms} ms` + (res.model ? ` · ${res.model}` : "");
    loadHistory();
  } catch (err) {
    $("stats").innerHTML = '<div class="empty">' + esc(err.message) + "</div>";
    $("layers").innerHTML = "";
    $("status").textContent = "";
  } finally {
    btn.disabled = false;
  }
};

/* ---------------------------------------------------------------- render */
function render(data) {
  const r = data.result;
  const c = r.counts || {};

  const banner = $("banner");
  if (r.skipped_reason) {
    banner.hidden = false;
    banner.textContent =
      "Skipped — " + r.skipped_reason + ". Nothing was checked and nothing is claimed: an unchecked document is not a clean one.";
  } else if (r.partial) {
    banner.hidden = false;
    banner.textContent =
      "PARTIAL RUN — a budget or rate ceiling stopped work. Dropped: " + (r.dropped || []).join("; ");
  } else {
    banner.hidden = true;
  }

  $("stats").innerHTML = [
    ["Language", (r.detected_language || "—").toUpperCase()],
    ["Words", c.words ?? 0],
    ["Findings", (r.findings || []).length],
    ["Identifiers", c.identifiers ?? 0],
    ["Unverified", c.citation_unverified ?? 0],
    ["Model calls", c.ai_calls ?? 0],
    ["Tokens in/out", `${c.ai_input_tokens ?? 0}/${c.ai_output_tokens ?? 0}`],
  ]
    .map(([k, v]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`)
    .join("");

  $("layers").innerHTML = (data.layers || [])
    .map((layer) => {
      const findings = (r.findings || []).filter((f) => findingLayer(f) === layer.id);
      const state =
        layer.status === "ran"
          ? layer.count === 0
            ? "ran — nothing found"
            : ""
          : layer.status + (layer.reason ? " — " + layer.reason : "");
      const extra = layer.extra
        ? " · " +
          Object.entries(layer.extra)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" · ")
        : "";
      return (
        `<div class="layer"><div class="head">` +
        `<span class="name">${esc(layer.label)}</span>` +
        `<span class="state ${esc(layer.status)}">${esc(state)}${esc(extra)}</span>` +
        `<span class="badge ${layer.count > 0 ? "hit" : ""}">${layer.count}</span>` +
        `</div>` +
        (findings.length
          ? `<div class="body">` + findings.map(findingCard).join("") + `</div>`
          : "") +
        `</div>`
      );
    })
    .join("");
}

function findingLayer(f) {
  if (f.category === "glossary") return "glossary";
  if (f.category === "reference") return "references";
  if (f.category === "consistency") return "consistency";
  if (f.category === "citation")
    return /\bwas (RETRACTED|WITHDRAWN|REMOVED|PARTIAL RETRACTION)\b/.test(f.message_en) ? "retraction" : "citations";
  const ref = String(f.source_ref || "");
  if (ref === "contradiction") return "d2_contradiction";
  if (ref === "overclaim") return "d4_overclaim";
  if (ref.startsWith("methodology:")) return "d3_methodology";
  return "d1_claim_source";
}

function findingCard(f) {
  const doi = String(f.source_ref || "").match(/^doi:(.+)$/);
  const link = doi ? ` · <a href="https://doi.org/${esc(doi[1])}" target="_blank" rel="noopener">${esc(doi[1])}</a>` : "";
  const ev =
    f.evidence && f.evidence.source_quote
      ? `<div class="ev">Source: &ldquo;${esc(f.evidence.source_quote)}&rdquo;</div>`
      : "";
  return (
    `<div class="f ${esc(f.severity)}">` +
    `<div class="tag">${esc(f.severity)}${f.decided_by ? " · " + esc(f.decided_by) : ""}${link}</div>` +
    (f.quoted_span ? `<p>The text says <span class="quote">${esc(f.quoted_span)}</span></p>` : "") +
    `<p>${esc(f.message_en)}</p>` +
    ev +
    `</div>`
  );
}

/* --------------------------------------------------------------- history */
async function loadHistory() {
  const { runs } = await fetch("/api/history").then((r) => r.json());
  if (!runs.length) {
    $("history-list").innerHTML = '<div class="empty small">No runs yet.</div>';
    return;
  }
  $("history-list").innerHTML = runs
    .map(
      (run) =>
        `<div class="hrun" data-id="${esc(run.id)}">` +
        `<div class="t">${esc(run.title)}</div>` +
        `<div class="m"><span>${esc(run.ts.slice(0, 16).replace("T", " "))}</span>` +
        `<span>${run.findings} finding${run.findings === 1 ? "" : "s"}${run.partial ? " · partial" : ""}</span>` +
        `<button class="del" data-del="${esc(run.id)}" title="delete">&times;</button></div>` +
        `</div>`,
    )
    .join("");
  for (const el of document.querySelectorAll(".hrun")) {
    el.onclick = async (e) => {
      if (e.target.dataset.del) return;
      const rec = await fetch("/api/history/" + el.dataset.id).then((r) => r.json());
      $("text").value = rec.input.text;
      $("brief").value = rec.input.brief || "";
      lastSource = rec.input.source;
      render({ result: rec.result, layers: rec.layers });
      $("status").textContent = `Viewing past run ${rec.id} (${rec.ms} ms)`;
      showTab("paste");
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
  if (!confirm("Delete all run history from disk?")) return;
  await fetch("/api/history", { method: "DELETE" });
  loadHistory();
};

/* ------------------------------------------------------------------ boot */
(async function boot() {
  const status = await fetch("/api/status").then((r) => r.json());
  serverKey = Boolean(status.server_key);
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
  paintModelState();
  loadHistory();
})();
