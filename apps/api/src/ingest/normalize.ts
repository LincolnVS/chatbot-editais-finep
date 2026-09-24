/** DoclingDocumentJson → ParsedDocument (ordem de leitura, hierarquia por regex pt-BR, bbox normalizado, tabelas). */
import type { ParsedDocument, CanonicalDocument, CanonicalSection, Block, BBox, TableData, PageInfo } from '@editais/shared';
import type { DoclingDocumentJson, DoclingProv, DoclingTableItem, DoclingTableCell, DoclingTextItem } from './docling.ts';

export type NormalizeOptions = { removeHeaderFooter: boolean; parserVersion: string; fallbackTitle: string };

/** Utilitário exportado para testes/experimentos: classifica uma linha de texto. */
export type NumberingMatch = { kind: 'section' | 'item' | 'alinea'; level: number; itemNumber: string; rest: string } | null;

/* ------------------------------------------------------------------------------------------------
 * Texto
 * ---------------------------------------------------------------------------------------------- */

const LIGATURES: Record<string, string> = { '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st' };
/** Prefixos que legitimamente usam hífen em pt-BR — o hífen antes deles não é quebra de linha. */
const HYPHEN_PREFIXES = /(?:^|[^\p{L}])(?:pré|pós|anti|auto|co|sub|ex|vice|semi|micro|macro|bem|sem|não|inter|infra|ultra|super|contra|extra|multi|pró|recém|além|aquém)$/u;
const BULLET_RE = /^[\u2022\u00B7\u25AA\u25CF\u25CB\u25E6\u25A0\u25A1\u27A2\u27A4\u25BA]\s*/u;

/** Normaliza espaços, NBSP, ligaduras e hífens de quebra de linha ("desen- volvimento" → "desenvolvimento"). */
export function normalizeText(input: string): string {
  let s = input.normalize('NFC');
  s = s.replace(/[\uFB00-\uFB06]/g, (ch) => LIGATURES[ch] ?? ch);
  s = s.replace(/[\u00A0\u2007\u202F]/g, ' ').replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '');
  s = s.replace(/(\p{L}+)-\s+(\p{Ll})/gu, (whole, before: string, after: string, offset: number) => {
    const head = s.slice(Math.max(0, offset - 12), offset) + before;
    return HYPHEN_PREFIXES.test(head) ? `${before}-${after}` : `${before}${after}`;
  });
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function upperRatio(s: string): number {
  const letters = s.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 3) return 0;
  const upper = s.match(/\p{Lu}/gu)?.length ?? 0;
  return upper / letters;
}

/* ------------------------------------------------------------------------------------------------
 * Numeração
 * ---------------------------------------------------------------------------------------------- */

const RE_ITEM = /^(\d{1,2}(?:\.\d{1,2}){1,5})\s*\.?(?:\s+|$)/u;
/** "6. DESPESAS", "15 CRONOGRAMA" e também "11.Disposição Geral" (sem espaço após o ponto, como no regulamento MIB). */
const RE_SECTION = /^(\d{1,2})(?:\.\s*|\s+)(?=\p{Lu})/u;
const RE_ANEXO = /^ANEXO\s+([IVXLC]+|\d{1,2})(?!\w)/u;
const RE_CLAUSULA = /^CL[ÁA]USULA\s+([\p{L}\p{N}]+[ªº°]?)/u;
const RE_ARTIGO = /^Art(?:\.|igo)?\s*(\d{1,3})[ºo°]?(?![\d.])/u;
const RE_PARAGRAFO = /^§\s*(\d{1,2})[ºo°]?/u;
const RE_PARAGRAFO_UNICO = /^Par[áa]grafo\s+[úu]nico\b/iu;
const RE_ALINEA_LOWER = /^([a-z]|[ivx]{2,4})[.)]\s+/u;
const RE_ALINEA_UPPER = /^([A-Z])[.)]\s+(?=\S)/u;
const RE_ROMAN = /^([IVX]{1,4}|[IVXLC]{2,6})\s*[-–—.)]\s+/u;
const REST_SEP = /^[\s\-–—:.)]+/u;

function rest(text: string, consumed: number): string {
  return text.slice(consumed).replace(REST_SEP, '').trim();
}

/** Classifica uma linha pelo início do texto. */
export function detectNumbering(text: string): NumberingMatch {
  const t = text.trimStart();
  let m: RegExpMatchArray | null;

  if ((m = t.match(RE_ITEM))) {
    const num = m[1]!;
    return { kind: 'item', level: 1 + (num.match(/\./g)?.length ?? 0), itemNumber: num, rest: rest(t, m[0].length) };
  }
  if ((m = t.match(RE_ANEXO))) {
    return { kind: 'section', level: 1, itemNumber: `ANEXO ${m[1]}`, rest: rest(t, m[0].length) };
  }
  if ((m = t.match(RE_CLAUSULA))) {
    return { kind: 'section', level: 1, itemNumber: `CLÁUSULA ${m[1]}`, rest: rest(t, m[0].length) };
  }
  if ((m = t.match(RE_ARTIGO))) {
    return { kind: 'item', level: 2, itemNumber: `Art. ${m[1]}`, rest: rest(t, m[0].length) };
  }
  if ((m = t.match(RE_PARAGRAFO))) {
    return { kind: 'item', level: 3, itemNumber: `§ ${m[1]}`, rest: rest(t, m[0].length) };
  }
  if ((m = t.match(RE_PARAGRAFO_UNICO))) {
    return { kind: 'item', level: 3, itemNumber: 'Parágrafo único', rest: rest(t, m[0].length) };
  }
  if ((m = t.match(RE_SECTION))) {
    return { kind: 'section', level: 1, itemNumber: m[1]!, rest: rest(t, m[0].length) };
  }
  if ((m = t.match(RE_ALINEA_LOWER))) {
    return { kind: 'alinea', level: 0, itemNumber: m[1]!, rest: rest(t, m[0].length) };
  }
  if ((m = t.match(RE_ROMAN))) {
    return { kind: 'alinea', level: 0, itemNumber: m[1]!, rest: rest(t, m[0].length) };
  }
  if ((m = t.match(RE_ALINEA_UPPER))) {
    return { kind: 'alinea', level: 0, itemNumber: m[1]!, rest: rest(t, m[0].length) };
  }
  return null;
}

const isDotted = (num: string): boolean => /^\d+(?:\.\d+)*$/.test(num);
const isDottedPrefix = (parent: string, child: string): boolean => child.startsWith(`${parent}.`);
/** "2" → "3", "6.5" → "6.6": `next` é o irmão imediatamente seguinte de `num`. */
const isNextSibling = (num: string, next: string): boolean => {
  const a = num.split('.');
  const b = next.split('.');
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length - 1; i++) if (a[i] !== b[i]) return false;
  return Number(b[b.length - 1]) === Number(a[a.length - 1]) + 1;
};

/* ------------------------------------------------------------------------------------------------
 * Geometria
 * ---------------------------------------------------------------------------------------------- */

type PageSizes = Record<string, { width: number; height: number }>;

function pageSize(sizes: PageSizes, page: number): { width: number; height: number } {
  return sizes[String(page)] ?? Object.values(sizes)[0] ?? { width: 595.32, height: 841.92 };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, Math.round(v * 10_000) / 10_000));

function toBBox(prov: DoclingProv, sizes: PageSizes): BBox {
  const { width: W, height: H } = pageSize(sizes, prov.page_no);
  const { l, t, r, b, coord_origin } = prov.bbox;
  const bottomLeft = coord_origin !== 'TOPLEFT';
  const y0 = bottomLeft ? 1 - t / H : t / H;
  const y1 = bottomLeft ? 1 - b / H : b / H;
  return {
    page: prov.page_no,
    x0: clamp01(Math.min(l, r) / W),
    y0: clamp01(Math.min(y0, y1)),
    x1: clamp01(Math.max(l, r) / W),
    y1: clamp01(Math.max(y0, y1)),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Travessia do DoclingDocument
 * ---------------------------------------------------------------------------------------------- */

type FlatText = { kind: 'text'; ref: string; item: DoclingTextItem; text: string; bboxes: BBox[] };
type FlatTable = { kind: 'table'; ref: string; item: DoclingTableItem; bboxes: BBox[] };
type FlatItem = FlatText | FlatTable;

function resolveRef(doc: DoclingDocumentJson, ref: string): unknown {
  const m = ref.match(/^#\/(texts|tables|groups|pictures)\/(\d+)$/);
  if (!m) return undefined;
  return (doc as unknown as Record<string, unknown[]>)[m[1]!]?.[Number(m[2])];
}

/** Achata body.children em ordem de leitura, já sem furniture/cabeçalhos/rodapés/pictures. */
function flatten(doc: DoclingDocumentJson, sizes: PageSizes, counters: { furniture: number }): FlatItem[] {
  const out: FlatItem[] = [];
  const seen = new Set<string>();

  const pushText = (ref: string, item: DoclingTextItem, forcedLabel?: string): void => {
    if (seen.has(ref)) return;
    seen.add(ref);
    const label = forcedLabel ?? item.label;
    if (label === 'page_header' || label === 'page_footer' || item.content_layer === 'furniture') {
      counters.furniture++;
      return;
    }
    const text = normalizeText(item.orig ?? item.text ?? '');
    if (!text) return;
    out.push({ kind: 'text', ref, item: forcedLabel ? { ...item, label } : item, text, bboxes: (item.prov ?? []).map((p) => toBBox(p, sizes)) });
  };

  const pushCaptions = (refs: { $ref: string }[] | undefined): void => {
    for (const c of refs ?? []) {
      const t = resolveRef(doc, c.$ref) as DoclingTextItem | undefined;
      if (t && typeof t.text === 'string') pushText(c.$ref, t, 'caption');
    }
  };

  const walk = (children: { $ref: string }[] | undefined): void => {
    for (const child of children ?? []) {
      const ref = child.$ref;
      const target = resolveRef(doc, ref);
      if (!target) continue;
      if (ref.startsWith('#/groups/')) {
        walk((target as { children?: { $ref: string }[] }).children);
      } else if (ref.startsWith('#/texts/')) {
        pushText(ref, target as DoclingTextItem);
      } else if (ref.startsWith('#/tables/')) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        const table = target as DoclingTableItem;
        pushCaptions(table.captions);
        out.push({ kind: 'table', ref, item: table, bboxes: (table.prov ?? []).map((p) => toBBox(p, sizes)) });
      } else if (ref.startsWith('#/pictures/')) {
        // A imagem em si é ignorada; a legenda é texto real do documento.
        pushCaptions((target as { captions?: { $ref: string }[] }).captions);
      }
    }
  };
  walk(doc.body?.children);
  return out;
}

/** Posição de leitura (página, topo normalizado) do primeiro bbox. */
function position(it: FlatItem): { page: number; top: number } | null {
  const b = it.bboxes[0];
  return b ? { page: b.page, top: b.y0 } : null;
}

/** Reposiciona cada tabela antes do primeiro bloco de texto que está abaixo dela na página. */
function relocateTables(items: FlatItem[]): FlatItem[] {
  const tables = items.filter((it): it is FlatTable => it.kind === 'table' && position(it) !== null);
  if (tables.length === 0) return items;
  const pending = [...tables].sort((a, b) => {
    const pa = position(a)!;
    const pb = position(b)!;
    return pa.page - pb.page || pa.top - pb.top;
  });
  const out: FlatItem[] = [];
  const isAfter = (t: FlatTable, pos: { page: number; top: number }): boolean => {
    const pt = position(t)!;
    return pt.page < pos.page || (pt.page === pos.page && pt.top <= pos.top);
  };
  for (const it of items) {
    if (it.kind === 'table' && position(it) !== null) continue;
    const pos = position(it);
    if (pos) while (pending.length && isAfter(pending[0]!, pos)) out.push(pending.shift()!);
    out.push(it);
  }
  out.push(...pending);
  return out;
}

/** Remove linhas repetidas nas faixas superior/inferior (8 %) em ≥ 60 % das páginas. Devolve quantas linhas saíram. */
function dropRepeatedHeaderFooter(items: FlatItem[], pageCount: number): { items: FlatItem[]; removed: number } {
  if (pageCount < 2) return { items, removed: 0 };
  const inBand = (it: FlatText): boolean => it.bboxes.some((b) => b.y0 <= 0.08 || b.y1 >= 0.92);
  const key = (it: FlatText): string => it.text.toLowerCase().replace(/\d+/g, '#');
  const pagesByKey = new Map<string, Set<number>>();
  for (const it of items) {
    if (it.kind !== 'text' || !inBand(it)) continue;
    const set = pagesByKey.get(key(it)) ?? new Set<number>();
    set.add(it.bboxes[0]!.page);
    pagesByKey.set(key(it), set);
  }
  const threshold = Math.max(2, Math.ceil(0.6 * pageCount));
  const repeated = new Set([...pagesByKey.entries()].filter(([, pages]) => pages.size >= threshold).map(([k]) => k));
  if (repeated.size === 0) return { items, removed: 0 };
  let removed = 0;
  const kept = items.filter((it) => {
    if (it.kind === 'text' && inBand(it) && repeated.has(key(it))) {
      removed++;
      return false;
    }
    return true;
  });
  return { items: kept, removed };
}

/* ------------------------------------------------------------------------------------------------
 * Tabelas
 * ---------------------------------------------------------------------------------------------- */

function gridFromCells(cells: DoclingTableCell[], numRows: number, numCols: number): DoclingTableCell[][] {
  const grid: DoclingTableCell[][] = Array.from({ length: numRows }, () => []);
  for (const cell of cells) {
    for (let r = cell.start_row_offset_idx; r < Math.min(cell.end_row_offset_idx, numRows); r++) {
      for (let c = cell.start_col_offset_idx; c < Math.min(cell.end_col_offset_idx, numCols); c++) grid[r]![c] = cell;
    }
  }
  return grid;
}

/** Palavra final que denuncia uma célula interrompida pelo layout ("De R$ 4.800.000,01 a" | "R$ 16.000.000,00"). */
const DANGLING_END = /(?:^|\s)(?:a|e|de|do|da|ou|até|entre|com|para|por|em)$/iu;

/** Linha cujas células (não vazias) são todas a mesma célula ocupando a largura inteira, ou marcada `row_section`. */
function isSectionRow(row: DoclingTableCell[], numCols: number): boolean {
  const cells = row.filter((c) => c && normalizeText(c.text) !== '');
  if (cells.length === 0) return false;
  if (cells.some((c) => c.row_section)) return true;
  const first = cells[0]!;
  return numCols > 1 && cells.every((c) => c.start_col_offset_idx === first.start_col_offset_idx && c.end_col_offset_idx === first.end_col_offset_idx) &&
    first.end_col_offset_idx - first.start_col_offset_idx >= numCols;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- reconstrução do grid do Docling (row_span, células quebradas); coberta por fixtures
function tableData(t: DoclingTableItem): TableData {
  const data = t.data ?? { num_rows: 0, num_cols: 0, grid: [] };
  let grid = data.grid ?? [];
  if (grid.length === 0 && data.table_cells?.length) grid = gridFromCells(data.table_cells, data.num_rows, data.num_cols);
  const numCols = Math.max(data.num_cols ?? 0, ...grid.map((r) => r.length));
  const rows: string[][] = [];
  const headerRows: number[] = [];
  const sectionRows: number[] = [];
  /** Linha do grid de onde saiu a última linha emitida (para detectar row_span que continua). */
  let prevGridRow: DoclingTableCell[] | undefined;
  for (const row of grid) {
    const cells = Array.from({ length: numCols }, (_, c) => normalizeText(row[c]?.text ?? ''));
    if (cells.every((c) => c === '')) continue;
    // Célula quebrada em duas linhas: alguma coluna continua a MESMA célula da linha anterior (row_span) e as demais
    // células novas são continuação ("De R$ 4.800.000,01 a" + "R$ 16.000.000,00").
    const last = rows[rows.length - 1];
    if (last && prevGridRow) {
      const previousRow = prevGridRow;
      const spans = row.map((c, i) => {
        const prev = previousRow[i];
        return !!c && !!prev && c.start_row_offset_idx === prev.start_row_offset_idx && c.start_col_offset_idx === prev.start_col_offset_idx && c.end_row_offset_idx > prev.start_row_offset_idx + 1;
      });
      const fresh = cells.map((v, i) => (spans[i] ? '' : v)).map((v, i) => ({ v, i })).filter(({ v }) => v !== '');
      const continuation = spans.some(Boolean) && fresh.length > 0 &&
        fresh.every(({ v, i }) => DANGLING_END.test(last[i] ?? '') || /^\p{Ll}/u.test(v) || /^R\$/.test(v));
      if (continuation) {
        for (const { v, i } of fresh) last[i] = `${last[i]} ${v}`.trim();
        continue;
      }
    }
    prevGridRow = row;
    const idx = rows.length;
    if (isSectionRow(row, numCols)) sectionRows.push(idx);
    else if (row.length > 0 && row.every((c) => c?.column_header)) headerRows.push(idx);
    rows.push(cells);
  }
  const out: TableData = { numRows: rows.length, numCols, rows, headerRows };
  if (sectionRows.length) out.sectionRows = sectionRows;
  return out;
}

export type TableLayout = {
  /** Linhas de cabeçalho efetivas (contíguas a partir do primeiro cabeçalho que não é divisória; sem cabeçalho, a 1ª linha). */
  headerRows: number[];
  /** Nome de cada coluna (cabeçalhos combinados). */
  names: string[];
  /** Índices (em `rows`) das linhas que não são cabeçalho, na ordem — inclusive divisórias. */
  dataRows: number[];
  isSection(rowIndex: number): boolean;
  /** Título da divisória de grupo vigente para a linha ("Grau de Inovação"), se houver. */
  sectionTitle(rowIndex: number): string | undefined;
};

/** Regra única de leitura de uma TableData (Markdown, chunker, frases por linha). */
export function tableLayout(t: TableData): TableLayout {
  const sections = new Set(t.sectionRows ?? []);
  const headerRows: number[] = [];
  const first = t.headerRows.find((r) => !sections.has(r));
  if (first !== undefined) {
    for (let r = first; t.headerRows.includes(r) && !sections.has(r) && r < t.rows.length; r++) headerRows.push(r);
  } else if (t.rows.length > 0) {
    headerRows.push(0);
    sections.delete(0);
  }
  const names = Array.from({ length: t.numCols }, (_, c) => {
    const parts: string[] = [];
    for (const r of headerRows) {
      const v = t.rows[r]![c] ?? '';
      if (v && !parts.includes(v)) parts.push(v);
    }
    return parts.join(' ');
  });
  const dataRows = t.rows.map((_, i) => i).filter((i) => !headerRows.includes(i));
  const title = (i: number): string => t.rows[i]!.find((v) => v !== '') ?? '';
  return {
    headerRows,
    names,
    dataRows,
    isSection: (i) => sections.has(i),
    sectionTitle: (i) => {
      for (let r = i - 1; r >= 0; r--) if (sections.has(r)) return title(r);
      return undefined;
    },
  };
}

const sameRow = (a: string[] | undefined, b: string[] | undefined): boolean =>
  !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

/** Continuação de célula quebrada na virada de página: linha com célula vazia e textos começando em minúscula. */
function isContinuationRow(row: string[]): boolean {
  const filled = row.filter((c) => c !== '');
  return filled.length > 0 && filled.length < row.length && filled.every((c) => /^\p{Ll}/u.test(c));
}

/** Mescla uma tabela quebrada entre páginas no bloco `prev`, in place. */
function mergeTables(prev: Block, b: TableData, pageEnd: number, bboxes: BBox[]): void {
  const a = prev.table!;
  let rows = b.rows;
  if (sameRow(rows[0], a.rows[0])) rows = rows.slice(1);
  if (rows.length && a.rows.length && isContinuationRow(rows[0]!)) {
    const last = a.rows[a.rows.length - 1]!;
    a.rows[a.rows.length - 1] = last.map((cell, i) => (rows[0]![i] ? `${cell} ${rows[0]![i]}`.trim() : cell));
    rows = rows.slice(1);
  }
  const dropped = b.rows.length - rows.length;
  const shifted = (b.sectionRows ?? []).filter((i) => i >= dropped).map((i) => i - dropped + a.rows.length);
  if (shifted.length) a.sectionRows = [...(a.sectionRows ?? []), ...shifted];
  a.rows.push(...rows);
  a.numRows = a.rows.length;
  prev.pageEnd = Math.max(prev.pageEnd, pageEnd);
  prev.bboxes.push(...bboxes);
  prev.text = tableText(a);
}

function tableText(t: TableData): string {
  const sections = new Set(t.sectionRows ?? []);
  return t.rows.map((r, i) => (sections.has(i) ? (r.find((c) => c !== '') ?? '') : r.filter((c) => c !== '').join(' | '))).join('\n');
}

/** Tabela em Markdown (GFM). */
export function tableToMarkdown(t: TableData): string {
  if (t.rows.length === 0) return '';
  const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
  const layout = tableLayout(t);
  const line = (cells: string[]): string => `| ${cells.map(esc).join(' | ')} |`;
  const lines = [line(layout.names), `| ${layout.names.map(() => '---').join(' | ')} |`];
  for (const i of layout.dataRows) {
    const row = t.rows[i]!;
    if (layout.isSection(i)) lines.push(line([`**${row.find((c) => c !== '') ?? ''}**`, ...Array.from({ length: Math.max(0, t.numCols - 1) }, () => '')]));
    else lines.push(line(row));
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------------------------------------
 * Hierarquia
 * ---------------------------------------------------------------------------------------------- */

type StackEntry = {
  kind: 'section' | 'item' | 'alinea';
  level: number;
  itemNumber?: string;
  /** Numeração pontuada que delimita o escopo (própria ou herdada do pai). */
  scope?: string;
  /** ANEXO: só outro anexo o retira da pilha. */
  isPart: boolean;
  heading: string;
};

type Classified = {
  kind: Block['kind'];
  level: number;
  itemNumber?: string;
  isPart: boolean;
  /** Subtítulo sem numeração entre itens da mesma seção (via lookahead). */
  subheadingOf?: StackEntry;
};

/** Cabeçalho "de verdade" (curto e majoritariamente em caixa alta) — distingue "3. CRITÉRIOS" de "3 ICTs poderão…". */
function looksLikeHeading(rest: string): boolean {
  return rest.length <= 120 && upperRatio(rest) >= 0.6;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- núcleo do parser de layout (numeração, hierarquia, lookahead); coberto por fixtures
export function normalizeDocling(doc: DoclingDocumentJson, opts: NormalizeOptions): ParsedDocument {
  const sizes: PageSizes = {};
  for (const [k, p] of Object.entries(doc.pages ?? {})) sizes[k] = p.size;
  const pageNumbers = Object.values(doc.pages ?? {}).map((p) => p.page_no).sort((a, b) => a - b);
  const pageCount = pageNumbers.length;

  const counters = { furniture: 0 };
  let items = relocateTables(flatten(doc, sizes, counters));
  let removedHeaderFooterLines = counters.furniture;
  if (opts.removeHeaderFooter) {
    const r = dropRepeatedHeaderFooter(items, pageCount);
    items = r.items;
    removedHeaderFooterLines += r.removed;
  }

  // Pré-classificação (numeração) para permitir lookahead.
  const numbering = items.map((it) => (it.kind === 'text' ? detectNumbering(it.text) : null));
  const nextDottedNumber = (from: number): string | undefined => {
    for (let j = from; j < items.length; j++) {
      const n = numbering[j];
      if (n && n.kind !== 'alinea' && isDotted(n.itemNumber)) return n.itemNumber;
    }
    return undefined;
  };

  const stack: StackEntry[] = [];
  const blocks: Block[] = [];
  let title: string | undefined;

  const popFor = (c: Classified): void => {
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      let keep: boolean;
      if (c.kind === 'alinea') keep = top.kind !== 'alinea';
      else if (c.isPart) keep = false;
      else if (top.isPart) keep = true;
      else if (c.subheadingOf) keep = top === c.subheadingOf;
      else if (c.kind === 'section' && c.level === 1) keep = false;
      else if (top.kind === 'alinea') keep = false;
      else if (c.itemNumber && isDotted(c.itemNumber) && top.scope) keep = isDottedPrefix(top.scope, c.itemNumber);
      else keep = top.level < c.level;
      if (keep) break;
      stack.pop();
    }
  };

  // eslint-disable-next-line sonarjs/cognitive-complexity -- classificação de bloco por rótulo do Docling + numeração + contexto; coberta por fixtures
  const classify = (i: number, it: FlatText): Classified => {
    const label = it.item.label;
    const m = numbering[i];
    if (label === 'footnote') return { kind: 'footnote', level: stack[stack.length - 1]?.level ?? 0, isPart: false };
    if (label === 'title') return { kind: 'title', level: 0, isPart: false };

    if (label === 'section_header') {
      if (!m) {
        // Primeiro cabeçalho da página 1 em caixa alta → título do documento.
        if (blocks.length === 0 && it.bboxes[0]?.page === 1 && upperRatio(it.text) >= 0.6) return { kind: 'title', level: 0, isPart: false };
        // Subtítulo sem numeração dentro de uma seção numerada? (o próximo bloco numerado continua a seção corrente)
        // Só entradas NUMERADAS podem ser o pai: dois subtítulos seguidos ("1ª ETAPA", "2ª ETAPA") são irmãos, não aninhados.
        const next = nextDottedNumber(i + 1);
        if (next) {
          // 1º: entrada cujo escopo contém o próximo número ("12" ⊃ "12.2"); 2º: entrada cujo irmão seguinte é o próximo
          // número ("2. Grupo de Concorrência" › "Linha Temática 1 - …" › "3. Definição do Arranjo").
          const numbered = stack.filter((e) => e.kind !== 'alinea' && !!e.itemNumber && !!e.scope).reverse();
          const parent = numbered.find((e) => isDottedPrefix(e.scope!, next)) ?? numbered.find((e) => isNextSibling(e.scope!, next));
          if (parent) return { kind: 'section', level: parent.level + 1, isPart: false, subheadingOf: parent };
        }
        return { kind: 'section', level: 1, isPart: false };
      }
      if (m.kind === 'alinea') return { kind: 'section', level: 1, itemNumber: m.itemNumber, isPart: false };
      return { kind: 'section', level: m.level, itemNumber: m.itemNumber, isPart: m.itemNumber.startsWith('ANEXO ') };
    }

    if (!m) {
      // list_item sem numeração no texto mas com marcador numérico do Docling ("1.", "2.1.") → item.
      const marker = label === 'list_item' ? it.item.marker?.match(/^(\d{1,2}(?:\.\d{1,2})*)\.?$/)?.[1] : undefined;
      if (marker) return { kind: 'item', level: Math.max(2, 1 + (marker.match(/\./g)?.length ?? 0)), itemNumber: marker, isPart: false };
      return { kind: label === 'caption' ? 'caption' : 'paragraph', level: stack[stack.length - 1]?.level ?? 0, isPart: false };
    }
    if (m.kind === 'section') {
      if (m.itemNumber.startsWith('ANEXO ') || m.itemNumber.startsWith('CLÁUSULA ')) {
        return { kind: 'section', level: 1, itemNumber: m.itemNumber, isPart: m.itemNumber.startsWith('ANEXO ') };
      }
      if (/^\d{1,2}\./.test(it.text) && looksLikeHeading(m.rest)) return { kind: 'section', level: 1, itemNumber: m.itemNumber, isPart: false };
      if (/^\d{1,2}\./.test(it.text)) return { kind: 'item', level: 2, itemNumber: m.itemNumber, isPart: false };
      return { kind: 'paragraph', level: stack[stack.length - 1]?.level ?? 0, isPart: false };
    }
    if (m.kind === 'alinea') {
      const parent = [...stack].reverse().find((e) => e.kind !== 'alinea');
      return { kind: 'alinea', level: (parent?.level ?? 1) + 1, itemNumber: m.itemNumber, isPart: false };
    }
    return { kind: 'item', level: Math.max(2, m.level), itemNumber: m.itemNumber, isPart: false };
  };

  const context = (): { ancestors: string[]; sectionPath: string } => ({
    ancestors: stack.map((e) => e.itemNumber).filter((n): n is string => !!n),
    sectionPath: stack.map((e) => e.heading).join(' › '),
  });

  const pushBlock = (partial: Omit<Block, 'index'>): Block => {
    const block: Block = { index: blocks.length, ...partial };
    blocks.push(block);
    return block;
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const pages = it.bboxes.map((b) => b.page);
    const pageStart = pages.length ? Math.min(...pages) : (blocks[blocks.length - 1]?.pageEnd ?? 1);
    const pageEnd = pages.length ? Math.max(...pages) : pageStart;

    if (it.kind === 'table') {
      const table = tableData(it.item);
      if (table.rows.length === 0) continue;
      const prev = blocks[blocks.length - 1];
      const captions = (it.item.captions ?? [])
        .map((c) => normalizeText((resolveRef(doc, c.$ref) as DoclingTextItem | undefined)?.orig ?? ''))
        .filter(Boolean);
      if (captions.length) table.caption = captions.join(' ');
      else if (prev && prev.kind !== 'table' && prev.text.endsWith(':')) table.caption = prev.text;

      if (
        prev?.kind === 'table' && prev.table &&
        prev.table.numCols === table.numCols && table.headerRows.length === 0 &&
        pageStart === prev.pageEnd + 1
      ) {
        mergeTables(prev, table, pageEnd, it.bboxes);
        continue;
      }
      const ctx = context();
      pushBlock({
        kind: 'table', level: stack[stack.length - 1]?.level ?? 0, text: tableText(table), ...ctx,
        pageStart, pageEnd, bboxes: it.bboxes, table, sourceRef: it.ref,
      });
      continue;
    }

    const c = classify(i, it);
    let text = it.text.replace(BULLET_RE, '');
    if (it.item.label === 'list_item') text = text.replace(/^[-–—]\s+/u, '');
    if (!text) continue;

    if (c.kind === 'title') {
      title ??= text;
      pushBlock({ kind: 'title', level: 0, text, ancestors: [], sectionPath: '', pageStart, pageEnd, bboxes: it.bboxes, sourceRef: it.ref });
      continue;
    }

    if (c.kind === 'section' || c.kind === 'item' || c.kind === 'alinea') {
      popFor(c);
      const ctx = context();
      pushBlock({
        kind: c.kind, level: c.level, itemNumber: c.itemNumber, text, ...ctx, pageStart, pageEnd, bboxes: it.bboxes, sourceRef: it.ref,
      });
      const parent = stack[stack.length - 1];
      const ownScope = c.itemNumber && isDotted(c.itemNumber) ? c.itemNumber : undefined;
      stack.push({
        kind: c.kind, level: c.level, itemNumber: c.itemNumber, isPart: c.isPart, heading: truncate(text, 60),
        scope: ownScope ?? (c.kind === 'alinea' || c.subheadingOf ? parent?.scope : undefined),
      });
      continue;
    }

    // paragraph | caption | footnote: herdam o contexto corrente.
    pushBlock({ kind: c.kind, level: c.level, text, ...context(), pageStart, pageEnd, bboxes: it.bboxes, sourceRef: it.ref });
  }

  // Páginas: tamanho + caracteres atribuídos por prov (charspan quando existir).
  const charCount = new Map<number, number>();
  for (const b of blocks) {
    const provs = b.bboxes.length ? b.bboxes : [{ page: b.pageStart } as BBox];
    const share = Math.ceil(b.text.length / provs.length);
    for (const p of provs) charCount.set(p.page, (charCount.get(p.page) ?? 0) + share);
  }
  const pages: PageInfo[] = pageNumbers.map((n) => {
    const size = pageSize(sizes, n);
    return { page: n, width: size.width, height: size.height, charCount: charCount.get(n) ?? 0 };
  });

  return {
    title: title ?? opts.fallbackTitle,
    pages,
    blocks,
    stats: {
      sections: blocks.filter((b) => b.kind === 'section').length,
      items: blocks.filter((b) => b.kind === 'item').length,
      tables: blocks.filter((b) => b.kind === 'table').length,
      footnotes: blocks.filter((b) => b.kind === 'footnote').length,
      removedHeaderFooterLines,
    },
    parser: { name: 'docling', version: opts.parserVersion },
  };
}

/* ------------------------------------------------------------------------------------------------
 * canonical.md
 * ---------------------------------------------------------------------------------------------- */

/** "6.5.5" → "sec-6.5.5"; "ANEXO I" → "sec-anexo-i"; "§ 1" → "sec-par-1"; texto livre → slug truncado. */
export function sectionAnchor(block: Pick<Block, 'itemNumber' | 'text' | 'kind'>): string {
  const base = block.itemNumber ?? (block.kind === 'title' ? 'titulo' : truncate(block.text, 48).replace(/…$/, ''));
  const slug = base
    .replace(/§/g, 'par')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\.+$/g, '');
  return `sec-${slug || 'bloco'}`;
}

/** Âncora de título/seção/item, com sufixo "-2", "-3"… quando o slug se repete no documento. */
function uniqueAnchor(b: Block, used: Map<string, number>): string | undefined {
  if (b.kind !== 'title' && b.kind !== 'section' && b.kind !== 'item') return undefined;
  const base = sectionAnchor(b);
  const n = (used.get(base) ?? 0) + 1;
  used.set(base, n);
  return n > 1 ? `${base}-${n}` : base;
}

/** Linha(s) do bloco no canonical.md: cabeçalhos com âncora, tabela em Markdown, resto literal. */
function renderCanonicalBlock(b: Block, anchor: string | undefined): string {
  if (b.kind === 'title') return `# ${b.text} {#${anchor} p=${b.pageStart}}`;
  if (b.kind === 'section') return `${'#'.repeat(Math.min(6, b.level + 1))} ${b.text} {#${anchor} p=${b.pageStart}}`;
  if (b.kind === 'item') return `${b.text} {#${anchor} p=${b.pageStart}}`;
  if (b.kind === 'table' && b.table) return tableToMarkdown(b.table);
  return b.text;
}

/** Gera o canonical.md (cabeçalhos com âncoras, tabelas em Markdown) e a lista de seções. */
export function buildCanonical(parsed: ParsedDocument): CanonicalDocument {
  const parts: string[] = [];
  const blockOffsets: CanonicalDocument['blockOffsets'] = [];
  const anchored: Array<{ section: CanonicalSection; level: number }> = [];
  const used = new Map<string, number>();
  let pos = 0;

  for (const b of parsed.blocks) {
    const anchor = uniqueAnchor(b, used);
    const s = renderCanonicalBlock(b, anchor);

    if (parts.length) pos += 2; // "\n\n"
    const charStart = pos;
    parts.push(s);
    pos += s.length;
    blockOffsets.push({ blockIndex: b.index, charStart, charEnd: pos });
    if (anchor) {
      anchored.push({
        level: b.level,
        section: { anchor, itemNumber: b.itemNumber, heading: truncate(b.text, 120), page: b.pageStart, charStart, charEnd: pos },
      });
    }
  }
  const markdown = parts.join('\n\n') + (parts.length ? '\n' : '');

  // Fim de cada seção/item = início do próximo bloco ancorado de nível igual ou superior (sem o separador "\n\n").
  for (let i = 0; i < anchored.length; i++) {
    const cur = anchored[i]!;
    const next = anchored.slice(i + 1).find((a) => a.level <= cur.level);
    cur.section.charEnd = next ? Math.max(cur.section.charEnd, next.section.charStart - 2) : markdown.length;
  }

  return { markdown, sections: anchored.map((a) => a.section), blockOffsets };
}
