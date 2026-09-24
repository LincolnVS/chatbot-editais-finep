/** Padrão-ouro em CSV: id, workspace (id/código/nome do edital), question, expected_item, expected_values (separados por "|"), answerable (sim/não), topic, nivel (direta/composta), expected_answer. */
import type { EvalQuestion } from '@editais/shared';

const REQUIRED = ['id', 'question'] as const;
const FALSY = new Set(['nao', 'não', 'no', 'false', '0', 'n']);
/** Marca de ordem de bytes que o Excel grava no início de CSVs UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** Divide CSV com aspas duplas (RFC 4180): campos com vírgula/quebra de linha entre aspas, `""` = aspas literal. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const COLUMNS = ['id', 'workspace', 'topic', 'nivel', 'question', 'expected_item', 'expected_document', 'expected_values', 'expected_answer', 'answerable'] as const;

/** Serializa o padrão-ouro de volta para CSV (aspas só quando necessário) — usado pela tela Dataset. */
export function toCsv(questions: EvalQuestion[]): string {
  const cell = (v: string): string => (/["\n\r,]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const line = (q: EvalQuestion): string =>
    [q.id, q.workspace ?? '', q.topic ?? '', q.nivel ?? '', q.question, q.expectedItem ?? '', q.expectedDocument ?? '', q.expectedValues.join('|'), q.expectedAnswer ?? '', q.answerable ? 'sim' : 'nao']
      .map(cell)
      .join(',');
  return [COLUMNS.join(','), ...questions.map(line)].join('\n') + '\n';
}

export function parseQuestions(text: string): EvalQuestion[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error('CSV de perguntas vazio');
  const cols = header.map((h) => h.trim().toLowerCase());
  for (const name of REQUIRED) if (!cols.includes(name)) throw new Error(`CSV de perguntas sem a coluna obrigatória "${name}"`);
  const seen = new Set<string>();
  return rows.map((r, i) => {
    const get = (name: string): string => (r[cols.indexOf(name)] ?? '').trim();
    const id = get('id');
    const question = get('question');
    if (!id || !question) throw new Error(`linha ${i + 2}: id e question são obrigatórios`);
    if (seen.has(id)) throw new Error(`linha ${i + 2}: id repetido "${id}"`);
    seen.add(id);
    const answerableRaw = get('answerable').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    const q: EvalQuestion = {
      id,
      question,
      expectedValues: get('expected_values').split('|').map((v) => v.trim()).filter(Boolean),
      answerable: !FALSY.has(answerableRaw),
    };
    const workspace = get('workspace');
    if (workspace) q.workspace = workspace;
    const expectedItem = get('expected_item');
    if (expectedItem) q.expectedItem = expectedItem;
    const expectedDocument = get('expected_document');
    if (expectedDocument) q.expectedDocument = expectedDocument;
    const topic = get('topic');
    if (topic) q.topic = topic;
    const nivel = get('nivel').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    if (nivel === 'direta' || nivel === 'composta') q.nivel = nivel;
    const expectedAnswer = get('expected_answer');
    if (expectedAnswer) q.expectedAnswer = expectedAnswer;
    return q;
  });
}
