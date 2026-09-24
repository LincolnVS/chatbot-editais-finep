import type { AnswerBlock, EvalCase, GatePolicy, GroundingIssue } from '@editais/shared';
import { containsValue, splitBlocks, stripLabels } from '@editais/shared';

export type AnnotatedBlock = {
  text: string;
  kind: AnswerBlock['kind'];
  /** O bloco não está no texto entregue (gate strict removeu). */
  removed: boolean;
  /** Motivo do gate (removeu ou removeria): "sem referência" ou "valor X não consta dos trechos citados". */
  problem?: string;
  /** Motivo deduzido do texto (execução antiga, sem a lista de problemas gravada). */
  estimated?: boolean;
};

export type AnnotatedAnswer = {
  blocks: AnnotatedBlock[];
  /** O texto entregue difere do texto do modelo (o gate removeu algo). */
  changed: boolean;
};

function issueLabel(i: GroundingIssue): string {
  if (i.kind === 'uncited') return 'sem referência';
  const misplaced = new Set(i.misplaced ?? []);
  const absent = (i.values ?? []).filter((v) => !misplaced.has(v));
  const parts: string[] = [];
  if (misplaced.size > 0) parts.push(`valor ${[...misplaced].join(', ')} está em outro item do documento (citação no item errado)`);
  if (absent.length > 0) parts.push(`valor ${absent.join(', ')} não consta dos trechos citados`);
  return parts.join(' · ');
}

/** Texto do modelo em blocos, marcando o que o gate removeu (strict) ou removeria (warn), com o motivo. */
export function annotateAnswer(c: EvalCase, policy: GatePolicy): AnnotatedAnswer {
  const model = c.rawText ?? c.text;
  const changed = c.rawText !== undefined && c.rawText !== c.text;
  const issues = c.issues;
  const blocks = splitBlocks(model).map((b): AnnotatedBlock => {
    const plain = stripLabels(b.text).replace(/\s+/g, ' ').trim();
    const issue = issues?.find((i) => plain.startsWith(i.text.replace(/…$/, '')));
    const removed = changed && !c.text.includes(b.text.trim());
    if (issue) return { text: b.text, kind: b.kind, removed, problem: issueLabel(issue) };
    // execução antiga: sem a lista gravada, deduz — bloco factual sem rótulo é "sem referência"; removido com rótulo só pode ser valor sem respaldo
    if (!issues && policy !== 'off' && b.factual) {
      if (b.labels.length === 0) return { text: b.text, kind: b.kind, removed, problem: 'sem referência', estimated: true };
      if (removed) return { text: b.text, kind: b.kind, removed, problem: 'valor sem respaldo nos trechos citados', estimated: true };
    }
    return { text: b.text, kind: b.kind, removed };
  });
  return { blocks, changed };
}

export type ExpectedValueCheck = { value: string; delivered: boolean; inModel: boolean };

/** Cada valor esperado do padrão-ouro: está no texto entregue? estava no texto do modelo (e o gate tirou)? */
export function checkExpectedValues(c: EvalCase): ExpectedValueCheck[] {
  const model = c.rawText ?? c.text;
  return c.expectedValues.map((value) => ({ value, delivered: containsValue(c.text, value), inModel: containsValue(model, value) }));
}
