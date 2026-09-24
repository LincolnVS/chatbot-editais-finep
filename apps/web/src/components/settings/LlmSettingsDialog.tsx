import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { getLlmDefaults, testLlm, type LlmTestResult } from '@/lib/api';
import { CLAUDE_MODELS, LLM_PRESETS, OLLAMA_URL, enabledSources, getLlmSettings, setLlmSettings, toLlmConfig, type LlmSettings, type LlmSource } from '@/lib/llm-settings';
import { cn } from '@/lib/utils';

type Props = { open: boolean; onOpenChange: (open: boolean) => void };
type TestState = { state: 'idle' } | { state: 'running' } | { state: 'done'; result: LlmTestResult };

/** T3 — provedores da sessão: cada origem (CLI local, chave própria, Ollama) é habilitada aqui; o chat só lista as habilitadas. */
export function LlmSettingsDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {/* remontado a cada abertura: o rascunho parte sempre do que está salvo */}
        {open && <LlmSettingsForm onOpenChange={onOpenChange} />}
      </DialogContent>
    </Dialog>
  );
}

function LlmSettingsForm({ onOpenChange }: Pick<Props, 'onOpenChange'>) {
  const [draft, setDraft] = useState<LlmSettings>(getLlmSettings);
  const [presetId, setPresetId] = useState<string>(() => {
    const b = getLlmSettings().byok;
    return LLM_PRESETS.find((p) => p.kind === b.kind && (p.baseURL || '') === (b.baseURL || ''))?.id ?? '';
  });
  const [tests, setTests] = useState<Record<LlmSource, TestState>>({ 'claude-code': { state: 'idle' }, byok: { state: 'idle' }, ollama: { state: 'idle' } });
  const defaults = useQuery({ queryKey: ['llm-defaults'], queryFn: getLlmDefaults });
  const cli = defaults.data?.claudeCli;
  const preset = LLM_PRESETS.find((p) => p.id === presetId);

  function applyPreset(id: string) {
    setPresetId(id);
    const p = LLM_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setDraft((d) => ({ ...d, byok: { ...d.byok, kind: p.kind, baseURL: p.baseURL, model: p.model || d.byok.model, apiKey: p.needsKey ? d.byok.apiKey : '' } }));
  }

  async function runTest(source: LlmSource) {
    setTests((t) => ({ ...t, [source]: { state: 'running' } }));
    let result: LlmTestResult;
    try {
      result = await testLlm(toLlmConfig(draft, source));
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    setTests((t) => ({ ...t, [source]: { state: 'done', result } }));
  }

  function save() {
    const b = draft.byok;
    if (b.enabled && !b.model.trim()) return toast.error('Minha chave: informe o modelo.');
    if (b.enabled && b.kind === 'openai-compatible' && !b.baseURL.trim()) return toast.error('Minha chave: provedor compatível com OpenAI exige a URL base.');
    if (draft.ollama.enabled && !draft.ollama.model.trim()) return toast.error('Ollama: informe o modelo (ex.: qwen3:8b).');
    if (draft.claude.enabled && draft.claude.models.length === 0) return toast.error('Claude Code: marque ao menos um modelo.');
    const next: LlmSettings = {
      ...draft,
      ollama: { ...draft.ollama, url: draft.ollama.url.trim() || OLLAMA_URL, model: draft.ollama.model.trim() },
      byok: { ...b, model: b.model.trim(), baseURL: b.baseURL.trim(), apiKey: b.apiKey.trim() },
    };
    if (enabledSources(next).length === 0) return toast.error('Habilite ao menos uma origem.');
    setLlmSettings(next);
    toast.success('Provedores salvos nesta aba.');
    onOpenChange(false);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Provedores de LLM</DialogTitle>
        <DialogDescription>Habilite as origens que podem responder nesta sessão; o chat lista só as habilitadas. Nada é gravado no servidor.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-3">
        <SourceCard
          title="Claude Code (claude -p)"
          hint="CLI do Claude Code instalado e logado nesta máquina — sua assinatura, sem chave. Só desenvolvimento e pesquisa."
          enabled={draft.claude.enabled}
          onEnabled={(v) => setDraft((d) => ({ ...d, claude: { ...d.claude, enabled: v } }))}
          test={tests['claude-code']}
          onTest={() => runTest('claude-code')}
        >
          <div className="grid gap-1.5">
            <Label>Modelos disponíveis no chat</Label>
            <div className="flex flex-wrap gap-3">
              {CLAUDE_MODELS.map((m) => (
                <label key={m} className="flex cursor-pointer items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.claude.models.includes(m)}
                    onChange={(e) => setDraft((d) => ({ ...d, claude: { ...d.claude, models: CLAUDE_MODELS.filter((x) => (x === m ? e.target.checked : d.claude.models.includes(x))) } }))}
                  />
                  {m}
                </label>
              ))}
            </div>
          </div>
          <p className={cn('text-xs', cli?.available ? 'text-muted-foreground' : 'text-destructive')}>
            {!cli ? 'Verificando o CLI…' : cli.available ? `CLI encontrado: ${cli.command}` : `CLI indisponível — ${cli.reason}`}
          </p>
        </SourceCard>

        <SourceCard
          title="Minha chave (BYOK)"
          hint="Sua chave de API. Fica apenas nesta aba do navegador e é enviada a cada pergunta; o servidor não a guarda nem registra."
          enabled={draft.byok.enabled}
          onEnabled={(v) => setDraft((d) => ({ ...d, byok: { ...d.byok, enabled: v } }))}
          test={tests.byok}
          onTest={() => runTest('byok')}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="llm-preset">Provedor</Label>
            <NativeSelect id="llm-preset" value={presetId} onChange={(e) => applyPreset(e.target.value)}>
              <NativeSelectOption value="">Personalizado…</NativeSelectOption>
              {LLM_PRESETS.map((p) => <NativeSelectOption key={p.id} value={p.id}>{p.label}</NativeSelectOption>)}
            </NativeSelect>
            {preset?.hint && <p className="text-xs text-muted-foreground">{preset.hint}</p>}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="llm-kind">Tipo de API</Label>
              <NativeSelect id="llm-kind" value={draft.byok.kind} onChange={(e) => setDraft((d) => ({ ...d, byok: { ...d.byok, kind: e.target.value as LlmSettings['byok']['kind'] } }))}>
                <NativeSelectOption value="openai-compatible">OpenAI-compatible</NativeSelectOption>
                <NativeSelectOption value="anthropic">Anthropic</NativeSelectOption>
                <NativeSelectOption value="openai">OpenAI</NativeSelectOption>
                <NativeSelectOption value="google">Google</NativeSelectOption>
                <NativeSelectOption value="mock">Simulado (mock)</NativeSelectOption>
              </NativeSelect>
            </div>
            <div className="col-span-2 grid gap-1.5">
              <Label htmlFor="llm-model">Modelo</Label>
              <Input id="llm-model" value={draft.byok.model} placeholder="ex.: openai/gpt-oss-120b" onChange={(e) => setDraft((d) => ({ ...d, byok: { ...d.byok, model: e.target.value } }))} />
            </div>
          </div>
          {draft.byok.kind !== 'mock' && (
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="llm-base">URL base {draft.byok.kind === 'openai-compatible' ? '' : '(opcional)'}</Label>
                <Input id="llm-base" value={draft.byok.baseURL} placeholder="https://api.groq.com/openai/v1" onChange={(e) => setDraft((d) => ({ ...d, byok: { ...d.byok, baseURL: e.target.value } }))} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="llm-key">Chave de API</Label>
                <Input id="llm-key" type="password" autoComplete="off" value={draft.byok.apiKey} onChange={(e) => setDraft((d) => ({ ...d, byok: { ...d.byok, apiKey: e.target.value } }))} />
              </div>
            </div>
          )}
        </SourceCard>

        <SourceCard
          title="Ollama (local)"
          hint="Modelo aberto rodando na sua máquina, sem chave. Rode `ollama pull <modelo>` antes."
          enabled={draft.ollama.enabled}
          onEnabled={(v) => setDraft((d) => ({ ...d, ollama: { ...d.ollama, enabled: v } }))}
          test={tests.ollama}
          onTest={() => runTest('ollama')}
        >
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="llm-ollama-url">URL</Label>
              <Input id="llm-ollama-url" value={draft.ollama.url} placeholder={OLLAMA_URL} onChange={(e) => setDraft((d) => ({ ...d, ollama: { ...d.ollama, url: e.target.value } }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="llm-ollama-model">Modelo</Label>
              <Input id="llm-ollama-model" value={draft.ollama.model} placeholder="qwen3:8b" onChange={(e) => setDraft((d) => ({ ...d, ollama: { ...d.ollama, model: e.target.value } }))} />
            </div>
          </div>
        </SourceCard>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
        <Button type="button" onClick={save}>Salvar</Button>
      </DialogFooter>
    </>
  );
}

/** Uma origem: título, interruptor de habilitar, campos (só quando habilitada) e teste de conexão. */
function SourceCard({ title, hint, enabled, onEnabled, test, onTest, children }: { title: string; hint: string; enabled: boolean; onEnabled: (v: boolean) => void; test: TestState; onTest: () => void; children: ReactNode }) {
  return (
    <section className={cn('rounded-lg border p-3', enabled ? 'bg-card' : 'bg-muted/30')}>
      <label className="flex cursor-pointer items-start gap-3">
        <Switch checked={enabled} onCheckedChange={onEnabled} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-xs text-muted-foreground">{hint}</span>
        </span>
      </label>
      {enabled && (
        <div className="mt-3 grid gap-3">
          {children}
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={onTest} disabled={test.state === 'running'}>
              {test.state === 'running' && <Loader2 className="size-3.5 animate-spin" />}
              Testar conexão
            </Button>
            {test.state === 'done' && (
              <Alert variant={test.result.ok ? 'default' : 'destructive'} className="flex-1 py-1.5">
                <AlertDescription className="flex items-center gap-2 text-xs">
                  {test.result.ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
                  {test.result.ok ? `Conectado: ${test.result.model} em ${test.result.latencyMs} ms` : `Falhou: ${test.result.error ?? 'erro desconhecido'}`}
                </AlertDescription>
              </Alert>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
