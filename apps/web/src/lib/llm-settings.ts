/**
 * Provedor de LLM da sessão — três origens, cada uma habilitada ou não nas configurações: o CLI do Claude Code local
 * (`claude -p`, assinatura, sem chave), uma chave própria (BYOK) ou um Ollama local. O chat só lista o que está
 * habilitado. Tudo fica SOMENTE em sessionStorage do navegador e vai em cada requisição nos headers X-LLM-*.
 */
import { LLM_HEADERS, type LlmConfig } from '@editais/shared';
import { useSyncExternalStore } from 'react';

export type LlmSource = 'claude-code' | 'byok' | 'ollama';

export type LlmSettings = {
  /** Origem ativa (a que responde). */
  source: LlmSource;
  /** Modelo ativo do CLI (um dos habilitados). */
  claudeModel: string;
  claude: { enabled: boolean; models: string[] };
  ollama: { enabled: boolean; url: string; model: string };
  byok: { enabled: boolean; kind: LlmConfig['kind']; baseURL: string; model: string; apiKey: string };
};

export type LlmPreset = { id: string; label: string; kind: LlmConfig['kind']; baseURL: string; model: string; needsKey: boolean; hint?: string };

const COMPAT = 'openai-compatible';
const CLI = 'claude-code';

export const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'] as const;
export const OLLAMA_URL = 'http://localhost:11434/v1';

/** Provedores com chave (BYOK). Locais (Claude Code, Ollama) são origens à parte. */
export const LLM_PRESETS: LlmPreset[] = [
  { id: 'groq', label: 'Groq', kind: COMPAT, baseURL: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', needsKey: true, hint: 'Free tier: 8k tokens/min por modelo (suficiente para RAG; o baseline documento inteiro exige Dev Tier).' },
  { id: 'anthropic', label: 'Anthropic (Claude)', kind: 'anthropic', baseURL: '', model: 'claude-sonnet-5', needsKey: true },
  { id: 'openai', label: 'OpenAI', kind: 'openai', baseURL: '', model: 'gpt-5-mini', needsKey: true },
  { id: 'google', label: 'Google (Gemini)', kind: 'google', baseURL: '', model: 'gemini-3.8-flash', needsKey: true },
  { id: 'zai', label: 'GLM (Z.ai)', kind: COMPAT, baseURL: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3-flash', needsKey: true },
  { id: 'openrouter', label: 'OpenRouter', kind: COMPAT, baseURL: 'https://openrouter.ai/api/v1', model: 'openai/gpt-oss-120b', needsKey: true },
];

const STORAGE_KEY = 'editais.llm.v2';
export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  source: CLI,
  claudeModel: 'sonnet',
  claude: { enabled: true, models: ['sonnet'] },
  ollama: { enabled: false, url: OLLAMA_URL, model: 'qwen3:8b' },
  byok: { enabled: false, kind: COMPAT, baseURL: '', model: '', apiKey: '' },
};

let current: LlmSettings = load();
const listeners = new Set<() => void>();

function load(): LlmSettings {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LLM_SETTINGS;
    const saved = JSON.parse(raw) as Partial<LlmSettings>;
    return normalize({
      ...DEFAULT_LLM_SETTINGS,
      ...saved,
      claude: { ...DEFAULT_LLM_SETTINGS.claude, ...saved.claude },
      ollama: { ...DEFAULT_LLM_SETTINGS.ollama, ...saved.ollama },
      byok: { ...DEFAULT_LLM_SETTINGS.byok, ...saved.byok },
    });
  } catch {
    return DEFAULT_LLM_SETTINGS;
  }
}

/** Origens habilitadas (e utilizáveis), na ordem do chat. */
export function enabledSources(s: LlmSettings): LlmSource[] {
  const out: LlmSource[] = [];
  if (s.claude.enabled && s.claude.models.length > 0) out.push(CLI);
  if (s.byok.enabled && s.byok.model) out.push('byok');
  if (s.ollama.enabled && s.ollama.model) out.push('ollama');
  return out;
}

/** Garante que a origem e o modelo ativos estão entre os habilitados (senão cai no primeiro habilitado). */
export function normalize(s: LlmSettings): LlmSettings {
  const enabled = enabledSources(s);
  const source = enabled.includes(s.source) ? s.source : (enabled[0] ?? s.source);
  const claudeModel = s.claude.models.includes(s.claudeModel) ? s.claudeModel : (s.claude.models[0] ?? s.claudeModel);
  return { ...s, source, claudeModel };
}

export function getLlmSettings(): LlmSettings {
  return current;
}

export function setLlmSettings(next: LlmSettings): void {
  current = normalize(next);
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* sessionStorage indisponível: mantém só em memória */
  }
  for (const l of listeners) l();
}

export function useLlmSettings(): LlmSettings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getLlmSettings,
  );
}

/** LlmConfig (corpo de /api/llm/test e headers) de uma origem — a ativa por padrão. */
export function toLlmConfig(s: LlmSettings, source: LlmSource = s.source): LlmConfig {
  if (source === CLI) return { kind: CLI, model: s.claudeModel || 'sonnet' };
  if (source === 'ollama') return { kind: COMPAT, model: s.ollama.model, baseURL: s.ollama.url || OLLAMA_URL };
  const b = s.byok;
  return { kind: b.kind, model: b.model, ...(b.baseURL ? { baseURL: b.baseURL } : {}), ...(b.apiKey ? { apiKey: b.apiKey } : {}) };
}

/** Headers X-LLM-* para as rotas /ask, /chat, /llm/test e /eval/runs. */
export function llmHeaders(s: LlmSettings = current): Record<string, string> {
  const cfg = toLlmConfig(s);
  const h: Record<string, string> = { [LLM_HEADERS.kind]: cfg.kind, [LLM_HEADERS.model]: cfg.model };
  if (cfg.baseURL) h[LLM_HEADERS.baseURL] = cfg.baseURL;
  if (cfg.apiKey) h[LLM_HEADERS.apiKey] = cfg.apiKey;
  return h;
}

export function byokLabel(b: Pick<LlmSettings['byok'], 'kind' | 'baseURL'>): string {
  const preset = LLM_PRESETS.find((p) => p.kind === b.kind && (p.baseURL || '') === (b.baseURL || ''));
  return preset?.label ?? (b.kind === COMPAT ? hostOf(b.baseURL) : b.kind);
}

/** "Sonnet (Claude Code)": modelo primeiro, origem entre parênteses. */
export function modelLabel(model: string, origin: string): string {
  const name = /^[a-z]+$/.test(model) ? model.charAt(0).toUpperCase() + model.slice(1) : model;
  return `${name} (${origin})`;
}

/** Rótulo curto do provedor ativo para a barra superior. */
export function describeLlm(s: LlmSettings): string {
  if (s.source === CLI) return modelLabel(s.claudeModel || 'sonnet', 'Claude Code');
  if (s.source === 'ollama') return modelLabel(s.ollama.model || '?', 'Ollama');
  return s.byok.model ? modelLabel(s.byok.model, byokLabel(s.byok)) : 'Provedor não configurado';
}

/** Escolhas do chat: só o que está habilitado nas configurações. */
export type LlmChoice = { id: string; label: string; apply: (s: LlmSettings) => LlmSettings };

export function llmChoices(s: LlmSettings): LlmChoice[] {
  const out: LlmChoice[] = [];
  if (s.claude.enabled) for (const m of s.claude.models) out.push({ id: `${CLI}:${m}`, label: modelLabel(m, 'Claude Code'), apply: (x) => ({ ...x, source: CLI, claudeModel: m }) });
  if (s.byok.enabled && s.byok.model) out.push({ id: 'byok', label: modelLabel(s.byok.model, byokLabel(s.byok)), apply: (x) => ({ ...x, source: 'byok' }) });
  if (s.ollama.enabled && s.ollama.model) out.push({ id: 'ollama', label: modelLabel(s.ollama.model, 'Ollama'), apply: (x) => ({ ...x, source: 'ollama' }) });
  return out;
}

export function currentChoiceId(s: LlmSettings): string {
  return s.source === CLI ? `${CLI}:${s.claudeModel || 'sonnet'}` : s.source;
}

/* pedido para abrir o diálogo de configuração (o diálogo mora no AppShell; o chat só pede) */
let openRequests = 0;
const openListeners = new Set<() => void>();

export function requestLlmSettings(): void {
  openRequests++;
  for (const l of openListeners) l();
}

export function useLlmSettingsRequests(): number {
  return useSyncExternalStore(
    (cb) => {
      openListeners.add(cb);
      return () => openListeners.delete(cb);
    },
    () => openRequests,
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url || COMPAT;
  }
}
