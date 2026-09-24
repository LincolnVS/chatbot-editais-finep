import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CircleCheck, CircleOff, CircleX, FileCode2 } from 'lucide-react';
import { DEFAULT_PIPELINE_CONFIG } from '@editais/shared';
import { Badge } from '@/components/ui/badge';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { getHealth, getLlmDefaults, getPrompt, getWorkspace, listWorkspaces } from '@/lib/api';
import { toLlmConfig, useLlmSettings } from '@/lib/llm-settings';
import { LANES, buildStages, type Stage } from '@/lib/architecture';
import { cn } from '@/lib/utils';

/** Diagrama vivo da arquitetura: caixas por etapa, ligadas em sequência, com os parâmetros reais em uso. */
export function ArchitecturePage() {
  const [params, setParams] = useSearchParams();
  const workspaceId = params.get('w') ?? '';
  const [selectedId, setSelectedId] = useState<string>('grounding');

  const health = useQuery({ queryKey: ['health'], queryFn: getHealth, refetchInterval: 15_000 });
  const llm = useQuery({ queryKey: ['llm-defaults'], queryFn: getLlmDefaults });
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: listWorkspaces });
  const workspace = useQuery({ queryKey: ['workspace', workspaceId], queryFn: () => getWorkspace(workspaceId), enabled: !!workspaceId });

  const config = workspace.data?.settings ?? DEFAULT_PIPELINE_CONFIG;
  const settings = useLlmSettings();
  const stages = useMemo(() => {
    const cfg = toLlmConfig(settings);
    return buildStages({ config, health: health.data ?? null, llm: { kind: cfg.kind, model: cfg.model, fallback: llm.data?.fallback ?? null } });
  }, [config, health.data, llm.data, settings]);
  const selected = stages.find((s) => s.id === selectedId) ?? stages[0]!;

  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 overflow-y-auto p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Arquitetura</h1>
          <p className="text-sm text-muted-foreground">
            Como uma pergunta vira uma resposta com referência. Os parâmetros são os que estão em uso agora; clique numa caixa para ver os detalhes.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          configuração de
          <NativeSelect size="sm" value={workspaceId} onChange={(e) => setParams(e.target.value ? { w: e.target.value } : {}, { replace: true })} className="w-auto">
            <NativeSelectOption value="">padrão do sistema</NativeSelectOption>
            {(workspaces.data ?? []).map((w) => <NativeSelectOption key={w.id} value={w.id}>{w.name}</NativeSelectOption>)}
          </NativeSelect>
        </label>
      </div>

      {LANES.map((lane) => (
        <section key={lane.id} className="rounded-xl border bg-card/50 p-4">
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold">{lane.title}</h2>
            <span className="text-xs text-muted-foreground">{lane.subtitle}</span>
          </div>
          <ol className="flex flex-wrap items-stretch gap-y-3">
            {stages.filter((s) => s.lane === lane.id).map((stage, i, all) => (
              <li key={stage.id} className="flex items-center">
                <StageBox stage={stage} step={i + 1} active={stage.id === selected.id} onClick={() => setSelectedId(stage.id)} />
                {i < all.length - 1 && <ArrowRight className="mx-1 size-4 shrink-0 text-muted-foreground/60" aria-hidden />}
              </li>
            ))}
          </ol>
        </section>
      ))}

      <StageDetails stage={selected} />
      {selected.id === 'prompt' && <PromptViewer version={config.generation.promptVersion} />}

      <p className="text-xs text-muted-foreground">
        Stack: Node 24 + Hono · SQLite (FTS5 + sqlite-vec) · Docling · Transformers.js · Vercel AI SDK · React 19 + Vite. Voltar para os{' '}
        <Link to="/" className="underline">workspaces</Link>.
      </p>
    </div>
  );
}

function StatusDot({ status }: { status: Stage['status'] }) {
  if (!status) return null;
  if (status === 'ok') return <CircleCheck className="size-3.5 text-emerald-600" aria-label="no ar" />;
  if (status === 'down') return <CircleX className="size-3.5 text-destructive" aria-label="fora do ar" />;
  return <CircleOff className="size-3.5 text-muted-foreground" aria-label="não configurado" />;
}

function StageBox({ stage, step, active, onClick }: { stage: Stage; step: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex h-full w-44 flex-col gap-1 rounded-lg border bg-background p-2.5 text-left transition-colors hover:border-primary/60',
        active && 'border-primary bg-primary/5 ring-2 ring-primary/30',
      )}
    >
      <span className="flex items-center justify-between gap-2 text-sm font-medium">
        <span className="flex items-center gap-1.5">
          <span className={cn('inline-flex size-4.5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums', active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>{step}</span>
          {stage.title}
        </span>
        <StatusDot status={stage.status} />
      </span>
      <span className="text-xs leading-snug text-muted-foreground">{stage.summary}</span>
    </button>
  );
}

/** O prompt que vai ao modelo, na íntegra: RAG (qa.vN) e documento inteiro (baseline.vN). */
function PromptViewer({ version }: { version: string }) {
  const baseline = version.replace(/^qa\./, 'baseline.');
  const [name, setName] = useState(version);
  const current = name.startsWith('baseline.') ? baseline : version;
  const prompt = useQuery({ queryKey: ['prompt', current], queryFn: () => getPrompt(current) });
  const lines = (prompt.data?.text ?? '').split('\n');
  return (
    <section className="rounded-xl border p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Prompt do sistema, na íntegra</h3>
        <div className="flex gap-1" role="tablist">
          {([[version, 'RAG (algoritmo próprio)'], [baseline, 'Documento inteiro']] as const).map(([n, label]) => (
            <button
              key={n}
              type="button"
              role="tab"
              aria-selected={current === n}
              onClick={() => setName(n)}
              className={cn('rounded-md border px-2 py-1 text-xs', current === n ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground hover:bg-accent')}
            >
              {label} · <code>{n}</code>
            </button>
          ))}
        </div>
      </div>
      {prompt.isLoading && <p className="text-xs text-muted-foreground">Carregando…</p>}
      {prompt.error && <p className="text-xs text-destructive">Não foi possível carregar o prompt.</p>}
      {prompt.data && (
        <div className="max-h-[60vh] overflow-y-auto rounded-lg bg-muted/40 p-3 font-mono text-[13px] leading-relaxed">
          {lines.map((line, i) => {
            const rule = /^(\d+)\.\s/.exec(line);
            const heading = /^[A-ZÇÃÕÉ ]{6,}$/.test(line.trim());
            return (
              <p key={i} className={cn('whitespace-pre-wrap', heading && 'mt-2 font-semibold', rule && 'mt-1 flex gap-2', !line.trim() && 'h-2')}>
                {rule ? <><span className="w-6 shrink-0 text-right font-semibold text-primary">{rule[1]}.</span><span>{line.slice(rule[0].length)}</span></> : line}
              </p>
            );
          })}
        </div>
      )}
    </section>
  );
}

function StageDetails({ stage }: { stage: Stage }) {
  return (
    <section className="grid gap-4 rounded-xl border p-4 md:grid-cols-[minmax(0,1fr)_280px]">
      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          {stage.title}
          <Badge variant="secondary" className="font-normal">{LANES.find((l) => l.id === stage.lane)?.title}</Badge>
        </h3>
        {stage.details.map((d, i) => <p key={i} className="text-sm leading-relaxed">{d}</p>)}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground">
          <FileCode2 className="size-3.5" aria-hidden />
          {stage.code.map((c) => <code key={c} className="rounded bg-muted px-1 py-0.5">{c}</code>)}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 self-start rounded-lg bg-muted/50 p-3 text-xs">
        {stage.params.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-medium">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
