import type { EvalArmId, EvalArmSummary, EvalCase, GatePolicy } from '@editais/shared';
import { EVAL_ARMS } from '@editais/shared';

export function armShort(arm: EvalArmId): string {
  return EVAL_ARMS[arm].short;
}

export type MetricDef = {
  key: keyof EvalArmSummary;
  label: string;
  hint: string;
  kind: 'rate' | 'ms' | 'count';
  /** Sentido da métrica: true = maior é melhor (↑), false = menor é melhor (↓), null = neutro. */
  good: boolean | null;
  /** Diagnóstico interno do RAG (útil para ajustar a arquitetura, ruído na apresentação): fica oculto por padrão. */
  interna?: true;
  /** Casos por trás do número (ao clicar na métrica): o que listar e como chamar a lista (pode depender da política do gate no braço). */
  detail?: { label: string | ((policy: GatePolicy) => string); pick: (c: EvalCase, policy: GatePolicy) => boolean };
  /** Valor exibido na célula conforme a política do gate no braço (o agregado é o mesmo; muda o que chegou ao usuário). */
  shown?: (value: number | null, policy: GatePolicy) => number | null;
  /** Observação ao lado do valor conforme a política do gate no braço. */
  note?: (policy: GatePolicy, value: number | null) => string | undefined;
};

/** Métricas exibidas na tabela comparativa, na ordem. */
export const METRICS: MetricDef[] = [
  {
    key: 'accuracy', label: 'Acurácia automática (valores esperados)', kind: 'rate', good: true,
    hint: 'Casos corretos ÷ casos: resposta com todos os valores esperados, ou abstenção quando não há resposta no corpus.',
    detail: { label: 'casos incorretos', pick: (c) => !c.correct },
  },
  {
    key: 'answerAccuracy', label: 'Respondíveis corretas', kind: 'rate', good: true,
    hint: 'Entre as perguntas com resposta no corpus, quantas vieram com todos os valores esperados.',
    detail: { label: 'respondíveis incorretas', pick: (c) => c.answerable && !c.correct },
  },
  {
    key: 'abstentionAccuracy', label: 'Abstenção correta', kind: 'rate', good: true,
    hint: 'Entre as perguntas sem resposta no corpus, quantas receberam "Não consta" em vez de uma resposta inventada.',
    detail: { label: 'respondeu o que não consta', pick: (c) => !c.answerable && !c.abstained },
  },
  {
    key: 'falseAbstention', label: 'Abstenção indevida', kind: 'rate', good: false,
    hint: 'Perguntas com resposta no corpus em que o modelo disse "Não consta".',
    detail: { label: 'abstenções indevidas', pick: (c) => c.answerable && c.abstained },
  },
  {
    key: 'groundedRate', label: 'Respostas totalmente referenciadas', kind: 'rate', good: true,
    hint: 'O texto do modelo (após reparo) tinha citação em todo bloco factual e todo valor consta dos trechos citados. Medido antes de o gate ajustar qualquer coisa: é a qualidade do que o modelo escreveu.',
    detail: { label: 'respostas com trecho sem respaldo no texto do modelo', pick: (c) => c.grounded === false },
  },
  {
    key: 'unreferencedRate', label: 'Informação sem referência ou inválida', kind: 'rate', good: false,
    hint: 'Respostas em que o modelo escreveu algo sem referência (bloco sem citação ou valor que não consta dos trechos citados) ou citou um rótulo inventado. Nos braços sem gate isso chegou assim ao usuário. Nas configurações com gate strict (híbrida e com busca adicional) nada disso é entregue — o gate ajusta a resposta antes; o número em itálico é quanto ele ajustou.',
    detail: {
      label: (policy) => (policy === 'strict' ? 'respostas ajustadas pelo gate (informação sem referência ou citação inventada)' : 'respostas entregues com informação sem referência ou citação inventada'),
      pick: (c) => c.grounded === false || c.invalidLabels > 0,
    },
    shown: (value, policy) => (policy === 'strict' && value !== null ? 0 : value),
    note: (policy, value) => (policy === 'strict' && value !== null ? `gate ajustou ${Math.round(value * 100)}%` : policy === 'warn' && value ? 'entregue assim' : undefined),
  },
  {
    key: 'misplacedCitationRate', label: 'Citação no item errado', kind: 'rate', good: false,
    hint: 'Respostas em que um valor existe no documento, mas não no item citado nem no pai/filho dele (ex.: cita o 7.2 "serão eliminadas" para os valores que estão no 7.1). Citar o item pai ou um subitem do item certo não conta. Os demais valores sem respaldo não constam do documento.',
    detail: { label: 'respostas com valor citado no item errado', pick: (c) => (c.misplacedValues ?? 0) > 0 },
  },
  {
    key: 'repairedRate', label: 'Precisou de reparo', kind: 'rate', good: false, interna: true,
    hint: 'Respostas que exigiram uma segunda chamada pedindo citações/correções.',
    detail: { label: 'respostas reparadas', pick: (c) => c.repaired },
  },
  {
    key: 'meanLatencyMs', label: 'Latência média', kind: 'ms', good: false,
    hint: 'Tempo médio por resposta (busca, geração, reparo e busca adicional), sem a chamada de expansão de consulta e sem a subida do processo do CLI do Claude Code — um processo por chamada, ≈ 1,6 s, que não existe com chave própria ou modelo local. A subida descontada aparece ao lado; nas execuções anteriores à medição (16/09) ela é estimada pelo número de chamadas.',
  },
  {
    key: 'meanOverheadMs', label: 'Subida do CLI (descontada)', kind: 'ms', good: null,
    hint: 'Tempo médio por resposta gasto só para subir o processo do CLI do Claude Code, já descontado da latência acima. Some com chave própria (BYOK) ou modelo local. Estimado (1,6 s por chamada) nas execuções anteriores à medição.',
  },
  { key: 'meanTokens', label: 'Tokens por resposta', hint: 'Entrada + saída, média por resposta.', kind: 'count', good: false },
];

/** Métricas de apresentação (sem o diagnóstico interno do RAG). */
export const PUBLIC_METRICS: MetricDef[] = METRICS.filter((m) => !m.interna);

/** Seta que abre o nome da métrica: ↑ maior é melhor, ↓ menor é melhor. */
export function metricArrow(def: MetricDef): string {
  if (def.good === null) return '';
  return def.good ? '↑' : '↓';
}

export function formatMetric(def: MetricDef, value: number | null): string {
  if (value === null) return '—';
  if (def.kind === 'rate') return `${Math.round(value * 100)}%`;
  if (def.kind === 'ms') return `${(value / 1000).toFixed(1)} s`;
  return String(Math.round(value));
}

export function metricValue(summary: EvalArmSummary, def: MetricDef): number | null {
  const v = summary[def.key];
  return typeof v === 'number' ? v : null;
}

export type TopicRow = { topic: string; n: number; byArm: Record<string, { correct: number; n: number }> };

/** Acurácia por tema (coluna `topic` do CSV) e braço. */
export function byTopic(cases: EvalCase[], arms: EvalArmId[]): TopicRow[] {
  const rows = new Map<string, TopicRow>();
  for (const c of cases) {
    const topic = c.topic ?? '(sem tema)';
    let row = rows.get(topic);
    if (!row) {
      row = { topic, n: 0, byArm: Object.fromEntries(arms.map((a) => [a, { correct: 0, n: 0 }])) };
      rows.set(topic, row);
    }
    const cell = row.byArm[c.arm];
    if (!cell) continue;
    cell.n++;
    if (c.correct) cell.correct++;
    if (c.arm === arms[0]) row.n++;
  }
  return [...rows.values()];
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
