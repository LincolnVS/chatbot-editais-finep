/** ParsedDocument + CanonicalDocument → ChunkDraft[] (hierárquico ou fixo). */
import type { ParsedDocument, CanonicalDocument, ChunkDraft, ChunkingConfig, Block, BBox, ChunkKind } from '@editais/shared';
import { chunkLabel, sha256 } from '@editais/shared';
import { tableLayout, tableToMarkdown } from './normalize.ts';

export type ChunkInput = {
  parsed: ParsedDocument;
  canonical: CanonicalDocument;
  documentId: string;
  workspaceId: string;
  chunkSetId: string;
  config: ChunkingConfig;
};

/* ------------------------------------------------------------------------------------------------
 * Utilitários
 * ---------------------------------------------------------------------------------------------- */

const TITLE_MAX = 80;
const CAPTION_MAX = 120;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function contextPrefix(title: string, sectionPath: string): string {
  const t = truncate(title, TITLE_MAX);
  return sectionPath ? `[${t} › ${sectionPath}]` : `[${t}]`;
}

/** Texto do bloco como vai para o chunk: tabela em Markdown, demais o texto normalizado. */
function renderBlock(b: Block): string {
  if (b.kind === 'table' && b.table) return tableToMarkdown(b.table) || b.text;
  return b.text;
}

function leafKind(b: Block): ChunkKind {
  switch (b.kind) {
    case 'section': return 'section';
    case 'item': return 'item';
    case 'alinea': return 'alinea';
    case 'table': return 'table';
    case 'footnote': return 'footnote';
    default: return 'paragraph';
  }
}

const hasNumber = (b: Block): boolean => (b.kind === 'item' || b.kind === 'section') && !!b.itemNumber;

/**
 * Item a que a tabela pertence quando nenhum grupo dela se juntou à frase numerada que a introduz: o ancestral numerado
 * mais interno, se for item pontuado ("7.2.2"). Sem isso, tabela partida em grupos de linhas só tinha número no primeiro
 * grupo, e a linha que responde a pergunta ficava num chunk órfão, invisível para o bônus de identificador e a busca
 * por item. Tabela solta sob o título de uma seção ("15. CRONOGRAMA") fica sem número: a seção inteira não é o item dela.
 */
function tableItemNumber(table: Block): string | undefined {
  const n = table.ancestors.at(-1);
  return n && /^\d+(?:\.\d+)+$/.test(n) ? n : undefined;
}

/**
 * Número da folha: o da cabeça numerada. Em tabela partida, os grupos seguintes levam o número que o primeiro ganhou ao se
 * juntar à frase que a introduz (`numeroDaTabela` guarda isso na ordem de emissão); sem nenhum, o item que a contém.
 */
function leafItemNumber(p: Piece, table: Block | undefined, numeroDaTabela: Map<Block, string>): string | undefined {
  const proprio = hasNumber(p.head) ? p.head.itemNumber : undefined;
  if (!table) return proprio;
  if (proprio) {
    if (!numeroDaTabela.has(table)) numeroDaTabela.set(table, proprio);
    return proprio;
  }
  return numeroDaTabela.get(table) ?? tableItemNumber(table);
}

/** Abreviações pt-BR após as quais um ponto NÃO encerra sentença. */
const ABBREVIATIONS = new Set(['art', 'arts', 'inc', 'n', 'nº', 'no', 'num', 'sr', 'sra', 'dr', 'dra', 'prof', 'profa', 'ltda', 's.a', 'cia', 'obs', 'ex', 'etc', 'p', 'pp', 'pág', 'pag', 'fl', 'fls', 'cf', 'ref', 'tel', 'av', 'al', 'r']);

/** Offsets (fim de cada sentença) dentro de `text`. */
export function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  const re = /[.!?;:…]+["”’)\]]*(?=\s+)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    const after = text.slice(end).trimStart();
    if (!after) break;
    if (!/^[\p{Lu}\p{N}"“'([]/u.test(after)) continue;
    if (m[0].startsWith('.')) {
      const lastWord = (text.slice(0, m.index).match(/(\S+)$/)?.[1] ?? '').toLowerCase();
      const bare = lastWord.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[.º°]+$/u, '');
      if (ABBREVIATIONS.has(bare)) continue;
      if (/^\p{N}{1,2}(\.\p{N}{1,3})*$/u.test(bare)) continue; // "6." / "6.5.5." = numeração
      if (/^\p{L}$/u.test(bare)) continue; // inicial ("S.")
    }
    ends.push(end);
  }
  if (ends[ends.length - 1] !== text.length) ends.push(text.length);
  return ends;
}

/** Avança `pos` até depois do próximo espaço (para não começar no meio de uma palavra); nunca passa de `limit`. */
function snapForward(text: string, pos: number, limit: number): number {
  if (pos <= 0) return 0;
  if (pos >= limit) return limit;
  if (/\s/.test(text[pos - 1] ?? '')) return pos;
  const ws = text.slice(pos, limit).search(/\s/);
  if (ws < 0) return limit;
  return Math.min(limit, pos + ws + 1);
}

/** Fatia `text` em janelas de até `maxChars`, quebrando em fim de sentença ou palavra, com sobreposição. */
function windows(text: string, maxChars: number, overlap: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const len = text.length;
  const ends = [...new Set([...sentenceEnds(text), ...[...text.matchAll(/\n/g)].map((m) => m.index)])].sort((a, b) => a - b);
  const minCut = Math.floor(maxChars / 2);
  let start = 0;
  while (start < len) {
    const limit = Math.min(len, start + maxChars);
    const end = limit < len ? chooseCut(text, ends, start, limit, minCut) : limit;
    const { s, e } = trimWhitespace(text, start, end);
    if (e > s) out.push({ start: s, end: e });
    if (end >= len) break;
    // Próxima janela: primeiro início de sentença dentro da faixa de overlap (antes do fim já aparado); senão início de palavra.
    const candidate = Math.max(e - overlap, start + 1);
    const sentenceStart = ends.find((x) => x >= candidate && x < e);
    const next = sentenceStart ?? snapForward(text, candidate, e);
    start = next > start ? next : end;
  }
  return out;
}

/** Fim da janela: último fim de sentença/linha que deixe ≥ minCut chars; senão fim de palavra; senão corte seco em `limit`. */
function chooseCut(text: string, ends: number[], start: number, limit: number, minCut: number): number {
  let cut = -1;
  for (const e of ends) {
    if (e > limit) break;
    if (e - start >= minCut) cut = e;
  }
  if (cut < 0) {
    const ws = text.lastIndexOf(' ', limit);
    if (ws - start >= minCut) cut = ws + 1;
  }
  return cut > start ? cut : limit;
}

function trimWhitespace(text: string, start: number, end: number): { s: number; e: number } {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  return { s, e };
}

/* ------------------------------------------------------------------------------------------------
 * Tabelas
 * ---------------------------------------------------------------------------------------------- */

/** "<prefixo> — <col1>: <v1>; <col2>: <v2>" (células vazias omitidas). */
function rowSentence(prefix: string | undefined, names: string[], row: string[]): string {
  const pairs = row
    .map((v, c) => (v ? (names[c] ? `${names[c]}: ${v}` : v) : ''))
    .filter(Boolean)
    .join('; ');
  if (!pairs) return '';
  return prefix ? `${prefix} — ${pairs}` : pairs;
}

/* ------------------------------------------------------------------------------------------------
 * Estrutura comum
 * ---------------------------------------------------------------------------------------------- */

type Offsets = { charStart: number; charEnd: number };

/** Pedaço de texto pronto para virar chunk (um ou mais blocos inteiros, ou uma fatia de um bloco). */
type Piece = {
  blocks: Block[];
  text: string;
  charStart: number;
  charEnd: number;
  /** Bloco-cabeça da unidade (item/seção/alínea/parágrafo) de onde o pedaço saiu — dá o itemNumber. */
  head: Block;
  /** sectionPath do chunk (do primeiro bloco; prefixo comum após mesclas). */
  sectionPath: string;
  /** Fatia de sentença de um bloco grande (não se mescla com vizinhos). */
  slice: boolean;
  /** Linhas de dados da tabela contidas neste pedaço (índices 0.. a partir da primeira linha após o cabeçalho). */
  tableRows?: number[];
};

type ChunkFields = Omit<ChunkDraft, 'label' | 'documentId' | 'workspaceId' | 'chunkSetId' | 'orderIndex' | 'charCount' | 'contentHash'>;

type Emitter = { make: (fields: ChunkFields) => ChunkDraft };

/** Numera os chunks na ordem de emissão e deriva label/hash. Rótulos têm 24 bits: colisões no documento são re-derivadas. */
function createEmitter(input: ChunkInput): Emitter {
  let n = 0;
  const used = new Set<string>();
  const uniqueLabel = (orderIndex: number): string => {
    const seed = `${input.documentId}:${input.chunkSetId}:${orderIndex}`;
    let label = chunkLabel(seed);
    let k = 1;
    while (used.has(label)) label = chunkLabel(`${seed}#${k++}`);
    used.add(label);
    return label;
  };
  return {
    make: (f) => {
      const orderIndex = n++;
      return {
        label: uniqueLabel(orderIndex),
        documentId: input.documentId,
        workspaceId: input.workspaceId,
        chunkSetId: input.chunkSetId,
        orderIndex,
        charCount: f.text.length,
        contentHash: sha256(f.text),
        ...f,
      };
    },
  };
}

function pageSpan(blocks: Block[]): { pageStart: number; pageEnd: number; bboxes: BBox[] } {
  return {
    pageStart: Math.min(...blocks.map((b) => b.pageStart)),
    pageEnd: Math.max(...blocks.map((b) => b.pageEnd)),
    bboxes: blocks.flatMap((b) => b.bboxes),
  };
}

function offsetsByBlock(input: ChunkInput): (b: Block) => Offsets {
  const map = new Map(input.canonical.blockOffsets.map((o) => [o.blockIndex, o]));
  return (b) => {
    const o = map.get(b.index);
    if (!o) throw new Error(`canonical não corresponde ao parsed: bloco ${b.index} sem offsets`);
    return o;
  };
}

/** Offset do texto do bloco dentro da sua faixa no canonical (depois de "## ", por exemplo). */
function textOffset(markdown: string, o: Offsets, text: string): number {
  const i = markdown.slice(o.charStart, o.charEnd).indexOf(text);
  return i < 0 ? 0 : i;
}

/* ------------------------------------------------------------------------------------------------
 * Estratégia hier
 * ---------------------------------------------------------------------------------------------- */

type Unit = { head: Block; blocks: Block[] };

/** Agrupa os blocos de uma seção de nível 1 em unidades: cabeça (item/subseção/tabela/…) + filhos imediatos. */
function buildUnits(blocks: Block[]): Unit[] {
  const units: Unit[] = [];
  let cur: Unit | undefined;
  for (const b of blocks) {
    const headKind = cur?.head.kind;
    let child = false;
    if (b.kind === 'alinea') child = headKind === 'item' || headKind === 'section';
    else if (b.kind === 'paragraph' || b.kind === 'footnote' || b.kind === 'caption' || b.kind === 'other') child = !!cur && headKind !== 'table';
    if (child && cur) {
      cur.blocks.push(b);
      continue;
    }
    cur = { head: b, blocks: [b] };
    units.push(cur);
  }
  return units;
}

/** Cláusula-mãe repetida nos pedaços seguintes de uma unidade fatiada: no máximo 200 chars (ou ¼ de maxChars). */
const HEAD_REPEAT_MAX = 200;

/** Empacota blocos inteiros em pedaços ≤ maxChars; bloco maior que maxChars vira fatias por sentença. */
function splitUnit(unit: Unit, cfg: ChunkingConfig, offsets: (b: Block) => Offsets, markdown: string): Piece[] {
  const pieces: Piece[] = [];
  let acc: Block[] = [];
  let accLen = 0;
  const head = unit.head;
  const headRepeat = hasNumber(head) && head.kind !== 'table' ? truncate(head.text, Math.min(HEAD_REPEAT_MAX, Math.floor(cfg.maxChars / 4))) : '';
  const reserve = headRepeat ? headRepeat.length + 1 : 0;
  /** Orçamento do pedaço corrente: os pedaços seguintes ao primeiro reservam espaço para a cabeça repetida. */
  const budget = (): number => (pieces.length === 0 ? cfg.maxChars : cfg.maxChars - reserve);
  const flush = (): void => {
    if (acc.length === 0) return;
    pieces.push({
      blocks: acc,
      text: acc.map(renderBlock).join('\n'),
      charStart: offsets(acc[0]!).charStart,
      charEnd: offsets(acc[acc.length - 1]!).charEnd,
      head: unit.head,
      sectionPath: acc[0]!.sectionPath,
      slice: false,
    });
    acc = [];
    accLen = 0;
  };

  for (const b of unit.blocks) {
    if (b.kind === 'table') {
      flush();
      pieces.push(...splitTable(b, cfg, offsets(b), unit.head));
      continue;
    }
    const text = renderBlock(b);
    if (text.length > cfg.maxChars) {
      flush();
      const o = offsets(b);
      const base = o.charStart + textOffset(markdown, o, text);
      for (const w of windows(text, cfg.maxChars, Math.min(cfg.overlapChars, cfg.maxChars - 1))) {
        pieces.push({ blocks: [b], text: text.slice(w.start, w.end), charStart: base + w.start, charEnd: base + w.end, head: unit.head, sectionPath: b.sectionPath, slice: true });
      }
      continue;
    }
    if (acc.length && accLen + 1 + text.length > budget()) flush();
    acc.push(b);
    accLen += (acc.length > 1 ? 1 : 0) + text.length;
  }
  flush();
  if (headRepeat) prependHead(pieces, head, headRepeat, offsets(head).charStart);
  return pieces;
}

/** Repete a cláusula-mãe no início dos pedaços que não a contêm (fatias e linhas de tabela ficam como estão). */
function prependHead(pieces: Piece[], head: Block, headRepeat: string, headStart: number): void {
  for (const p of pieces) {
    if (p.slice || p.tableRows || p.blocks[0] === head) continue;
    p.text = `${headRepeat}\n${p.text}`;
    p.blocks = [head, ...p.blocks];
    p.charStart = headStart;
  }
}

/** Tabela inteira (≤ maxChars) ou grupos de linhas com o cabeçalho repetido (cada grupo ≈ maxChars). */
function splitTable(b: Block, cfg: ChunkingConfig, o: Offsets, head: Block): Piece[] {
  const md = renderBlock(b);
  const t = b.table;
  const base = { blocks: [b], head, sectionPath: b.sectionPath, slice: false };
  if (!t || t.rows.length === 0) return [{ ...base, text: md, charStart: o.charStart, charEnd: o.charEnd }];
  const lines = md.split('\n');
  const lineEnds: number[] = [];
  let pos = 0;
  for (const l of lines) {
    pos += l.length;
    lineEnds.push(pos);
    pos += 1;
  }
  // índices 0.. das linhas de dados (na ordem do Markdown: linha 2 + i)
  const dataRows = tableLayout(t).dataRows.map((_, i) => i);
  const rowLine = (i: number): number => 2 + i;
  if (md.length <= cfg.maxChars || dataRows.length <= 1) {
    return [{ ...base, text: md, charStart: o.charStart, charEnd: o.charEnd, tableRows: dataRows }];
  }
  const piece = (rows: number[]): Piece => ({
    ...base,
    text: [lines[0]!, lines[1]!, ...rows.map((i) => lines[rowLine(i)]!)].join('\n'),
    charStart: o.charStart,
    charEnd: o.charStart + (lineEnds[rowLine(rows[rows.length - 1]!)] ?? md.length),
    tableRows: rows,
  });
  const headerLen = lines[0]!.length + 1 + lines[1]!.length;
  const pieces: Piece[] = [];
  let group: number[] = [];
  let size = headerLen;
  for (const i of dataRows) {
    const l = (lines[rowLine(i)]?.length ?? 0) + 1;
    if (group.length && size + l > cfg.maxChars) {
      pieces.push(piece(group));
      group = [];
      size = headerLen;
    }
    group.push(i);
    size += l;
  }
  if (group.length) pieces.push(piece(group));
  return pieces;
}

const isAncestorPath = (a: string, b: string): boolean => a !== '' && b.startsWith(`${a} › `);

/** Pais até maxChars × 1,25 (1600 → 2000 chars ≈ 512 tokens do e5 em pt-BR) são embedados inteiros. */
export const PARENT_EMBED_FACTOR = 1.25;

const LEAD_IN_MAX = 200;

/** Cláusula-mãe curta ("6.6.3. Obras e instalações") imediatamente seguida por um filho direto seu. */
function isLeadIn(prev: Piece, next: Piece): boolean {
  const head = prev.blocks[0]!;
  const child = next.blocks[0]!;
  return prev.blocks.length === 1 && !prev.slice && prev.text.length <= LEAD_IN_MAX && hasNumber(head) &&
    child.ancestors[child.ancestors.length - 1] === head.itemNumber;
}

/** Junta pedaços consecutivos num só; sectionPath = prefixo comum (o mais curto entre os relacionados). */
function joinPieces(ps: Piece[]): Piece {
  const first = ps[0]!;
  if (ps.length === 1) return first;
  let sectionPath = first.sectionPath;
  for (const p of ps) if (isAncestorPath(p.sectionPath, sectionPath)) sectionPath = p.sectionPath;
  return {
    ...first,
    blocks: ps.flatMap((p) => p.blocks),
    text: ps.map((p) => p.text).join('\n'),
    charEnd: ps[ps.length - 1]!.charEnd,
    sectionPath,
    tableRows: ps.find((p) => p.tableRows)?.tableRows,
  };
}

const textLength = (ps: Piece[]): number => ps.reduce((n, p) => n + p.text.length, 0) + ps.length - 1;

/** Mescla pedaços vizinhos (legenda + tabela, itens curtos órfãos). */
function mergePieces(pieces: Piece[], cfg: ChunkingConfig): Piece[] {
  const out: Piece[] = [];
  let group: Piece[] = [];
  let groupPath = '';
  const start = (ps: Piece[]): void => {
    group = ps;
    groupPath = joinPieces(ps).sectionPath;
  };
  /** Primeiro pedaço de uma tabela (inteira ou o grupo com o cabeçalho): é a ele que a legenda se junta. */
  const isTableStart = (x: Piece): boolean => x.blocks[0]!.kind === 'table' && (x.tableRows === undefined || x.tableRows[0] === 0);
  const isCaptionOf = (x: Piece, table: Piece): boolean => !x.slice && x.blocks.length === 1 && x.text === table.blocks[0]!.table?.caption;
  // eslint-disable-next-line sonarjs/cognitive-complexity -- regras de mescla encadeadas (legenda+tabela, item curto, pai+filhos); cobertas por fixtures
  pieces.forEach((p, i) => {
    const first = p.blocks[0]!;
    const next = pieces[i + 1];
    if (group.length === 0) {
      start([p]);
      return;
    }
    const last = group[group.length - 1]!;
    const hasTable = group.some((g) => g.blocks.some((b) => b.kind === 'table'));

    // Legenda + tabela: a legenda abre grupo próprio (lookahead) e a tabela entra em seguida.
    if (next && isTableStart(next) && isCaptionOf(p, next) && !hasTable) {
      out.push(joinPieces(group));
      start([p]);
      return;
    }
    if (isTableStart(p) && group.length === 1 && isCaptionOf(last, p) && textLength([...group, p]) <= cfg.maxChars * 2) {
      group.push(p);
      return;
    }
    // Item curto logo após a tabela, no mesmo caminho ("15.1. A presente Seleção Pública tem validade de 24 meses.").
    if (cfg.mergePeers && hasTable && last.blocks.some((b) => b.kind === 'table') && !p.slice && !p.tableRows && first.kind !== 'table' &&
        first.kind !== 'section' && p.text.length <= LEAD_IN_MAX && (p.sectionPath === groupPath || isAncestorPath(groupPath, p.sectionPath)) &&
        textLength([...group, p]) <= cfg.maxChars * 2) {
      group.push(p);
      return;
    }

    const mergeable = cfg.mergePeers && !last.slice && !p.slice && !hasTable && !p.tableRows && first.kind !== 'section' && first.kind !== 'table';
    // Subir para o nível do pai só quando o pedaço não abre um novo sub-bloco (cláusula-mãe seguida dos filhos).
    const upward = isAncestorPath(p.sectionPath, groupPath) && !(next && isLeadIn(p, next));
    const related = p.sectionPath === groupPath || isAncestorPath(groupPath, p.sectionPath) || upward;
    if (mergeable && related) {
      if (textLength([...group, p]) <= cfg.maxChars) {
        group.push(p);
        if (upward) groupPath = p.sectionPath;
        return;
      }
      if (group.length > 1 && isLeadIn(last, p) && textLength([last, p]) <= cfg.maxChars) {
        out.push(joinPieces(group.slice(0, -1)));
        start([last, p]);
        return;
      }
    }
    out.push(joinPieces(group));
    start([p]);
  });
  if (group.length) out.push(joinPieces(group));
  return out;
}

/** Seção de nível 1 (pai) com os blocos que ficam sob ela; `heading` undefined = preâmbulo sem pai. */
type Section = { heading?: Block; blocks: Block[] };

function splitSections(parsed: ParsedDocument): Section[] {
  const sections: Section[] = [];
  let cur: Section = { blocks: [] };
  for (const b of parsed.blocks) {
    if (b.kind === 'title') continue;
    if (b.kind === 'section' && b.level <= 1) {
      if (cur.heading || cur.blocks.length) sections.push(cur);
      cur = { heading: b, blocks: [] };
      continue;
    }
    cur.blocks.push(b);
  }
  if (cur.heading || cur.blocks.length) sections.push(cur);
  return sections;
}

function chunkHier(input: ChunkInput): ChunkDraft[] {
  const { parsed, canonical, config } = input;
  const offsets = offsetsByBlock(input);
  const emit = createEmitter(input);
  const chunks: ChunkDraft[] = [];

  for (const section of splitSections(parsed)) {
    const heading = section.heading;
    const pieces = mergePieces(
      buildUnits(section.blocks).flatMap((u) => splitUnit(u, config, offsets, canonical.markdown)),
      config,
    );
    let parentLabel: string | undefined;
    if (heading) {
      const all = [heading, ...section.blocks];
      const text = all.map(renderBlock).join('\n');
      const parent = emit.make({
        kind: 'section',
        level: heading.level,
        itemNumber: heading.itemNumber,
        sectionPath: heading.sectionPath,
        heading: heading.text,
        text,
        contextPrefix: contextPrefix(parsed.title, heading.sectionPath),
        ...pageSpan(all),
        charStart: offsets(heading).charStart,
        charEnd: offsets(all[all.length - 1]!).charEnd,
        // Pai maior que o limite do modelo (≈ 512 tokens) ou quase idêntico à sua única folha só serve à expansão/BM25.
        embed: text.length <= config.maxChars * PARENT_EMBED_FACTOR && pieces.length !== 1,
      });
      chunks.push(parent);
      parentLabel = parent.label;
    }

    const numeroDaTabela = new Map<Block, string>();
    for (const p of pieces) {
      const first = p.blocks[0]!;
      const table = p.blocks.find((b) => b.kind === 'table');
      const chunk = emit.make({
        parentLabel,
        kind: table ? 'table' : leafKind(first),
        level: first.level,
        itemNumber: leafItemNumber(p, table, numeroDaTabela),
        sectionPath: p.sectionPath,
        heading: table?.table?.caption ?? heading?.text,
        text: p.text,
        contextPrefix: contextPrefix(parsed.title, p.sectionPath),
        ...pageSpan(p.blocks),
        charStart: p.charStart,
        charEnd: p.charEnd,
        embed: true,
      });
      chunks.push(chunk);

      if (table?.table && config.tableMode === 'markdown+rows' && p.tableRows?.length) {
        chunks.push(...tableRowChunks(table, p, chunk, offsets(table), emit, parsed.title));
      }
    }
  }
  return chunks;
}

/** Um chunk `table_row` por linha de dados do pedaço, apontando para o chunk da tabela (divisórias de grupo só prefixam). */
function tableRowChunks(b: Block, p: Piece, tableChunk: ChunkDraft, o: Offsets, emit: Emitter, title: string): ChunkDraft[] {
  const t = b.table!;
  const layout = tableLayout(t);
  // Legenda da tabela; sem legenda, o cabeçalho da seção (heading do chunk da tabela).
  const caption = tableChunk.heading ? truncate(tableChunk.heading, CAPTION_MAX) : undefined;
  const lines = renderBlock(b).split('\n');
  const lineStarts: number[] = [];
  let pos = 0;
  for (const l of lines) {
    lineStarts.push(pos);
    pos += l.length + 1;
  }
  const out: ChunkDraft[] = [];
  for (const i of p.tableRows ?? []) {
    const rowIndex = layout.dataRows[i];
    const row = rowIndex === undefined ? undefined : t.rows[rowIndex];
    if (!row || rowIndex === undefined || layout.isSection(rowIndex)) continue;
    const section = layout.sectionTitle(rowIndex);
    const prefix = [caption, section].filter(Boolean).join(' › ') || undefined;
    const text = rowSentence(prefix, layout.names, row);
    if (!text) continue;
    const line = 2 + i;
    const start = o.charStart + (lineStarts[line] ?? 0);
    out.push(emit.make({
      parentLabel: tableChunk.label,
      kind: 'table_row',
      level: b.level + 1,
      sectionPath: b.sectionPath,
      heading: tableChunk.heading,
      text,
      contextPrefix: contextPrefix(title, b.sectionPath),
      pageStart: b.pageStart,
      pageEnd: b.pageEnd,
      bboxes: b.bboxes,
      charStart: start,
      charEnd: start + (lines[line]?.length ?? 0),
      embed: true,
    }));
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Estratégia fixed
 * ---------------------------------------------------------------------------------------------- */

type Segment = { block: Block; plainStart: number; plainEnd: number; canonStart: number; heading?: string };

function chunkFixed(input: ChunkInput): ChunkDraft[] {
  const { parsed, canonical, config } = input;
  const offsets = offsetsByBlock(input);
  const emit = createEmitter(input);

  // Texto linear (sem âncoras) + mapa de volta para o canonical.
  const segments: Segment[] = [];
  const parts: string[] = [];
  let pos = 0;
  let heading: string | undefined;
  for (const b of parsed.blocks) {
    const text = renderBlock(b);
    if (!text) continue;
    if (b.kind === 'section' && b.level <= 1) heading = b.text;
    if (parts.length) pos += 2;
    const o = offsets(b);
    segments.push({ block: b, plainStart: pos, plainEnd: pos + text.length, canonStart: o.charStart + textOffset(canonical.markdown, o, text), heading });
    parts.push(text);
    pos += text.length;
  }
  const plain = parts.join('\n\n');
  if (!plain) return [];

  const segmentAt = (p: number): Segment => {
    let idx = 0;
    for (let i = 0; i < segments.length && segments[i]!.plainStart <= p; i++) idx = i;
    const s = segments[idx]!;
    // Posição dentro do separador "\n\n" → pertence ao próximo segmento.
    return p > s.plainEnd && segments[idx + 1] ? segments[idx + 1]! : s;
  };
  const toCanon = (p: number): number => {
    const s = segmentAt(p);
    return s.canonStart + Math.min(Math.max(0, p - s.plainStart), s.plainEnd - s.plainStart);
  };

  const chunks: ChunkDraft[] = [];
  for (const w of windows(plain, config.maxChars, Math.min(config.overlapChars, config.maxChars - 1))) {
    const startSeg = segmentAt(w.start);
    const endSeg = segmentAt(w.end - 1);
    const covered = segments.slice(segments.indexOf(startSeg), segments.indexOf(endSeg) + 1).map((s) => s.block);
    const b = startSeg.block;
    chunks.push(emit.make({
      kind: 'fixed',
      level: b.level,
      itemNumber: hasNumber(b) ? b.itemNumber : undefined,
      sectionPath: b.sectionPath,
      heading: startSeg.heading,
      text: plain.slice(w.start, w.end),
      contextPrefix: contextPrefix(parsed.title, b.sectionPath),
      ...pageSpan(covered),
      charStart: toCanon(w.start),
      charEnd: toCanon(w.end),
      embed: true,
    }));
  }
  return chunks;
}

/* ------------------------------------------------------------------------------------------------
 * Entrada
 * ---------------------------------------------------------------------------------------------- */

export function chunkDocument(input: ChunkInput): ChunkDraft[] {
  if (input.parsed.blocks.length === 0) return [];
  return input.config.strategy === 'fixed' ? chunkFixed(input) : chunkHier(input);
}
