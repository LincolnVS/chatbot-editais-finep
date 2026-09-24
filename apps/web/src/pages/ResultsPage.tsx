import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Loader2, Play, RotateCcw, SearchX, Trash2, XCircle } from 'lucide-react';
import type { EvalArmId, EvalArmSummary, EvalCase, EvalRun, EvalRunSummary, GatePolicy } from '@editais/shared';
import { casePolicy, DEFAULT_EVAL_ARMS, EVAL_ARMS, EVAL_ARM_IDS } from '@editais/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { deleteEvalRun, getEvalRun, listEvalQuestionFiles, listEvalRuns, listWorkspaces, resumeEvalRun, startEvalRun } from '@/lib/api';
import { armShort, byTopic, formatDate, formatMetric, metricArrow, metricValue, METRICS, PUBLIC_METRICS, type MetricDef } from '@/lib/eval';
import { annotateAnswer, checkExpectedValues } from '@/lib/answer-view';
import { describeLlm, useLlmSettings } from '@/lib/llm-settings';
import { cn } from '@/lib/utils';

const MAX_COMPARE = 4;

/** Resultados do harness: braços (variantes de arquitetura) lado a lado, geral e por documento, e o detalhe pergunta a pergunta. */
export function ResultsPage() {
  const qc = useQueryClient();
  // Diagnóstico interno do RAG (recuperação, gate, reparo): medido sempre, exibido só sob demanda.
  const [showInternal, setShowInternal] = useState(false);
  const runs = useQuery({
    queryKey: ['eval-runs'],
    queryFn: listEvalRuns,
    // Execuções também podem ser iniciadas pela CLI: a lista se atualiza sozinha, mais rápido enquanto alguma roda.
    refetchInterval: (query) => (query.state.data?.some((r) => r.status === 'running') ? 2000 : 10_000),
  });
  const [selected, setSelected] = useState<string[]>([]);
  const list = runs.data ?? [];
  // Sem seleção explícita, mostra a execução mais recente.
  const chosen = selected.length > 0 ? selected.filter((id) => list.some((r) => r.id === id)) : list.slice(0, 1).map((r) => r.id);
  const details = useQueries({
    queries: chosen.map((id) => ({
      queryKey: ['eval-run', id],
      queryFn: () => getEvalRun(id),
      refetchInterval: (query: { state: { data?: EvalRun } }) => (query.state.data?.status === 'running' ? 2000 : false),
    })),
  });
  const loaded = details.map((d) => d.data).filter((r): r is EvalRun => !!r);
  const primary = loaded[0];

  const remove = useMutation({
    mutationFn: deleteEvalRun,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['eval-runs'] }),
    onError: (err) => toast.error(err.message),
  });
  const resume = useMutation({
    mutationFn: resumeEvalRun,
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: ['eval-runs'] });
      void qc.invalidateQueries({ queryKey: ['eval-run', run.id] });
      toast.success(`Execução retomada em ${run.progress.done}/${run.progress.total}`);
    },
    onError: (err) => toast.error(err.message),
  });

  function toggle(id: string) {
    setSelected((prev) => {
      const base = prev.length > 0 ? prev : chosen;
      if (base.includes(id)) return base.filter((x) => x !== id);
      return [...base, id].slice(-MAX_COMPARE);
    });
  }

  return (
    <div className="grid h-full grid-cols-[300px_minmax(0,1fr)] overflow-hidden">
      <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-r p-4">
        <div>
          <h1 className="text-lg font-semibold">Exploração</h1>
          <p className="text-xs text-muted-foreground">Cada execução roda o padrão-ouro em cada braço (variante de arquitetura). Marque até {MAX_COMPARE} execuções para comparar.</p>
          <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-900 dark:text-amber-200">
            <strong>Execuções de desenvolvimento</strong> — cada linha é um teste de arquitetura; o resultado consolidado está na aba Resultados (uma execução por configuração). Os números consolidados, com uma execução por arquitetura sobre o padrão-ouro completo, estão na aba Resultados.
          </p>
        </div>
        <NewRunForm onStarted={(run) => setSelected([run.id])} />
        <ol className="flex flex-col gap-1.5">
          {list.map((r) => (
            <RunItem key={r.id} run={r} checked={chosen.includes(r.id)} primary={r.id === chosen[0]} onToggle={() => toggle(r.id)} onDelete={() => remove.mutate(r.id)} onResume={() => resume.mutate(r.id)} />
          ))}
          {runs.isSuccess && list.length === 0 && <li className="text-xs text-muted-foreground">Nenhuma execução ainda. Rode uma acima ou via <code>npm run eval</code>.</li>}
        </ol>
      </aside>
      <section className="flex min-h-0 flex-col gap-6 overflow-y-auto p-6">
        {loaded.length === 0 && <p className="text-sm text-muted-foreground">{runs.isLoading ? 'Carregando…' : 'Selecione uma execução.'}</p>}
        {loaded.length > 0 && <SummaryTable runs={loaded} showInternal={showInternal} onShowInternal={setShowInternal} />}
        {loaded.length > 0 && <ByDocumentTable runs={loaded} showInternal={showInternal} />}
        {primary && <TopicTable run={primary} />}
        {primary && <CasesTable run={primary} />}
      </section>
    </div>
  );
}

function RunItem({ run, checked, primary, onToggle, onDelete, onResume }: { run: EvalRunSummary; checked: boolean; primary: boolean; onToggle: () => void; onDelete: () => void; onResume: () => void }) {
  const pct = run.progress.total > 0 ? Math.round((run.progress.done / run.progress.total) * 100) : 0;
  return (
    <li className={cn('rounded-lg border p-2 text-xs', checked && 'border-primary/60 bg-accent/40', primary && 'ring-1 ring-primary/40')}>
      <label className="flex cursor-pointer items-start gap-2">
        <input type="checkbox" checked={checked} onChange={onToggle} className="mt-0.5" aria-label={`comparar ${run.label ?? run.id}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 font-medium">
            <span className="truncate">{run.label ?? formatDate(run.createdAt)}</span>
            {run.status === 'running' && <Loader2 className="size-3 animate-spin text-muted-foreground" aria-label="em execução" />}
            {run.status === 'error' && <XCircle className="size-3 text-destructive" aria-label="erro" />}
          </span>
          <span className="block truncate text-muted-foreground">{run.label ? `${formatDate(run.createdAt)} · ` : ''}{run.workspaces.map((w) => w.name).join(', ')}</span>
          <span className="block truncate text-muted-foreground">{run.llm.provider} · {run.questionCount} perguntas × {run.arms.length} braços</span>
          {run.status === 'running' && <span className="mt-1 block h-1 overflow-hidden rounded bg-muted"><span className="block h-full bg-primary" style={{ width: `${pct}%` }} /></span>}
          {run.status === 'running' && <span className="block text-muted-foreground">{run.progress.done}/{run.progress.total}</span>}
          {run.error && <span className="block text-destructive">{run.error}</span>}
        </span>
        {run.status !== 'running' && (
          <span className="flex flex-col">
            {run.status === 'error' && (
              <Button variant="ghost" size="icon-xs" aria-label="retomar execução (mesmo modelo)" title="Retomar com o mesmo modelo: mantém os casos pontuados e refaz os que faltam" onClick={(e) => { e.preventDefault(); onResume(); }}>
                <RotateCcw className="size-3.5" />
              </Button>
            )}
            <Button variant="ghost" size="icon-xs" aria-label="apagar execução" onClick={(e) => { e.preventDefault(); onDelete(); }}>
              <Trash2 className="size-3.5" />
            </Button>
          </span>
        )}
      </label>
    </li>
  );
}

function NewRunForm({ onStarted }: { onStarted: (run: EvalRun) => void }) {
  const qc = useQueryClient();
  const llm = useLlmSettings();
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: listWorkspaces });
  const files = useQuery({ queryKey: ['eval-questions'], queryFn: listEvalQuestionFiles });
  const [open, setOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState('');
  const [file, setFile] = useState('nucleo.csv');
  const [arms, setArms] = useState<EvalArmId[]>(DEFAULT_EVAL_ARMS);
  const [grounding, setGrounding] = useState<'' | 'strict' | 'warn'>('');
  const [label, setLabel] = useState('');
  const [pauseSec, setPauseSec] = useState('0');

  const start = useMutation({
    mutationFn: startEvalRun,
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: ['eval-runs'] });
      onStarted(run);
      setOpen(false);
      toast.success('Avaliação iniciada; o progresso aparece na lista.');
    },
    onError: (err) => toast.error(err.message),
  });

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Play className="size-3.5" /> Nova execução
      </Button>
    );
  }
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate({
          workspaceId: workspaceId || undefined,
          questionsFile: file,
          arms,
          grounding: grounding || undefined,
          label: label.trim() || undefined,
          pauseMs: Math.round(Number(pauseSec) * 1000) || 0,
        });
      }}
    >
      <label className="flex flex-col gap-1">
        editais
        <NativeSelect size="sm" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
          <NativeSelectOption value="">todos os do arquivo de perguntas</NativeSelectOption>
          {(workspaces.data ?? []).map((w) => <NativeSelectOption key={w.id} value={w.id}>{w.name}</NativeSelectOption>)}
        </NativeSelect>
      </label>
      <label className="flex flex-col gap-1">
        perguntas (pasta eval/)
        <NativeSelect size="sm" value={file} onChange={(e) => setFile(e.target.value)}>
          {(files.data ?? [{ file: 'questions.csv', count: 0 }]).map((f) => <NativeSelectOption key={f.file} value={f.file}>{f.file} ({f.count})</NativeSelectOption>)}
        </NativeSelect>
      </label>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1">braços (variantes de arquitetura)</legend>
        {EVAL_ARM_IDS.map((id) => {
          const spec = EVAL_ARMS[id];
          return (
            <label key={id} className="flex items-start gap-1.5" title={spec.description}>
              <input type="checkbox" className="mt-0.5" checked={arms.includes(id)} onChange={(e) => setArms(EVAL_ARM_IDS.filter((x) => (x === id ? e.target.checked : arms.includes(x))))} />
              <span>
                {spec.label}
                {spec.control && <span className="text-muted-foreground"> — controle, inválido como produto</span>}
                {spec.largeContext && <span className="text-muted-foreground"> — exige janela grande (Gemini)</span>}
              </span>
            </label>
          );
        })}
      </fieldset>
      <label className="flex flex-col gap-1">
        gate de fundamentação
        <NativeSelect size="sm" value={grounding} onChange={(e) => setGrounding(e.target.value as '' | 'strict' | 'warn')}>
          <NativeSelectOption value="">o de cada braço (padrão)</NativeSelectOption>
          <NativeSelectOption value="strict">strict em todos que não fixam o seu</NativeSelectOption>
          <NativeSelectOption value="warn">warn — só mede, não remove</NativeSelectOption>
        </NativeSelect>
      </label>
      <label className="flex flex-col gap-1">
        rótulo (opcional)
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ex.: gpt-oss-120b, chunk 1600" className="h-7 text-xs" maxLength={80} />
      </label>
      <label className="flex flex-col gap-1">
        pausa entre chamadas (s) — free tiers com limite por minuto
        <Input type="number" min={0} max={60} step={1} value={pauseSec} onChange={(e) => setPauseSec(e.target.value)} className="h-7 w-24 text-xs" />
      </label>
      <p className="text-muted-foreground">LLM: {describeLlm(llm)}</p>
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={start.isPending || arms.length === 0}>
          {start.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Rodar
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
      </div>
    </form>
  );
}

type Column = { run: EvalRun; arm: EvalArmId };

function columnsOf(runs: EvalRun[]): Column[] {
  return runs.flatMap((run) => run.arms.map((arm) => ({ run, arm })));
}

function ColumnHead({ c, showRun }: { c: Column; showRun: boolean }) {
  const spec = EVAL_ARMS[c.arm];
  return (
    <th className="p-2 text-left font-medium">
      <Tooltip>
        <TooltipTrigger className="cursor-help text-left">
          <span className="block">{spec.short}{spec.control ? ' *' : ''}</span>
          {showRun && <span className="block font-normal text-muted-foreground">{c.run.label ?? formatDate(c.run.createdAt)}</span>}
        </TooltipTrigger>
        <TooltipContent className="max-w-80"><b>{spec.label}.</b> {spec.description}</TooltipContent>
      </Tooltip>
    </th>
  );
}

function runCaption(r: EvalRun): string {
  const state = r.status === 'running' ? ` · em execução (${r.progress.done}/${r.progress.total})` : '';
  return `${r.label ?? formatDate(r.createdAt)}: ${r.questionCount} perguntas em ${r.workspaces.length} edital(is) · ${r.llm.provider} · ${r.promptVersion}${r.grounding ? ` · gate ${r.grounding}` : ''}${state}`;
}

function SummaryTable({ runs, showInternal, onShowInternal }: { runs: EvalRun[]; showInternal: boolean; onShowInternal: (v: boolean) => void }) {
  const columns = columnsOf(runs);
  const hasControl = columns.some((c) => EVAL_ARMS[c.arm].control);
  const metrics = showInternal ? METRICS : PUBLIC_METRICS;
  // Métrica aberta: a linha seguinte lista, por braço, os casos por trás do número.
  const [openKey, setOpenKey] = useState<MetricDef['key'] | null>(null);
  return (
    <div>
      <div className="mb-1 flex items-center gap-3">
        <h2 className="text-sm font-semibold">Geral — métricas por braço</h2>
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={showInternal} onCheckedChange={onShowInternal} />
          diagnóstico interno do RAG
        </label>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{runs.map(runCaption).join(' — ')}</p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              <th className="p-2 text-left font-medium">métrica</th>
              {columns.map((c) => <ColumnHead key={`${c.run.id}-${c.arm}`} c={c} showRun={runs.length > 1} />)}
            </tr>
          </thead>
          <tbody>
            {metrics.map((def) => {
              const open = openKey === def.key;
              return (
                <Fragment key={def.key}>
                  <tr className={cn('border-t', def.detail && 'cursor-pointer hover:bg-accent/40', open && 'bg-accent/40')} onClick={def.detail ? () => setOpenKey(open ? null : def.key) : undefined}>
                    <td className="whitespace-nowrap p-2">
                      <span className="flex items-center gap-1.5">
                        <span className="w-3.5 text-muted-foreground">{def.detail ? (open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />) : null}</span>
                        <span className="w-3 text-center text-muted-foreground" aria-label={def.good === null ? undefined : def.good ? 'maior é melhor' : 'menor é melhor'}>{metricArrow(def)}</span>
                        <Tooltip>
                          <TooltipTrigger className="cursor-help text-left underline decoration-dotted underline-offset-2" onClick={(e) => e.stopPropagation()}>{def.label}</TooltipTrigger>
                          <TooltipContent className="max-w-80">{def.hint}</TooltipContent>
                        </Tooltip>
                      </span>
                    </td>
                    {columns.map((c) => <MetricCell key={`${c.run.id}-${c.arm}`} def={def} value={metricValue(c.run.summary.find((s) => s.arm === c.arm)!, def)} policy={casePolicy({ arm: c.arm }, c.run.grounding)} />)}
                  </tr>
                  {open && def.detail && (
                    <tr className="border-t bg-muted/20">
                      <td colSpan={1 + columns.length} className="p-3">
                        <MetricDetail def={def} columns={columns} showRun={runs.length > 1} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        ↑ maior é melhor · ↓ menor é melhor · — não se aplica ao braço · clique na métrica para ver os casos por trás do número.
        {hasControl && ' * braço de controle: o modelo responde sem documento — não é um modo válido do produto, só mede o que ele inventa ou deixa de responder sem fonte.'}
      </p>
    </div>
  );
}

/** Casos por trás de uma métrica, um bloco por braço (coluna) — em especial o que foi entregue sem referência e o que o gate ajustou. */
function MetricDetail({ def, columns, showRun }: { def: MetricDef; columns: Column[]; showRun: boolean }) {
  const detail = def.detail!;
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(columns.length, 3)}, minmax(0, 1fr))` }}>
      {columns.map((c) => {
        const policy = casePolicy({ arm: c.arm }, c.run.grounding);
        const picked = c.run.cases.filter((x) => x.arm === c.arm && x.status !== 'error' && detail.pick(x, casePolicy(x, c.run.grounding)));
        const applies = metricValue(c.run.summary.find((s) => s.arm === c.arm)!, def) !== null;
        const label = typeof detail.label === 'function' ? detail.label(policy) : detail.label;
        return (
          <div key={`${c.run.id}-${c.arm}`} className="min-w-0 space-y-1.5">
            <p className="font-medium">
              {armShort(c.arm)}
              {showRun && <span className="font-normal text-muted-foreground"> · {c.run.label ?? formatDate(c.run.createdAt)}</span>}
              <span className="font-normal text-muted-foreground"> — {applies ? `${picked.length} ${label}` : 'não se aplica'}</span>
            </p>
            {applies && picked.length === 0 && <p className="text-muted-foreground">nenhum caso.</p>}
            {picked.map((x) => <MetricCase key={`${x.workspaceId}:${x.questionId}`} c={x} metric={def.key} policy={casePolicy(x, c.run.grounding)} />)}
          </div>
        );
      })}
    </div>
  );
}

function MetricCase({ c, metric, policy }: { c: EvalCase; metric: MetricDef['key']; policy: GatePolicy }) {
  const grounding = metric === 'groundedRate' || metric === 'unreferencedRate' || metric === 'misplacedCitationRate';
  const uncited = Math.max(0, c.blocks - c.cited);
  return (
    <div className="space-y-1 rounded border bg-background p-2">
      <p><span className="mr-1 text-muted-foreground">{c.questionId}</span>{c.question}</p>
      <p className="text-muted-foreground">
        {c.workspaceName} · {c.status} · {c.correct ? 'correta' : 'incorreta'}
        {c.invalidLabels > 0 ? ` · ${c.invalidLabels} citação(ões) inventada(s)` : ''}
        {grounding ? ` · ${uncited} bloco(s) sem referência · ${c.unsupportedValues} valor(es) sem respaldo${c.misplacedValues ? ` (${c.misplacedValues} em outro item)` : ''}${c.invalidLabels > 0 ? ` · ${c.invalidLabels} citação(ões) inventada(s)` : ''}${c.removed > 0 ? ` · gate ajustou ${c.removed} bloco(s)` : ''}` : ''}
      </p>
      <ExpectedLine c={c} />
      <AnswerTexts c={c} policy={policy} />
    </div>
  );
}

/** O que o padrão-ouro esperava e o que chegou: cada valor esperado marcado como entregue, ajustado pelo gate ou ausente. */
function ExpectedLine({ c }: { c: EvalCase }) {
  if (!c.answerable) {
    return <p className="text-muted-foreground">esperado: abstenção ("Não consta") — {c.abstained ? <span className="text-emerald-700">abstenção ✓</span> : <span className="text-destructive">respondeu algo ✗</span>}</p>;
  }
  const checks = checkExpectedValues(c);
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground">
      esperado{c.expectedItem ? ` (item ${c.expectedItem})` : ''}:
      {checks.length === 0 && <span>uma resposta com citação — {c.abstained ? <span className="text-destructive">abstenção ✗</span> : <span className="text-emerald-700">respondeu ✓</span>}</span>}
      {checks.map((v) => (
        <span key={v.value} className={cn('rounded border px-1', v.delivered ? 'border-emerald-600/40 text-emerald-700' : 'border-destructive/40 text-destructive')} title={v.delivered ? 'valor presente na resposta entregue' : v.inModel ? 'o modelo escreveu o valor, mas sem referência: o gate ajustou o bloco' : 'valor ausente na resposta'}>
          {v.value} {v.delivered ? '✓' : v.inModel ? '✗ (sem referência, gate ajustou)' : '✗ ausente'}
        </span>
      ))}
    </p>
  );
}

/** Texto do modelo lado a lado com o texto entregue ao usuário; blocos sem referência (ajustados pelo gate, ou entregues assim sem gate) marcados com o motivo. */
function AnswerTexts({ c, policy }: { c: EvalCase; policy: GatePolicy }) {
  const { blocks, changed } = useMemo(() => annotateAnswer(c, policy), [c, policy]);
  const flagged = blocks.filter((b) => b.removed || b.problem).length;
  let title: string;
  if (policy === 'off') title = 'resposta (braço sem gate de fundamentação)';
  else if (changed) title = 'o que o modelo escreveu';
  else if (policy === 'strict') title = 'o que o modelo escreveu = o que o usuário recebeu (o gate não precisou ajustar nada)';
  else title = flagged > 0 ? 'o que o modelo escreveu = o que o usuário recebeu (sem gate: entregue assim)' : 'o que o modelo escreveu = o que o usuário recebeu (sem gate; nada a ajustar)';
  return (
    <div className={cn('grid gap-2', changed && 'lg:grid-cols-2')}>
      <div className="min-w-0">
        <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{title}</p>
        <div className="space-y-1 rounded bg-muted/40 p-2">
          {blocks.length === 0 && <p className="text-muted-foreground">(vazio)</p>}
          {blocks.map((b, i) => (
            <div key={i} className={cn('whitespace-pre-wrap', b.removed && 'rounded border-l-2 border-destructive bg-destructive/10 pl-1.5', !b.removed && b.problem && 'rounded border-l-2 border-amber-500 bg-amber-500/10 pl-1.5')}>
              {(b.removed || b.problem) && (
                <span className={cn('mr-1 inline-block rounded px-1 text-[10px] font-medium', b.removed ? 'bg-destructive/15 text-destructive' : 'bg-amber-500/20 text-amber-800')}>
                  {b.removed ? 'gate ajustou' : policy === 'warn' ? 'entregue assim' : 'problema'}{b.problem ? `: ${b.problem}` : ''}{b.estimated ? ' (deduzido)' : ''}
                </span>
              )}
              <span className={cn(b.removed && 'text-muted-foreground line-through')}>{b.text}</span>
            </div>
          ))}
        </div>
      </div>
      {changed && (
        <div className="min-w-0">
          <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">o que o usuário recebeu</p>
          <p className="whitespace-pre-wrap rounded bg-muted/40 p-2">{c.text || '(vazio)'}</p>
        </div>
      )}
    </div>
  );
}

function MetricCell({ def, value: raw, policy }: { def: MetricDef; value: number | null; policy?: GatePolicy }) {
  const value = policy && def.shown ? def.shown(raw, policy) : raw;
  const note = policy ? def.note?.(policy, raw) : undefined;
  const bar = def.kind === 'rate' && value !== null;
  // A barra mede o que a métrica conta: verde quando é coisa boa (↑), âmbar quando é coisa ruim (↓).
  const tone = def.good === null ? 'bg-muted-foreground/40' : def.good ? 'bg-emerald-500/70' : 'bg-amber-500/70';
  return (
    <td className="p-2 align-middle">
      <div className="flex items-center gap-2">
        <span className="w-12 tabular-nums">{formatMetric(def, value)}</span>
        {bar && <span className="h-1.5 w-20 overflow-hidden rounded bg-muted"><span className={cn('block h-full', tone)} style={{ width: `${Math.round(value * 100)}%` }} /></span>}
        {note && value !== null && <span className="text-muted-foreground italic">{note}</span>}
      </div>
    </td>
  );
}

/** Uma métrica (selecionável) por documento × braço. */
function ByDocumentTable({ runs, showInternal }: { runs: EvalRun[]; showInternal: boolean }) {
  const [metricKey, setMetricKey] = useState<MetricDef['key']>('accuracy');
  const metrics = showInternal ? METRICS : PUBLIC_METRICS;
  const def = metrics.find((m) => m.key === metricKey) ?? metrics[0]!;
  const columns = columnsOf(runs);
  // Linhas: união dos documentos das execuções selecionadas, na ordem em que aparecem.
  const docs: Array<{ id: string; name: string }> = [];
  for (const r of runs) for (const w of r.workspaces) if (!docs.some((d) => d.id === w.id)) docs.push(w);
  const cell = (c: Column, docId: string): EvalArmSummary | undefined => c.run.byWorkspace.find((w) => w.workspaceId === docId)?.summary.find((s) => s.arm === c.arm);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold">Por documento do dataset</h2>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          métrica
          <NativeSelect size="sm" value={metricKey} onChange={(e) => setMetricKey(e.target.value as MetricDef['key'])} className="w-auto">
            {metrics.map((m) => <NativeSelectOption key={m.key} value={m.key}>{metricArrow(m)} {m.label}</NativeSelectOption>)}
          </NativeSelect>
        </label>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              <th className="p-2 text-left font-medium">edital</th>
              <th className="p-2 text-left font-medium">perguntas</th>
              {columns.map((c) => <ColumnHead key={`${c.run.id}-${c.arm}`} c={c} showRun={runs.length > 1} />)}
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="p-2">{d.name}</td>
                <td className="p-2 tabular-nums text-muted-foreground">{runs.map((r) => r.byWorkspace.find((w) => w.workspaceId === d.id)?.questions).find((n) => n !== undefined) ?? '—'}</td>
                {columns.map((c) => {
                  const s = cell(c, d.id);
                  return <MetricCell key={`${c.run.id}-${c.arm}`} def={def} value={s ? metricValue(s, def) : null} policy={casePolicy({ arm: c.arm }, c.run.grounding)} />;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TopicTable({ run }: { run: EvalRun }) {
  const rows = useMemo(() => byTopic(run.cases, run.arms), [run.cases, run.arms]);
  if (rows.length <= 1) return null;
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold">Acurácia por tema</h2>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              <th className="p-2 text-left font-medium">tema</th>
              <th className="p-2 text-left font-medium">perguntas</th>
              {run.arms.map((a) => <th key={a} className="p-2 text-left font-medium">{armShort(a)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.topic} className="border-t">
                <td className="p-2">{r.topic}</td>
                <td className="p-2 tabular-nums">{r.n}</td>
                {run.arms.map((a) => {
                  const c = r.byArm[a] ?? { correct: 0, n: 0 };
                  return <td key={a} className="p-2 tabular-nums">{c.n > 0 ? `${c.correct}/${c.n}` : '—'}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type QuestionGroup = { workspaceId: string; workspaceName: string; questions: Array<[string, EvalCase[]]> };

/** Casos agrupados por documento e, dentro dele, por pergunta (na ordem de execução). */
function groupCases(cases: EvalCase[]): QuestionGroup[] {
  const groups: QuestionGroup[] = [];
  for (const c of cases) {
    let g = groups.find((x) => x.workspaceId === c.workspaceId);
    if (!g) {
      g = { workspaceId: c.workspaceId, workspaceName: c.workspaceName, questions: [] };
      groups.push(g);
    }
    let q = g.questions.find(([id]) => id === c.questionId);
    if (!q) {
      q = [c.questionId, []];
      g.questions.push(q);
    }
    q[1].push(c);
  }
  return groups;
}

function CasesTable({ run }: { run: EvalRun }) {
  const policyOf = (c: EvalCase): GatePolicy => casePolicy(c, run.grounding);
  const [openId, setOpenId] = useState<string | null>(null);
  const groups = useMemo(() => groupCases(run.cases), [run.cases]);
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold">Pergunta a pergunta</h2>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              <th className="w-6 p-2" />
              <th className="p-2 text-left font-medium">pergunta</th>
              <th className="p-2 text-left font-medium">esperado</th>
              {run.arms.map((a) => <th key={a} className="p-2 text-left font-medium">{armShort(a)}</th>)}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.workspaceId}>
                <tr className="border-t bg-muted/30">
                  <td colSpan={3 + run.arms.length} className="p-2 font-medium">{g.workspaceName}</td>
                </tr>
                {g.questions.map(([id, cases]) => {
                  const key = `${g.workspaceId}:${id}`;
                  const open = openId === key;
                  return <QuestionRows key={key} id={id} cases={cases} arms={run.arms} policyOf={policyOf} open={open} onToggle={() => setOpenId(open ? null : key)} />;
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function QuestionRows({ id, cases, arms, policyOf, open, onToggle }: { id: string; cases: EvalCase[]; arms: EvalArmId[]; policyOf: (c: EvalCase) => GatePolicy; open: boolean; onToggle: () => void }) {
  const first = cases[0]!;
  const expected = first.answerable
    ? `${first.expectedItem ? `item ${first.expectedItem}` : ''}${first.expectedValues.length ? ` · ${first.expectedValues.join(' | ')}` : ''}`
    : 'sem resposta no corpus';
  return (
    <>
      <tr className="cursor-pointer border-t hover:bg-accent/40" onClick={onToggle}>
        <td className="p-2 text-muted-foreground">{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</td>
        <td className="p-2"><span className="mr-1 text-muted-foreground">{id}</span>{first.question}</td>
        <td className="p-2 text-muted-foreground">{expected}</td>
        {arms.map((a) => {
          const c = cases.find((x) => x.arm === a);
          return <td key={a} className="p-2">{c ? <CaseCell c={c} /> : <span className="text-muted-foreground">…</span>}</td>;
        })}
      </tr>
      {open && (
        <tr className="border-t bg-muted/20">
          <td />
          <td colSpan={2 + arms.length} className="p-3">
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(cases.length, 2)}, minmax(0, 1fr))` }}>
              {cases.map((c) => <CaseDetail key={c.arm} c={c} policy={policyOf(c)} />)}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function CaseCell({ c }: { c: EvalCase }) {
  const Icon = c.status === 'error' ? XCircle : c.correct ? CheckCircle2 : c.abstained ? SearchX : c.status === 'clarification' ? CircleHelp : XCircle;
  const tone = c.status === 'error' ? 'text-destructive' : c.correct ? 'text-emerald-600' : 'text-amber-600';
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <Icon className={cn('size-3.5', tone)} aria-label={c.correct ? 'correta' : 'incorreta'} />
      {c.valuesExpected > 0 && <span className="tabular-nums">{c.valuesFound}/{c.valuesExpected} valores</span>}
      {c.mode !== 'closed_book' && <span className="tabular-nums text-muted-foreground">{c.citations} cit.{c.invalidLabels > 0 ? ` (+${c.invalidLabels} inválidas)` : ''}</span>}
      {c.retrievalHit === false && <Badge variant="outline" className="h-4 px-1 font-normal text-amber-700">item não recuperado</Badge>}
      {c.removed > 0 && <Badge variant="outline" className="h-4 px-1 font-normal">gate −{c.removed}</Badge>}
      <span className="tabular-nums text-muted-foreground">{(c.latencyMs / 1000).toFixed(1)} s</span>
    </span>
  );
}

function CaseDetail({ c, policy }: { c: EvalCase; policy: GatePolicy }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="font-medium">{EVAL_ARMS[c.arm].label} · <span className="font-normal text-muted-foreground">{c.status}{c.repaired ? ' · reparada' : ''}{c.fallbackFrom ? ` · reserva (${c.fallbackFrom} falhou)` : ''}</span></p>
      {c.error && <p className="text-destructive">{c.error}</p>}
      {c.variants && c.variants.length > 0 && (
        <p className="text-muted-foreground">busca com a pergunta e as variantes: {c.variants.map((v) => `“${v}”`).join(' · ')}</p>
      )}
      <ExpectedLine c={c} />
      <AnswerTexts c={c} policy={policy} />
      <p className="text-muted-foreground">
        blocos {c.cited}/{c.blocks} citados{c.unsupportedValues > 0 ? ` · ${c.unsupportedValues} valor(es) sem respaldo` : ''} · {c.inputTokens + c.outputTokens} tokens
      </p>
    </div>
  );
}
