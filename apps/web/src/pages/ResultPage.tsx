import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { EvalArmId, EvalCase, EvalRun } from '@editais/shared';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getEvalRun } from '@/lib/api';
import { conferRun, type ConferredCase } from '@/lib/conferencia';
import { cn } from '@/lib/utils';

type Model = 'Sonnet' | 'Haiku';

const MODELS: Model[] = ['Sonnet', 'Haiku'];

/** Execuções disponíveis na tela: cada uma roda as quatro arquiteturas sobre o mesmo padrão-ouro. */
// Execuções com o glossário derivado do documento. As anteriores usavam o glossário escrito à mão, que foi montado
// olhando as perguntas de avaliação, e por isso não valem como resultado.
const RUNS: Array<{ id: string; model: Model; rep: number }> = [
  { id: '01M36542VVAFDQK9RFZ8R2PJE7', model: 'Sonnet', rep: 1 },
  { id: '01M367V5DRP1BH7H0TGAKBNPVQ', model: 'Sonnet', rep: 2 },
  { id: '01M379FMK6FQ0AZCVJ5GRMSTEF', model: 'Sonnet', rep: 3 },
  { id: '01M36545VC6CZDEKHMNR7DKKXP', model: 'Haiku', rep: 1 },
  { id: '01M3680RZ0SRQR854YQN9XJ166', model: 'Haiku', rep: 2 },
  { id: '01M377MYAYN0MRH66Z47N2NF7F', model: 'Haiku', rep: 3 },
];

/** Uma repetição, ou `rep: null` para a média do modelo (todas as repetições juntas). */
type Selection = { model: Model; rep: number | null };

const runIds = (s: Selection): string[] =>
  RUNS.filter((r) => r.model === s.model && (s.rep === null || r.rep === s.rep)).map((r) => r.id);

type Column = { arm: EvalArmId; label: string; note: string; ours?: boolean };

const COLUMNS: Column[] = [
  { arm: 'full_context', label: 'Doc. inteiro', note: 'edital completo no contexto' },
  { arm: 'rag_dense', label: 'RAG', note: 'busca vetorial clássica' },
  { arm: 'rag_hybrid', label: 'Nosso algoritmo', note: 'híbrido + expansão + gate', ours: true },
  { arm: 'rag_search', label: 'Nosso · think', note: 'com busca extra do modelo', ours: true },
];

const scored = (cases: ConferredCase[]): ConferredCase[] => cases.filter((c) => c.status !== 'error');

const rate = (cases: ConferredCase[], ok: (c: ConferredCase) => boolean): number | null => {
  const cs = scored(cases);
  return cs.length ? cs.filter(ok).length / cs.length : null;
};

const mean = (cases: ConferredCase[], of: (c: ConferredCase) => number): number | null => {
  const cs = scored(cases);
  return cs.length ? cs.reduce((s, c) => s + of(c), 0) / cs.length : null;
};

/** Abstenção correta não tem o que referenciar: conta como fundamentada. */
const referenced = (c: EvalCase): boolean => c.grounded === true || c.abstained;

const accuracy = (cases: ConferredCase[]): number | null => rate(cases, (c) => c.correct && referenced(c));
const tokens = (cases: ConferredCase[]): number | null => mean(cases, (c) => c.inputTokens);

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const thousands = (v: number): string => Math.round(v).toLocaleString('pt-BR');

type Row = {
  metric: string;
  hint: string;
  higherIsBetter: boolean;
  value: (cases: ConferredCase[]) => number | null;
  format: (v: number) => string;
  emphasis?: boolean;
};

const ROWS: Row[] = [
  {
    metric: 'Acurácia sem referência',
    hint: 'A resposta traz o que foi pedido sem afirmar nada errado: contém os valores do padrão-ouro e a conferência caso a caso não achou afirmação que erre o pedido, contradiga o edital ou não exista nele. Não exige citação.',
    higherIsBetter: true,
    value: (cs) => rate(cs, (c) => c.correct),
    format: pct,
  },
  {
    metric: 'Acurácia com referência',
    hint: 'A resposta está correta, como na linha acima, E inteiramente apoiada em trechos citados do edital. É o critério do domínio: informação sem referência não é informação.',
    higherIsBetter: true,
    value: accuracy,
    format: pct,
    emphasis: true,
  },
  {
    metric: 'Valores esperados (automático)',
    hint: 'Só a pontuação automática: a resposta contém todos os valores do padrão-ouro. Não verifica o restante da resposta; é a base sobre a qual a conferência caso a caso é aplicada.',
    higherIsBetter: true,
    value: (cs) => rate(cs, (c) => c.valuesOk),
    format: pct,
  },
  {
    metric: 'Item esperado recuperado',
    hint: 'Entre as perguntas ancoradas num item do edital, aquelas em que o item chegou ao contexto do modelo. No doc. inteiro é sempre verdadeiro, porque o edital vai inteiro.',
    higherIsBetter: true,
    value: (cs) => rate(cs.filter((c) => c.retrievalHit !== null), (c) => c.retrievalHit === true),
    format: pct,
  },
  {
    metric: 'Tokens de entrada por pergunta',
    hint: 'Custo direto: quanto texto entra no modelo a cada pergunta. Cresce com o acervo no doc. inteiro; fica constante na recuperação.',
    higherIsBetter: false,
    value: tokens,
    format: thousands,
  },
  {
    metric: 'Latência média',
    hint: 'Tempo da resposta, descontada a subida do CLI do provedor.',
    higherIsBetter: false,
    value: (cs) => mean(cs, (c) => (c.latencyMs - (c.overheadMs ?? 0)) / 1000),
    format: (v) => `${v.toFixed(1)} s`,
  },
];

function best(values: Array<number | null>, higherIsBetter: boolean): number | null {
  const real = values.filter((v): v is number => v != null);
  if (real.length < 2) return null;
  return higherIsBetter ? Math.max(...real) : Math.min(...real);
}

/** Barra proporcional atrás do valor, para a leitura da linha ser imediata. */
function Bar({ ratio, ours }: { ratio: number; ours: boolean }) {
  return (
    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn('h-full rounded-full', ours ? 'bg-primary' : 'bg-muted-foreground/40')}
        style={{ width: `${Math.max(2, Math.round(ratio * 100))}%` }}
      />
    </div>
  );
}

function MetricTable({ cases, compact = false }: { cases: ConferredCase[]; compact?: boolean }) {
  const byArm = COLUMNS.map(({ arm }) => cases.filter((c) => c.arm === arm));
  const rows = compact ? ROWS.filter((r) => r.metric.startsWith('Acurácia') || r.metric === 'Tokens de entrada por pergunta') : ROWS;

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b">
          <th className="w-[38%] px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Métrica
          </th>
          {COLUMNS.map((c) => (
            <th key={c.arm} className={cn('px-4 py-2.5 text-right align-bottom', c.ours && 'bg-primary/5')}>
              <span className={cn('block text-sm', c.ours ? 'font-semibold text-foreground' : 'font-medium')}>
                {c.label}
              </span>
              {!compact && <span className="block text-[11px] font-normal text-muted-foreground">{c.note}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const values = byArm.map((cs) => row.value(cs));
          const winner = best(values, row.higherIsBetter);
          const max = Math.max(...values.filter((v): v is number => v != null), 0) || 1;
          return (
            <tr key={row.metric} className={cn('border-b last:border-0', row.emphasis && 'bg-accent/50')}>
              <th scope="row" className="px-4 py-3 text-left align-middle font-normal">
                <Tooltip>
                  <TooltipTrigger className="text-left">
                    <span
                      className={cn(
                        'underline decoration-dotted underline-offset-4 decoration-muted-foreground/40',
                        row.emphasis && 'text-base font-semibold',
                      )}
                    >
                      {row.metric}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">{row.hint}</TooltipContent>
                </Tooltip>
              </th>
              {values.map((v, i) => {
                const col = COLUMNS[i]!;
                const isBest = v != null && winner != null && v === winner;
                return (
                  <td key={col.arm} className={cn('px-4 py-3 text-right align-middle', col.ours && 'bg-primary/5')}>
                    <span
                      className={cn(
                        'tabular-nums',
                        row.emphasis ? 'text-lg' : 'text-sm',
                        isBest ? 'font-semibold text-foreground' : 'text-muted-foreground',
                        v == null && 'text-muted-foreground',
                      )}
                    >
                      {v == null ? '—' : row.format(v)}
                    </span>
                    {v != null && <Bar ratio={row.higherIsBetter ? v : v / max} ours={Boolean(col.ours)} />}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RunPicker({ selection, onChange }: { selection: Selection; onChange: (s: Selection) => void }) {
  return (
    <div className="space-y-2">
      {MODELS.map((model) => {
        const options: Array<number | null> = [null, ...RUNS.filter((r) => r.model === model).map((r) => r.rep)];
        return (
          <div key={model} className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-xs font-medium uppercase tracking-wide text-muted-foreground">{model}</span>
            {options.map((rep) => {
              const active = selection.model === model && selection.rep === rep;
              return (
                <button
                  key={rep ?? 'media'}
                  type="button"
                  onClick={() => onChange({ model, rep })}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs transition-colors',
                    active ? 'border-primary bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:bg-accent',
                  )}
                >
                  {rep === null ? 'Média' : `Repetição ${rep}`}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export default function ResultPage() {
  const [selection, setSelection] = useState<Selection>({ model: 'Sonnet', rep: null });
  const ids = runIds(selection);
  const runs = useQueries({
    queries: ids.map((id) => ({ queryKey: ['eval-run', id], queryFn: () => getEvalRun(id), retry: false })),
  });

  if (runs.some((r) => r.isPending)) {
    return (
      <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Carregando resultado…
      </p>
    );
  }
  const loaded = runs.map((r) => r.data).filter((d): d is EvalRun => d != null);
  if (loaded.length === 0 || loaded.length < ids.length) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <RunPicker selection={selection} onChange={setSelection} />
        <p className="text-sm text-destructive">Esta execução ainda não está disponível.</p>
      </div>
    );
  }

  // Na média, as respostas de todas as repetições entram juntas; como toda repetição tem as mesmas perguntas, é a média das repetições.
  const first = loaded[0]!;
  const cases = loaded.flatMap((r) => conferRun(r.id, r.cases));
  const conferred = scored(cases).filter((c) => c.valuesOk && !c.correct).length;
  const average = selection.rep === null;
  const questions = new Set(cases.map((c) => c.questionId)).size;
  const editais = first.workspaces.map((w) => ({
    ...w,
    cases: cases.filter((c) => c.workspaceId === w.id),
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6 pb-16">
      <RunPicker selection={selection} onChange={setSelection} />

      <header className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Resultados</h1>
          <span className="text-sm text-muted-foreground">
            {questions} perguntas · {editais.length} {editais.length === 1 ? 'edital' : 'editais'} · {COLUMNS.length} arquiteturas
            {average && ` · média de ${loaded.length} repetições (${loaded.length * questions} respostas por arquitetura)`}
          </span>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Cada arquitetura responde o mesmo padrão-ouro, com o mesmo modelo e o mesmo prompt. O baseline recebe a mesma
          instrução de citar a origem de cada afirmação.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary" className="font-normal">
            {first.llm.provider.split('/')[0]}/{first.llm.model}
          </Badge>
          {loaded.map((r) => (
            <Badge key={r.id} variant="outline" className="font-mono font-normal">
              {r.id}
            </Badge>
          ))}
        </div>
      </header>

      <section className="overflow-hidden rounded-xl border shadow-sm">
        <MetricTable cases={cases} />
      </section>

      <section className="grid gap-4 rounded-xl border bg-muted/30 p-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Acurácia sem referência</p>
          <p className="mt-1 text-sm leading-relaxed">
            A resposta traz o que foi pedido e não afirma nada errado sobre o edital. Não pergunta de onde a informação
            veio.
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-foreground">Acurácia com referência</p>
          <p className="mt-1 text-sm leading-relaxed">
            O critério do domínio: resposta certa <strong>e</strong> inteiramente apoiada em trechos citados do edital.
            Num edital público, afirmação sem referência não é aproveitável — ninguém pode conferir nem usar em processo.
          </p>
        </div>
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Por edital</h2>
          <p className="text-sm text-muted-foreground">
            O mesmo recorte em cada base de documentos, para verificar que o resultado não vem de um edital só.
          </p>
        </div>
        <div className="space-y-4">
          {editais.map((w) => (
            <div key={w.id} className="overflow-hidden rounded-xl border">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b bg-muted/40 px-4 py-2.5">
                <h3 className="text-sm font-medium">{w.name}</h3>
                <span className="text-xs text-muted-foreground">
                  {new Set(w.cases.map((c) => c.questionId)).size} perguntas{average && ` × ${loaded.length} repetições`}
                </span>
              </div>
              <MetricTable cases={w.cases} compact />
            </div>
          ))}
        </div>
      </section>

      <p className="text-xs text-muted-foreground">
        Cada repetição é uma execução completa, com o mesmo modelo e o mesmo padrão-ouro para todas as arquiteturas; a
        média junta as respostas de todas as repetições do modelo. As respostas que o avaliador automático marcou como
        certas foram conferidas caso a caso contra o edital; nesta seleção, {conferred}{' '}
        {conferred === 1 ? 'resposta com os valores esperados conta' : 'respostas com os valores esperados contam'} como
        errada{conferred === 1 ? '' : 's'} por afirmar algo que o edital não diz (lista em eval/conferencia.json). As
        execuções de desenvolvimento, com outros modelos e recortes de perguntas, estão na aba Exploração, só com a
        pontuação automática.
      </p>
    </div>
  );
}
