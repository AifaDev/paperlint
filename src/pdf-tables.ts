/**
 * ============================================================================
 * NOT WIRED IN — and the measurement that says why is in
 * data/eval/pdf-table-separation.json. Read it before connecting this.
 *
 * The clustering below works. What does not work is TELLING A TABLE FROM
 * TWO-COLUMN PROSE, because to this algorithm they are the same thing: text in
 * aligned x-bands. Measured against the recommended 0.75 threshold:
 *
 *     two-column prose (aligned)    0.955
 *     two-column prose (ragged)     0.766
 *     real 4x3 table                1.000
 *     real 4x4 table                1.000
 *     ragged table, missing cell    0.850
 *
 * Prose reaches 0.955 while the weakest real table scores 0.850, so the two
 * distributions OVERLAP: no threshold both accepts real tables and rejects
 * prose. Academic PDFs are overwhelmingly two-column, so wiring this would
 * report running prose as a table on the most common input this tool sees —
 * and a confidently wrong table is worse than no table, which is the whole
 * reason this file reports a confidence at all.
 *
 * THE REAL FIX is a second, independent signal that prose does not have: the
 * ruling lines a table is drawn with, which live in the page operator list.
 * Borderless tables would stay out of reach, and should stay undetected rather
 * than guessed at.
 * ============================================================================
 */
/**
 * pdf-tables.ts — reconstruct tables from positioned PDF text items.
 *
 * WHY THIS EXISTS. A PDF has no notion of a table. A table is drawn as loose
 * glyph runs that happen to line up, and the lining-up is the only evidence
 * there is. So the table has to be inferred from geometry: cluster items into
 * rows by baseline, find the x-positions that many rows start an item at, and
 * call a run of such rows a table.
 *
 * WHY CONFIDENCE IS THE POINT. That inference is a guess, and a wrong guess is
 * not a small error — a garbled table is WORSE than no table, because the
 * reader is handed cells that were never adjacent and has no way to see that
 * they were invented. Every number below therefore exists to answer one
 * question: how much did the geometry actually support this? The caller gets
 * that number and decides. `TABLE_CONFIDENCE_THRESHOLD` is our recommendation,
 * not a filter we apply for them.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO — merged cells and multi-line (wrapped)
 * cells. Both are ambiguous from geometry alone: a cell spanning two columns
 * and a cell whose text simply overflows look identical, and a wrapped cell and
 * a new row look identical. Rather than guess, we DETECT the symptoms — ragged
 * column counts, items crossing a column boundary, sparse rows — and lower the
 * confidence. A table with a merged header comes back missing that header and
 * with a confidence that says so; it never comes back with the header's words
 * shoved into an arbitrary column.
 *
 * THE FALSE POSITIVE THAT MATTERS. Ordinary prose set in two columns is, to
 * this algorithm, indistinguishable from a two-column table: every line starts
 * at one of two consistent x-positions, for dozens of consecutive rows. It is
 * the single most likely thing to be misread as a table in a real paper, so it
 * gets its own detector (`prosePenalty` below) rather than being left to luck.
 *
 * THE OTHER KNOWN GAP — RIGHT-ALIGNED COLUMNS. Columns are found from LEFT
 * edges, so a right-aligned numeric column (common: accuracies, counts,
 * p-values) has no consistent left edge to find and is not detected. This is a
 * real limitation and it is left in place rather than patched, because the
 * plausible patches (cluster right edges too, or detect whitespace gutters) are
 * a different algorithm and would need their own false-positive budget. What
 * matters is that it FAILS LOUDLY: the items that miss a boundary drive
 * `alignment` down and the rows that could not be absorbed drive `whole` down,
 * so the case measures 0.400 and a caller honouring the threshold shows
 * nothing. See the measurement table below.
 *
 * MEASURED CONFIDENCE — produced by this implementation against the fixtures in
 * tests/pdf-tables.test.mjs, which is where the threshold comes from:
 *
 *   ACCEPT (>= 0.75)
 *   clean 3x3 grid                          1.000   every measure perfect
 *   3x3 with prose above and below          1.000   the prose lines are correctly excluded
 *   sparse 4x4, one hole                    0.863   a real table with a real blank cell
 *   3x3, one cell missing                   0.800   ragged, but the cells present are right
 *   ---------------------------------------------- threshold 0.75
 *   REJECT (reported, so the caller can see why)
 *   3x3, one cell spans two columns         0.600   a cell's text belongs to two columns
 *   three-column prose                      0.544   narrow columns look most table-like
 *   6-row table, right-aligned numbers      0.400   a 2-row FRAGMENT of a 6-row table
 *   ---------------------------------------------- drop floor 0.35
 *   NOT RETURNED AT ALL
 *   two-column JUSTIFIED prose              0.100
 *   two-column RAGGED-RIGHT prose           0.100
 *   single row / empty input                —       no candidate is even formed
 *
 * The threshold sits at 0.75 because that is where the gap in those numbers is:
 * 0.800 is the worst reconstruction whose cells are all still correct (one cell
 * is simply absent), and 0.600 is the best reconstruction that puts a cell's
 * text somewhere it does not belong. A threshold between them accepts the first
 * and rejects the second, which is the line this module exists to draw.
 *
 * The 0.400 row is the one that shaped the scoring. Before the alignment and
 * fragment penalties below, that case measured 0.800 — it would have been
 * ACCEPTED, and what it hands back is two rows of a six-row table with the
 * header gone. Every cell in it is correct, which is exactly why it was
 * dangerous: nothing about the output looks wrong.
 *
 * Note what 1.000 does and does not claim: every property we can MEASURE is
 * perfect. The measures are geometric, so they cannot see a semantic mistake —
 * a table read out in the wrong reading order still measures 1.000.
 *
 * Pure: no I/O, no global state, no dependencies. Tested against synthetic item
 * sets, so the logic is exercised without needing a PDF.
 */

/** One positioned glyph run, as a PDF text layer reports it. */
export type PdfItem = {
  str: string;
  /** Left edge, in PDF user space. */
  x: number;
  /** Baseline. In PDF user space y grows UPWARD — a lower line has a LOWER y. */
  y: number;
  width: number;
  height?: number;
  fontSize?: number;
};

export type Table = {
  rows: string[][];
  /** y of the topmost row's baseline, in the input's own coordinate space. */
  top: number;
  /** y of the bottommost row's baseline, same space. */
  bottom: number;
  /** 0..1, honest. See the header block for what the numbers mean. */
  confidence: number;
};

/** One detected table region. `tables` holds that region's reconstruction. */
export type TableCandidate = { tables: Table[]; confidence: number };

export type FindTablesOptions = {
  /** Items within this many line-heights of each other share a row. */
  rowRatio?: number;
  /** Left edges within this many line-heights are the same column. */
  columnRatio?: number;
  /** A vertical gap wider than this many line-heights ends a table. */
  rowGapRatio?: number;
  /**
   * Set when items come from a y-DOWN space (screen coordinates) instead of
   * PDF user space. This cannot be inferred from the data — a table looks the
   * same either way — and getting it wrong silently reverses the row order, so
   * it is an explicit switch rather than a heuristic.
   */
  yAxisDown?: boolean;
};

/**
 * Recommended accept/reject line, justified by the measurements in the header
 * block. Above it, every cell we emit was supported by aligned geometry; below
 * it, at least one cell's text is in a column it may not belong to.
 *
 * A caller that would rather show nothing than show a wrong cell should raise
 * this. Nobody should lower it below MIN_REPORTED_CONFIDENCE.
 */
export const TABLE_CONFIDENCE_THRESHOLD = 0.75;

/**
 * Below this, a candidate is not returned at all. A reconstruction this weak is
 * not a low-confidence table, it is noise — most often two-column prose — and
 * handing it to a caller only creates the chance that some permissive threshold
 * lets it through.
 */
export const MIN_REPORTED_CONFIDENCE = 0.35;

const DEFAULTS = { rowRatio: 0.5, columnRatio: 0.5, rowGapRatio: 2.5 };

/** Fallback em size when the items carry no height or font-size at all. */
const FALLBACK_LINE_HEIGHT = 10;

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

type Row = { y: number; items: PdfItem[] };

/**
 * An em, as best we can tell. Item height or font size is the direct answer;
 * failing that, the median baseline-to-baseline distance is the only signal
 * left, and typical leading is ~1.2em, so it is scaled back to an em rather
 * than used raw — a tolerance derived from the leading itself would be wide
 * enough to merge adjacent lines into one row.
 */
function estimateLineHeight(items: PdfItem[]): number {
  const sizes: number[] = [];
  for (const item of items) {
    const size = item.height ?? item.fontSize;
    if (typeof size === "number" && isFinite(size) && size > 0) sizes.push(size);
  }
  if (sizes.length) return median(sizes);

  const ys = Array.from(new Set(items.map((item) => item.y))).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < ys.length; i += 1) {
    const gap = ys[i] - ys[i - 1];
    if (gap > 0) gaps.push(gap);
  }
  const leading = median(gaps);
  return leading > 0 ? leading / 1.2 : FALLBACK_LINE_HEIGHT;
}

/** Group items into rows by baseline, top row first. */
function buildRows(items: PdfItem[], tolerance: number, yAxisDown: boolean): Row[] {
  const sorted = items.slice().sort((a, b) => (yAxisDown ? a.y - b.y : b.y - a.y));
  const rows: Row[] = [];
  for (const item of sorted) {
    const current = rows[rows.length - 1];
    if (current && Math.abs(item.y - current.items[current.items.length - 1].y) <= tolerance) {
      current.items.push(item);
      continue;
    }
    rows.push({ y: item.y, items: [item] });
  }
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    // The row's y is the median of its items, not the first item's: a
    // superscript or a slightly-raised glyph run should not drag the row.
    row.y = median(row.items.map((item) => item.y));
  }
  return rows;
}

type ColumnCluster = { center: number; rows: Set<number> };

/**
 * Cluster item left edges into candidate column positions.
 *
 * Single-linkage, but capped: a cluster may not grow wider than twice the
 * tolerance. Without the cap, a page of slightly-varying indents chains into
 * one enormous "column" and every alignment measure downstream becomes
 * meaningless.
 */
function clusterColumns(rows: Row[], rowIndices: number[], tolerance: number): ColumnCluster[] {
  const edges: { x: number; row: number }[] = [];
  for (const index of rowIndices) {
    for (const item of rows[index].items) edges.push({ x: item.x, row: index });
  }
  edges.sort((a, b) => a.x - b.x);

  const clusters: ColumnCluster[] = [];
  let members: { x: number; row: number }[] = [];
  const flush = () => {
    if (!members.length) return;
    const center = members.reduce((sum, edge) => sum + edge.x, 0) / members.length;
    clusters.push({ center, rows: new Set(members.map((edge) => edge.row)) });
    members = [];
  };
  for (const edge of edges) {
    if (
      members.length &&
      (edge.x - members[members.length - 1].x > tolerance || edge.x - members[0].x > tolerance * 2)
    ) {
      flush();
    }
    members.push(edge);
  }
  flush();
  return clusters;
}

/** Which candidate boundaries a row actually starts an item at. */
function boundariesOf(row: Row, centers: number[], tolerance: number): Set<number> {
  const touched = new Set<number>();
  for (const item of row.items) {
    for (let c = 0; c < centers.length; c += 1) {
      if (Math.abs(item.x - centers[c]) <= tolerance) {
        touched.add(c);
        break;
      }
    }
  }
  return touched;
}

/** Column index for an item: nearest center within tolerance, else the last
 *  center it is at or past. The second case is a miss and is counted as one. */
function columnFor(x: number, centers: number[], tolerance: number): { column: number; aligned: boolean } {
  let best = -1;
  let bestDistance = Infinity;
  for (let c = 0; c < centers.length; c += 1) {
    const distance = Math.abs(x - centers[c]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = c;
    }
  }
  if (best >= 0 && bestDistance <= tolerance) return { column: best, aligned: true };

  let fallback = 0;
  for (let c = 0; c < centers.length; c += 1) if (x >= centers[c]) fallback = c;
  return { column: fallback, aligned: false };
}

/**
 * Join the items of one cell. Adjacent runs are concatenated directly unless
 * the gap between them is wide enough to be a real space — the same problem
 * kerning and ligature splits cause in plain text extraction, where naive
 * joining turns "the results" into "theresults" or "Ac curacy".
 */
function cellText(items: PdfItem[], lineHeight: number): string {
  const spaceGap = lineHeight * 0.2;
  let out = "";
  let previousRight: number | null = null;
  for (const item of items) {
    const text = String(item.str ?? "");
    if (!text.trim() && out) {
      previousRight = item.x + item.width;
      continue;
    }
    if (out !== "" && previousRight !== null && item.x - previousRight > spaceGap) out += " ";
    out += text;
    previousRight = item.x + item.width;
  }
  return out.replace(/\s+/g, " ").trim();
}

type Region = { rows: number[]; centers: number[] };

/**
 * Find runs of consecutive rows that share at least two column boundaries.
 *
 * The shared-boundary test is what keeps a full-width prose line — a caption
 * above a table, a paragraph below it — out of the run: such a line starts one
 * item, at the left margin, so it shares exactly one boundary and the run ends
 * there. That is the desired outcome; the alternative is absorbing the caption
 * into the table as a phantom row.
 */
function findRegions(rows: Row[], lineHeight: number, options: Required<Omit<FindTablesOptions, "yAxisDown">>): Region[] {
  const columnTolerance = lineHeight * options.columnRatio;
  const maxGap = lineHeight * options.rowGapRatio;

  const allIndices = rows.map((_, index) => index);
  const globalCenters = clusterColumns(rows, allIndices, columnTolerance)
    .filter((cluster) => cluster.rows.size >= 2)
    .map((cluster) => cluster.center)
    .sort((a, b) => a - b);
  if (globalCenters.length < 2) return [];

  const perRow = rows.map((row) => boundariesOf(row, globalCenters, columnTolerance));

  const regions: Region[] = [];
  let start = 0;
  while (start < rows.length) {
    let shared = new Set(perRow[start]);
    let end = start;
    while (end + 1 < rows.length) {
      const gap = Math.abs(rows[end].y - rows[end + 1].y);
      if (gap > maxGap) break;
      const next = new Set<number>();
      for (const boundary of perRow[end + 1]) if (shared.has(boundary)) next.add(boundary);
      if (next.size < 2) break;
      shared = next;
      end += 1;
    }

    if (end > start && shared.size >= 2) {
      const indices: number[] = [];
      for (let i = start; i <= end; i += 1) indices.push(i);
      // Re-cluster inside the run: the region's own columns, not the page's.
      // A column supported by only one row of the run is that row's stray
      // item, not a column, and inventing it would add an empty cell to every
      // other row.
      const centers = clusterColumns(rows, indices, columnTolerance)
        .filter((cluster) => cluster.rows.size >= 2)
        .map((cluster) => cluster.center)
        .sort((a, b) => a - b);
      if (centers.length >= 2) regions.push({ rows: indices, centers });
      start = end + 1;
      continue;
    }
    start += 1;
  }
  return regions;
}

type Assembled = {
  grid: string[][];
  filled: number;
  alignedItems: number;
  totalItems: number;
  straddlingItems: number;
  meanWordsPerCell: number;
  meanFill: number;
};

function assemble(rows: Row[], region: Region, lineHeight: number, columnTolerance: number): Assembled {
  const { centers } = region;
  const grid: string[][] = [];
  const cellItems: PdfItem[][][] = [];
  let alignedItems = 0;
  let totalItems = 0;
  let straddlingItems = 0;

  for (const index of region.rows) {
    const buckets: PdfItem[][] = centers.map(() => []);
    for (const item of rows[index].items) {
      totalItems += 1;
      const { column, aligned } = columnFor(item.x, centers, columnTolerance);
      const bucket = buckets[column];
      // Only the run that OPENS a cell has to sit on the boundary. A cell of
      // more than one run — kerning and ligature splits produce them
      // constantly — has continuations that start mid-cell by definition, and
      // counting those as misalignment would penalise every real table.
      // A run that starts after a wide gap is not a continuation, though: that
      // gap is more likely a column we failed to detect, so it stays a miss.
      const continuation =
        bucket.length > 0 && item.x - (bucket[bucket.length - 1].x + bucket[bucket.length - 1].width) <= lineHeight;
      if (aligned || continuation) alignedItems += 1;
      bucket.push(item);
      // An item reaching past a LATER column's start is the merged-cell /
      // overflowing-cell symptom. We cannot tell which it is, so we do not try
      // to split it — we record it and let it cost confidence.
      const right = item.x + item.width;
      for (let c = column + 1; c < centers.length; c += 1) {
        if (right > centers[c] + columnTolerance) {
          straddlingItems += 1;
          break;
        }
      }
    }
    cellItems.push(buckets);
    grid.push(buckets.map((bucket) => cellText(bucket, lineHeight)));
  }

  let filled = 0;
  let words = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (!cell) continue;
      filled += 1;
      words += cell.split(/\s+/).length;
    }
  }

  // How uniformly each column is filled by its own widest cell. Running prose
  // in a column produces line after line of near-identical width (≈1.0);
  // genuine cells vary, because "Method" and "0.72" are not the same size.
  const fills: number[] = [];
  for (let c = 0; c < centers.length; c += 1) {
    let extent = 0;
    for (const buckets of cellItems) {
      for (const item of buckets[c]) extent = Math.max(extent, item.x + item.width - centers[c]);
    }
    if (extent <= 0) continue;
    for (const buckets of cellItems) {
      if (!buckets[c].length) continue;
      const first = buckets[c][0];
      const last = buckets[c][buckets[c].length - 1];
      fills.push(clamp01((last.x + last.width - first.x) / extent));
    }
  }

  return {
    grid,
    filled,
    alignedItems,
    totalItems,
    straddlingItems,
    meanWordsPerCell: filled ? words / filled : 0,
    meanFill: fills.length ? fills.reduce((sum, fill) => sum + fill, 0) / fills.length : 0,
  };
}

/**
 * The prose discriminator. Two-column prose satisfies every structural test a
 * table does — consistent boundaries, full rows, perfect alignment — so
 * structure cannot separate them and content has to.
 *
 * Two signals, and BOTH are required, because either alone has honest
 * counter-examples: a table can hold a wordy cell, and a column of numbers can
 * be perfectly uniform in width. Prose is the conjunction — long cells that
 * also fill their column to the same width line after line.
 */
function prosePenalty(assembled: Assembled): number {
  // 3 words is a long header ("Recovery time (days)"); 8+ is a line of text.
  const wordScore = clamp01((assembled.meanWordsPerCell - 3) / 5);
  // 0.65 is roughly where the clean grids measure; 0.90 is set text.
  const fillScore = clamp01((assembled.meanFill - 0.65) / 0.25);
  return 1 - 0.9 * (wordScore * fillScore);
}

/** Most common cell count across the rows; ties resolve to the larger count,
 *  since more columns is the likelier true shape of a table with gaps. */
function modalCellCount(grid: string[][]): number {
  const counts = new Map<number, number>();
  for (const row of grid) {
    const filled = row.filter((cell) => cell !== "").length;
    counts.set(filled, (counts.get(filled) ?? 0) + 1);
  }
  let best = 0;
  let bestFrequency = 0;
  for (const [count, frequency] of counts) {
    if (frequency > bestFrequency || (frequency === bestFrequency && count > best)) {
      best = count;
      bestFrequency = frequency;
    }
  }
  return best;
}

function scoreRegion(
  assembled: Assembled,
  rowCount: number,
  columnCount: number,
  stranded: number,
): number {
  const cells = rowCount * columnCount;

  // Ragged column counts — the symptom of a merged or wrapped cell.
  const modal = modalCellCount(assembled.grid);
  const regular = assembled.grid.filter((row) => row.filter((cell) => cell !== "").length === modal).length;
  const regularity = rowCount ? regular / rowCount : 0;

  // Holes. A genuinely sparse table is penalised here too; that is the honest
  // trade, because from geometry a deliberate blank and a lost cell are the
  // same picture.
  const occupancy = cells ? assembled.filled / cells : 0;

  // Occupancy carries more weight than regularity because a hole is a
  // countable defect, while raggedness is one hole described a second way.
  const base = 0.4 * regularity + 0.6 * occupancy;

  // The three multiplicative factors are all forms of "this cell's text may not
  // belong here". They multiply rather than average because averaging lets a
  // tidy-looking grid dilute them, and it is exactly the tidy-looking wrong
  // table that does the damage. Each is doubled so that a defect rate of a half
  // is total: at that point nothing about the reconstruction is trustworthy.

  // An item that did not land on a detected column is text we placed by
  // fallback rather than by evidence — the symptom of a column we failed to
  // find. Right-aligned numeric columns fail exactly this way.
  const misplaced = assembled.totalItems
    ? (assembled.totalItems - assembled.alignedItems) / assembled.totalItems
    : 0;
  const alignment = 1 - clamp01(2 * misplaced);

  const straddle = 1 - clamp01(assembled.totalItems ? (2 * assembled.straddlingItems) / assembled.totalItems : 0);

  // Two rows sharing two boundaries can happen by accident between any two
  // adjacent lines. Three cannot, so two rows is discounted rather than
  // rejected — some tables really are two rows.
  const size = rowCount >= 3 ? 1 : 0.8;

  // Stranded neighbours: table-shaped rows touching this run that we could not
  // fit into it. They mean this is a FRAGMENT of a larger table, which is its
  // own kind of lie — the cells are right but the table is not the table.
  const whole = 1 - 0.25 * stranded;

  return clamp01(base * alignment * straddle * size * whole * prosePenalty(assembled));
}

/**
 * Count rows directly above and below a region that look like table rows we
 * failed to include.
 *
 * The test is deliberately narrow. A row of TWO OR MORE items sharing a column
 * with the region is a row we should have absorbed and did not. A single
 * full-width run is a caption or a sentence, and penalising the table for
 * having a caption would make the confidence meaningless on real pages — every
 * table has one.
 */
function strandedNeighbours(rows: Row[], region: Region, columnTolerance: number, maxGap: number): number {
  const first = region.rows[0];
  const last = region.rows[region.rows.length - 1];
  let count = 0;
  for (const index of [first - 1, last + 1]) {
    const neighbour = rows[index];
    if (!neighbour || neighbour.items.length < 2) continue;
    const anchor = rows[index < first ? first : last];
    if (Math.abs(neighbour.y - anchor.y) > maxGap) continue;
    const shares = neighbour.items.some((item) =>
      region.centers.some((center) => Math.abs(item.x - center) <= columnTolerance),
    );
    if (shares) count += 1;
  }
  return count;
}

/**
 * Reconstruct tables from positioned text items.
 *
 * Returns one entry per detected region, most confident first. `tables` holds
 * that region's reconstruction — one table today; the shape leaves room for a
 * region that later proves to be two stacked tables without changing callers.
 *
 * Candidates scoring below MIN_REPORTED_CONFIDENCE are not returned. Everything
 * else is returned WITH its confidence and no filtering: compare against
 * TABLE_CONFIDENCE_THRESHOLD and reject, do not assume this function did.
 */
export function findTables(items: PdfItem[], options: FindTablesOptions = {}): TableCandidate[] {
  const usable = (items ?? []).filter(
    (item) =>
      item &&
      typeof item.x === "number" &&
      typeof item.y === "number" &&
      isFinite(item.x) &&
      isFinite(item.y) &&
      String(item.str ?? "").trim() !== "",
  );
  if (usable.length < 4) return [];

  const settings = {
    rowRatio: options.rowRatio ?? DEFAULTS.rowRatio,
    columnRatio: options.columnRatio ?? DEFAULTS.columnRatio,
    rowGapRatio: options.rowGapRatio ?? DEFAULTS.rowGapRatio,
  };
  const lineHeight = estimateLineHeight(usable);
  const columnTolerance = lineHeight * settings.columnRatio;

  const rows = buildRows(usable, lineHeight * settings.rowRatio, options.yAxisDown === true);
  if (rows.length < 2) return [];

  const candidates: TableCandidate[] = [];
  for (const region of findRegions(rows, lineHeight, settings)) {
    const assembled = assemble(rows, region, lineHeight, columnTolerance);
    const stranded = strandedNeighbours(rows, region, columnTolerance, lineHeight * settings.rowGapRatio);
    const confidence = scoreRegion(assembled, region.rows.length, region.centers.length, stranded);
    if (confidence < MIN_REPORTED_CONFIDENCE) continue;

    const ys = region.rows.map((index) => rows[index].y);
    candidates.push({
      confidence,
      tables: [
        {
          rows: assembled.grid,
          top: options.yAxisDown === true ? Math.min(...ys) : Math.max(...ys),
          bottom: options.yAxisDown === true ? Math.max(...ys) : Math.min(...ys),
          confidence,
        },
      ],
    });
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}

/** Convenience for the common caller: the tables worth showing, nothing else. */
export function acceptedTables(
  items: PdfItem[],
  options: FindTablesOptions = {},
  threshold: number = TABLE_CONFIDENCE_THRESHOLD,
): Table[] {
  const out: Table[] = [];
  for (const candidate of findTables(items, options)) {
    if (candidate.confidence >= threshold) out.push(...candidate.tables);
  }
  return out;
}
