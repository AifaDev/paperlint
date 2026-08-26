/**
 * Synthetic upload fixtures with GROUND TRUTH attached.
 *
 * Why generated rather than checked-in binaries: a fixture is only useful if we
 * know exactly what the right answer is. A real paper committed as a .pdf tells
 * us what came out but never what should have — and the whole point of this
 * corpus is to measure extraction against a known layout, not against itself.
 * Generating also keeps the repo free of third-party copyrighted PDFs.
 *
 * Every builder returns a Buffer plus the `truth` the extractor is supposed to
 * recover: the captions that exist, the floats the prose mentions, the reading
 * order of the sentences, and the table rows.
 */
import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// PDF: a hand-written writer, so item positions are exactly what we specify.
// Text is drawn with an explicit text matrix per line, the way a typesetter
// places it. Fixture strings must not contain ( ) or backslash.

const IMAGE_PIXELS = String.fromCharCode(0x20, 0x40, 0x60, 0x80);

function pdfFromContent(content) {
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    "<</Length " + content.length + ">>\nstream\n" + content + "\nendstream",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += i + 1 + " 0 obj\n" + body + "\nendobj\n";
  });
  const xref = pdf.length;
  pdf += "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n";
  for (const o of offsets) pdf += String(o).padStart(10, "0") + " 00000 n \n";
  pdf += "trailer\n<</Size " + (objs.length + 1) + "/Root 1 0 R>>\nstartxref\n" + xref + "\n%%EOF";
  return Buffer.from(pdf, "latin1");
}

/**
 * @param ops - draw operations in CONTENT-STREAM ORDER. This order is the
 *   variable under test: pdf.js reports text in the order the producer wrote
 *   it, so a two-column paper is recovered correctly or not depending on it.
 *   Each op is {text,x,y} or {image:true,x,y,w,h}.
 */
function pdfFromOps(ops) {
  let content = "";
  let inText = false;
  for (const op of ops) {
    if (op.image) {
      if (inText) { content += "ET\n"; inText = false; }
      content +=
        "q " + op.w + " 0 0 " + op.h + " " + op.x + " " + op.y + " cm\n" +
        "BI /W 2 /H 2 /CS /G /BPC 8 ID " + IMAGE_PIXELS + "\nEI\nQ\n";
      continue;
    }
    if (!inText) { content += "BT /F1 11 Tf\n"; inText = true; }
    content += "1 0 0 1 " + op.x + " " + op.y + " Tm (" + op.text + ") Tj\n";
  }
  if (inText) content += "ET";
  return pdfFromContent(content);
}

// ---------------------------------------------------------------------------
// DOCX: a minimal STORED zip. Compress-Archive on Windows PowerShell writes
// backslash entry names, which OOXML readers reject, so the zip is written here.

function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, contentStr] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(contentStr, "utf8");
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="png" ContentType="image/png"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

const DOC_RELS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/fig.png"/></Relationships>';

// A 1x1 PNG. Only its presence matters.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100" +
    "05fe02fea7b5f9000000000049454e44ae426082",
  "hex",
).toString("latin1");

const para = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const cell = (t) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${para(t)}</w:tc>`;
const row = (cells) => `<w:tr>${cells.map(cell).join("")}</w:tr>`;

/** A floated image with a caption in its alt/description, as Word writes it. */
const drawing = (alt) =>
  `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
  `<wp:docPr id="1" name="Picture 1" descr="${alt}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
  `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
  `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr>` +
  `<pic:cNvPr id="1" name="fig.png" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>` +
  `<pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdImg"/>` +
  `<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
  `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1000000"/></a:xfrm>` +
  `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

function docxFromBody(bodyXml) {
  const doc =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    bodyXml +
    "</w:body></w:document>";
  return zip([
    ["[Content_Types].xml", CONTENT_TYPES],
    ["_rels/.rels", ROOT_RELS],
    ["word/_rels/document.xml.rels", DOC_RELS],
    ["word/media/fig.png", PNG],
    ["word/document.xml", doc],
  ]);
}

// ---------------------------------------------------------------------------
// THE CORPUS. Each entry carries the ground truth extraction must recover.

const TABLE_ROWS = [
  ["Dataset", "Train", "Test"],
  ["CoNLL-2003", "14041", "3453"],
  ["OntoNotes", "59924", "8262"],
];

function singleColumnOps() {
  const ops = [];
  let y = 740;
  const put = (text) => { ops.push({ text, x: 72, y }); y -= 16; };
  put("3  Experimental Setup");
  y -= 6;
  put("We evaluate the model on three benchmarks. The overall architecture");
  put("is shown in Figure 1, and dataset statistics appear in Table 1.");
  y -= 14;
  put("Figure 1: Architecture of the proposed model.");
  y -= 14;
  put("Table 1: Dataset statistics for the three benchmarks.");
  for (const r of TABLE_ROWS) {
    ops.push({ text: r[0], x: 72, y });
    ops.push({ text: r[1], x: 220, y });
    ops.push({ text: r[2], x: 320, y });
    y -= 16;
  }
  y -= 14;
  put("All three datasets are publicly available.");
  return ops;
}

/** Two columns. `order` decides the CONTENT-STREAM order, the variable under test. */
function twoColumnOps(order) {
  const LEFT = [
    "3  Experimental Setup",
    "We evaluate the model on three",
    "benchmarks. The architecture is",
    "shown in Figure 1 and the data",
    "statistics appear in Table 1.",
  ];
  const RIGHT = [
    "4  Results",
    "The model reaches 91.13 percent",
    "accuracy on the held-out split,",
    "which exceeds every baseline we",
    "measured in this study.",
  ];
  const mk = (lines, x) => lines.map((text, i) => ({ text, x, y: 740 - i * 16 }));
  const left = mk(LEFT, 60);
  const right = mk(RIGHT, 320);
  if (order === "column-major") return [...left, ...right];
  // row-major: the producer emits both columns line by line, interleaved.
  const out = [];
  for (let i = 0; i < left.length; i++) out.push(left[i], right[i]);
  return out;
}

export const FIXTURES = {
  /** Baseline: everything typeset as text. Nothing may be reported. */
  "pdf-text-only": {
    kind: "pdf",
    buffer: () => pdfFromOps(singleColumnOps()),
    truth: {
      captions: ["Figure 1", "Table 1"],
      mentioned: ["Figure 1", "Table 1"],
      images: 0,
      tableRows: TABLE_ROWS,
      expectFloatFindings: 0,
    },
  },

  /**
   * THE REPORTED BUG. Figure 1 is typeset text; Figure 2 is a pasted
   * screenshot whose caption lives inside the bitmap. The prose points at
   * both. Nothing is wrong with this manuscript.
   */
  "pdf-mixed-text-and-image": {
    kind: "pdf",
    buffer: () => {
      const ops = [];
      let y = 740;
      const put = (text) => { ops.push({ text, x: 72, y }); y -= 16; };
      put("3  Experimental Setup");
      y -= 6;
      put("We evaluate on three benchmarks. The architecture is in Figure 1.");
      put("Dataset statistics appear in Table 1, and ablations in Figure 2.");
      y -= 14;
      put("Figure 1: Architecture of the proposed model.");
      y -= 20;
      ops.push({ image: true, x: 72, y: y - 90, w: 240, h: 90 });
      y -= 110;
      ops.push({ image: true, x: 72, y: y - 90, w: 240, h: 90 });
      y -= 110;
      put("All datasets are publicly available.");
      return pdfFromOps(ops);
    },
    truth: {
      captions: ["Figure 1"],
      mentioned: ["Figure 1", "Table 1", "Figure 2"],
      images: 2,
      expectFloatFindings: 0,
      note: "Figure 2 and Table 1 are images; their captions are unreadable, so no float may be accused.",
    },
  },

  /** Every float is an image. The layer already abstains here — a guard test. */
  "pdf-all-images": {
    kind: "pdf",
    buffer: () => {
      const ops = [];
      let y = 740;
      ops.push({ text: "We evaluate on three benchmarks. See Figure 1 and Table 1.", x: 72, y });
      y -= 40;
      ops.push({ image: true, x: 72, y: y - 90, w: 240, h: 90 });
      ops.push({ image: true, x: 72, y: y - 200, w: 240, h: 90 });
      return pdfFromOps(ops);
    },
    truth: { captions: [], mentioned: ["Figure 1", "Table 1"], images: 2, expectFloatFindings: 0 },
  },

  /** Two columns, emitted column by column — the LaTeX shape. */
  "pdf-two-column-column-major": {
    kind: "pdf",
    buffer: () => pdfFromOps(twoColumnOps("column-major")),
    truth: {
      images: 0,
      /** Sentences that must survive intact. A fused column breaks these. */
      sentences: [
        "We evaluate the model on three benchmarks.",
        "The model reaches 91.13 percent accuracy on the held-out split, which exceeds every baseline we measured in this study.",
      ],
      order: ["3  Experimental Setup", "4  Results"],
    },
  },

  /** Two columns, emitted line by line across the gutter — the worst case. */
  "pdf-two-column-row-major": {
    kind: "pdf",
    buffer: () => pdfFromOps(twoColumnOps("row-major")),
    truth: {
      images: 0,
      sentences: [
        "We evaluate the model on three benchmarks.",
        "The model reaches 91.13 percent accuracy on the held-out split, which exceeds every baseline we measured in this study.",
      ],
      order: ["3  Experimental Setup", "4  Results"],
    },
  },

  /** DOCX with a real table. Rows must stay rows. */
  "docx-table": {
    kind: "docx",
    buffer: () =>
      docxFromBody(
        para("3 Experimental Setup") +
          para("We evaluate on three benchmarks. Statistics appear in Table 1.") +
          para("Table 1: Dataset statistics.") +
          "<w:tbl>" + TABLE_ROWS.map(row).join("") + "</w:tbl>" +
          para("All datasets are publicly available."),
      ),
    truth: { captions: ["Table 1"], mentioned: ["Table 1"], images: 0, tableRows: TABLE_ROWS, expectFloatFindings: 0 },
  },

  /** DOCX where the figure is an embedded picture carrying its caption in alt. */
  "docx-image-caption": {
    kind: "docx",
    buffer: () =>
      docxFromBody(
        para("We evaluate on three benchmarks. The architecture is in Figure 1.") +
          para("Ablation results appear in Figure 2.") +
          para("Figure 1: Architecture of the proposed model.") +
          drawing("Figure 2: Ablation results across benchmarks."),
      ),
    truth: {
      captions: ["Figure 1", "Figure 2"],
      mentioned: ["Figure 1", "Figure 2"],
      images: 1,
      expectFloatFindings: 0,
      note: "Figure 2's caption is recoverable from the image description.",
    },
  },
};

export function fixture(name) {
  const entry = FIXTURES[name];
  if (!entry) throw new Error(`unknown fixture: ${name}`);
  return { name, kind: entry.kind, buffer: entry.buffer(), truth: entry.truth };
}

export function allFixtures() {
  return Object.keys(FIXTURES).map(fixture);
}
