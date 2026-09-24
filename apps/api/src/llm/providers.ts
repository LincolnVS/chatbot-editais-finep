/** Fábrica de modelos do AI SDK a partir de um LlmConfig (a chave chega por request e não é persistida). */
import type { LanguageModel } from 'ai';
import { APICallError, LoadAPIKeyError, NoSuchModelError, RetryError, generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { LlmConfig, LLM_HEADERS } from '@editais/shared';
import { ClaudeCodeError, createClaudeCodeModel } from './claude-code.ts';
import { createMockModel } from './mock.ts';

const TEST_TIMEOUT_MS = 20_000;

export function makeModel(cfg: LlmConfig): LanguageModel {
  switch (cfg.kind) {
    case 'mock':
      return createMockModel(cfg.model);
    case 'claude-code':
      return createClaudeCodeModel(cfg.model);
    case 'anthropic':
      return createAnthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(cfg.model);
    case 'openai':
      return createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(cfg.model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(cfg.model);
    case 'openai-compatible': {
      if (!cfg.baseURL) throw new Error("Provedor 'openai-compatible' exige baseURL (ex.: http://localhost:11434/v1).");
      // Sem apiKey o adaptador simplesmente não envia Authorization (Ollama/LM Studio). includeUsage → tokens no streaming.
      return createOpenAICompatible({ name: 'openai-compatible', baseURL: cfg.baseURL, apiKey: cfg.apiKey, includeUsage: true })(cfg.model);
    }
  }
}

/** Sem `X-LLM-Provider` → `fallback` inteiro. */
export function resolveLlmConfig(headers: Headers | Record<string, string | undefined>, fallback: LlmConfig): LlmConfig {
  const kind = readHeader(headers, LLM_HEADERS.kind)?.toLowerCase();
  if (!kind) return fallback;

  const baseURL = readHeader(headers, LLM_HEADERS.baseURL);
  const model = readHeader(headers, LLM_HEADERS.model);
  const apiKey = readHeader(headers, LLM_HEADERS.apiKey);
  const sameProvider = kind === fallback.kind && (baseURL === undefined || baseURL === fallback.baseURL);

  return LlmConfig.parse({
    kind,
    baseURL: baseURL ?? (sameProvider ? fallback.baseURL : undefined),
    model: model ?? (sameProvider ? fallback.model : undefined),
    apiKey: apiKey ?? (sameProvider ? fallback.apiKey : undefined),
  });
}

function readHeader(headers: Headers | Record<string, string | undefined>, name: string): string | undefined {
  let value: string | undefined | null;
  if (typeof (headers as Headers).get === 'function') {
    value = (headers as Headers).get(name);
  } else {
    const lower = name.toLowerCase();
    const key = Object.keys(headers).find((k) => k.toLowerCase() === lower);
    value = key === undefined ? undefined : (headers as Record<string, string | undefined>)[key];
  }
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function testConnection(cfg: LlmConfig): Promise<{ ok: boolean; latencyMs: number; model: string; error?: string }> {
  const started = performance.now();
  try {
    await generateText({
      model: makeModel(cfg),
      prompt: 'Responda apenas OK.',
      maxOutputTokens: 256,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    return { ok: true, latencyMs: Math.round(performance.now() - started), model: cfg.model };
  } catch (err) {
    return { ok: false, latencyMs: Math.round(performance.now() - started), model: cfg.model, error: describeError(err, cfg) };
  }
}

/** Erro vindo do provedor/da configuração BYOK (chave inválida, modelo inexistente, endpoint fora do ar, retries esgotados). */
export function isProviderError(err: unknown): boolean {
  return APICallError.isInstance(err) || RetryError.isInstance(err) || LoadAPIKeyError.isInstance(err) || NoSuchModelError.isInstance(err) || err instanceof ClaudeCodeError;
}

/** Mensagem de erro curta e sem a chave (redigida caso algum provedor a ecoe). */
export function describeError(err: unknown, cfg: LlmConfig): string {
  let message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (err instanceof Error && err.name === 'TimeoutError') message = `Tempo esgotado após ${TEST_TIMEOUT_MS / 1000} s`;
  if (cfg.apiKey) message = message.split(cfg.apiKey).join('[redacted]');
  return message.length > 500 ? `${message.slice(0, 499)}…` : message;
}

/** Rótulo seguro para logs/persistência: "anthropic/claude-sonnet-5" (sem chave); openai-compatible inclui o host. */
export function providerLabel(cfg: LlmConfig): string {
  if (cfg.kind === 'openai-compatible' && cfg.baseURL) {
    let host = cfg.baseURL;
    try {
      host = new URL(cfg.baseURL).host;
    } catch {
      /* baseURL já validada pelo zod; mantém o texto cru se algo escapar */
    }
    return `${cfg.kind}(${host})/${cfg.model}`;
  }
  return `${cfg.kind}/${cfg.model}`;
}
