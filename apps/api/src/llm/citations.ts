/** Validação de citações portáteis (funciona com qualquer provedor). */
import type { Citation, StoredChunk, CanonicalSection } from '@editais/shared';
import { LABEL_RE, SECTION_RE, normalizeLabels, tokenize } from '@editais/shared';

export type CitationValidation = {
  text: string;               // texto com rótulos inválidos removidos (rótulos válidos mantidos como [c_xxxxxx])
  textWithOrdinals: string;   // texto para exibição com [1], [2]…
  citations: Citation[];
  invalidLabels: string[];
  hasAnyCitation: boolean;
};

export { LABEL_RE, SECTION_RE, normalizeLabels };

/** Tamanho máximo do `quote` de uma citação. */
export const MAX_QUOTE_CHARS = 400;

/** Rótulos `[c_xxxxxx]` presentes no texto, únicos, na ordem de primeira aparição. */
export function extractLabels(text: string): string[] {
  return uniqueInOrder(matchAll(normalizeLabels(text), LABEL_RE));
}

/** Âncoras `[sec-…]` presentes no texto, únicas, na ordem de primeira aparição (baseline). */
export function extractSectionAnchors(text: string): string[] {
  return uniqueInOrder(matchAll(normalizeLabels(text), SECTION_RE));
}

export function validateCitations(text: string, context: StoredChunk[]): CitationValidation {
  const byLabel = new Map<string, StoredChunk>();
  for (const chunk of context) if (!byLabel.has(chunk.label)) byLabel.set(chunk.label, chunk);

  return validateGeneric(text, LABEL_RE, (label, claim) => {
    const chunk = byLabel.get(label);
    if (!chunk) return null;
    return {
      label,
      chunkRowid: chunk.rowid,
      documentId: chunk.documentId,
      documentTitle: chunk.documentTitle,
      docType: chunk.docType,
      ...(chunk.versionLabel !== undefined ? { versionLabel: chunk.versionLabel } : {}),
      page: chunk.pageStart,
      bboxes: chunk.bboxes,
      sectionPath: chunk.sectionPath,
      ...(chunk.itemNumber !== undefined ? { itemNumber: chunk.itemNumber } : {}),
      quote: bestQuote(chunk.text, claim),
      hasSection: !!(chunk.itemNumber || chunk.sectionPath),
    };
  });
}

export type SectionWithDocument = CanonicalSection & {
  documentId: string;
  documentTitle: string;
  docType: 'edital' | 'apoio';
  /** Markdown do documento inteiro (fatiado por charStart/charEnd) ou só o trecho da seção. */
  markdown: string;
};

export function validateSectionCitations(text: string, sections: SectionWithDocument[]): CitationValidation {
  const byAnchor = new Map<string, SectionWithDocument>();
  for (const section of sections) if (!byAnchor.has(section.anchor)) byAnchor.set(section.anchor, section);

  return validateGeneric(text, SECTION_RE, (anchor, claim) => {
    const section = byAnchor.get(anchor);
    if (!section) return null;
    return {
      label: anchor,
      // Âncoras de seção não apontam para um chunk indexado; 0 sinaliza "sem chunk".
      chunkRowid: 0,
      documentId: section.documentId,
      documentTitle: section.documentTitle,
      docType: section.docType,
      page: section.page,
      bboxes: [],
      sectionPath: section.heading,
      ...(section.itemNumber !== undefined ? { itemNumber: section.itemNumber } : {}),
      quote: bestQuote(sectionText(section), claim, /* skipHeading */ true),
      hasSection: true,
    };
  });
}

/** Percorre os rótulos na ordem, resolve cada um e atribui ordinais por primeira aparição. */
function validateGeneric(
  rawText: string,
  re: RegExp,
  resolve: (label: string, claim: string) => Omit<Citation, 'ordinal' | 'exists'> | null,
): CitationValidation {
  const text = normalizeLabels(rawText);
  const pattern = new RegExp(re.source, 'g');
  const citations: Citation[] = [];
  const ordinalByLabel = new Map<string, number>();
  const invalid = new Set<string>();

  let prevEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const label = match[1] as string;
    const claim = claimBefore(text, prevEnd, match.index, pattern);
    prevEnd = match.index + match[0].length;

    if (ordinalByLabel.has(label) || invalid.has(label)) continue;
    const resolved = resolve(label, claim);
    if (!resolved) {
      invalid.add(label);
      continue;
    }
    const ordinal = citations.length + 1;
    ordinalByLabel.set(label, ordinal);
    citations.push({ ordinal, ...resolved, exists: true });
  }

  // Remove rótulos inválidos (e o espaço que os precede); mantém os válidos.
  const cleanRe = new RegExp(`[ \\t]*${re.source}`, 'g');
  const cleaned = text.replace(cleanRe, (whole, label: string) => (ordinalByLabel.has(label) ? whole : ''));
  const withOrdinals = cleaned.replace(new RegExp(re.source, 'g'), (whole, label: string) => {
    const ordinal = ordinalByLabel.get(label);
    return ordinal === undefined ? whole : `[${ordinal}]`;
  });

  return {
    text: cleaned,
    textWithOrdinals: withOrdinals,
    citations,
    invalidLabels: [...invalid],
    hasAnyCitation: citations.length > 0,
  };
}

/** Afirmação que precede um rótulo: texto entre o rótulo anterior (ou o início do parágrafo) e o rótulo atual. */
function claimBefore(text: string, prevEnd: number, labelStart: number, labelRe: RegExp): string {
  const paragraphStart = text.lastIndexOf('\n', labelStart - 1) + 1;
  const from = Math.max(prevEnd, paragraphStart);
  const stripLabels = (s: string) => s.replace(new RegExp(labelRe.source, 'g'), ' ');
  let claim = stripLabels(text.slice(from, labelStart)).trim();
  if (tokenize(claim).length < 2) claim = stripLabels(text.slice(paragraphStart, labelStart)).trim();
  return claim;
}

/** Sentença de `source` com maior sobreposição de tokens com `claim`; fallback = primeira sentença; ≤ 400 chars. */
function bestQuote(source: string, claim: string, skipHeading = false): string {
  const sentences = splitSentences(source);
  if (sentences.length === 0) return truncate(source.trim());
  const claimTokens = new Set(tokenize(claim));
  let best = -1;
  let bestScore = 0;
  sentences.forEach((sentence, i) => {
    if (claimTokens.size === 0) return;
    const tokens = new Set(tokenize(sentence));
    let score = 0;
    for (const t of claimTokens) if (tokens.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  if (best < 0) best = skipHeading && sentences.length > 1 ? 1 : 0;
  return truncate(sentences[best] as string);
}

function truncate(s: string): string {
  return s.length <= MAX_QUOTE_CHARS ? s : `${s.slice(0, MAX_QUOTE_CHARS - 1).trimEnd()}…`;
}

/** Texto da seção sem a âncora `{#sec-… p=N}` e sem as marcas `#` do cabeçalho. */
export function sectionText(section: SectionWithDocument): string {
  const md = section.markdown;
  const slice = md.length >= section.charEnd && section.charEnd > section.charStart ? md.slice(section.charStart, section.charEnd) : md;
  return slice.replace(/\s*\{#sec-[^}]*\}/g, '').replace(/^#{1,6}\s+/gm, '');
}

/* ---------- sentenças ---------- */

const ABBREVIATIONS = new Set(
  `art arts inc incs al alin n nº no obs ex fl fls p pp pag pags pág págs cf vol ed cap par dr dra sr sra srs prof profa
   ltda cia etc ref tel min max aprox cnpj cpf dec res proc doc docs s a sa eng adm av`
    .split(/\s+/)
    .filter(Boolean),
);

/** Divide um texto em sentenças (pt-BR; preserva abreviações comuns como "art.", "n.º", "R$ 1.000,00"). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n+/)) {
    const trimmed = line.trim();
    if (trimmed) out.push(...splitLine(trimmed));
  }
  return out;
}

function splitLine(line: string): string[] {
  const out: string[] = [];
  const terminator = /[.!?…]+["”’)\]]*(?=\s+)/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = terminator.exec(line)) !== null) {
    const end = m.index + m[0].length;
    const after = line.slice(end).trimStart();
    if (!after) break;
    if (!startsSentence(after) || (m[0].startsWith('.') && isAbbreviationBefore(line.slice(start, m.index)))) continue;
    out.push(line.slice(start, end).trim());
    start = end;
  }
  const rest = line.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/** A próxima sentença começa com maiúscula, dígito, aspas ou parêntese; senão é abreviação/continuação. */
function startsSentence(after: string): boolean {
  return /^[\p{Lu}\p{N}"“'([]/u.test(after);
}

/** O ponto fecha uma abreviação ("art.", "n.º", "s.a."), uma numeração ("6." / "6.5.5.") ou uma inicial ("S.")? */
function isAbbreviationBefore(before: string): boolean {
  const lastWord = (/(\S+)$/.exec(before)?.[1] ?? '').toLowerCase();
  const bare = lastWord.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[.º°]+$/u, '');
  if (ABBREVIATIONS.has(bare) || ABBREVIATIONS.has(bare.replace(/\./g, ''))) return true;
  if (/^\p{N}{1,2}(\.\p{N}{1,3})*$/u.test(bare)) return true;
  return /^\p{L}$/u.test(bare);
}

/* ---------- utilitários ---------- */

function matchAll(text: string, re: RegExp): string[] {
  const pattern = new RegExp(re.source, 'g');
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) found.push(m[1] as string);
  return found;
}

function uniqueInOrder(items: string[]): string[] {
  return [...new Set(items)];
}
