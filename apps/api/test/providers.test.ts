import { describe, expect, it } from 'vitest';
import type { LlmConfig } from '@editais/shared';
import { describeError, makeModel, providerLabel, resolveLlmConfig, testConnection } from '../src/llm/providers.ts';

const fallback: LlmConfig = { kind: 'openai-compatible', baseURL: 'https://api.z.ai/api/paas/v4', model: 'glm-4.7-flash', apiKey: 'server-secret' };

describe('resolveLlmConfig', () => {
  it('sem X-LLM-Provider → fallback inteiro', () => {
    expect(resolveLlmConfig({}, fallback)).toEqual(fallback);
    expect(resolveLlmConfig(new Headers(), fallback)).toEqual(fallback);
    expect(resolveLlmConfig({ 'x-llm-provider': '  ' }, fallback)).toEqual(fallback);
  });

  it('lê os headers (Headers do fetch e objeto plano, case-insensitive)', () => {
    const expected: LlmConfig = { kind: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-user' };
    expect(resolveLlmConfig(new Headers({ 'X-LLM-Provider': 'anthropic', 'X-LLM-Model': 'claude-sonnet-5', 'X-LLM-Key': 'sk-user' }), fallback)).toEqual(expected);
    expect(resolveLlmConfig({ 'X-Llm-Provider': 'Anthropic', 'X-LLM-MODEL': 'claude-sonnet-5', 'x-llm-key': 'sk-user' }, fallback)).toEqual(expected);
    expect(resolveLlmConfig({ 'x-llm-provider': 'openai-compatible', 'x-llm-base-url': 'http://localhost:11434/v1', 'x-llm-model': 'qwen3:8b' }, fallback)).toEqual({
      kind: 'openai-compatible', baseURL: 'http://localhost:11434/v1', model: 'qwen3:8b',
    });
  });

  it('herda modelo/chave do fallback só quando provedor e baseURL coincidem', () => {
    expect(resolveLlmConfig({ 'x-llm-provider': 'openai-compatible' }, fallback)).toEqual(fallback);
    expect(resolveLlmConfig({ 'x-llm-provider': 'openai-compatible', 'x-llm-model': 'glm-5.3' }, fallback)).toEqual({ ...fallback, model: 'glm-5.3' });
    // Outro endpoint: a chave do servidor NÃO vaza; sem modelo → erro de validação.
    expect(() => resolveLlmConfig({ 'x-llm-provider': 'openai-compatible', 'x-llm-base-url': 'http://evil.example/v1' }, fallback)).toThrow();
    const other = resolveLlmConfig({ 'x-llm-provider': 'openai-compatible', 'x-llm-base-url': 'http://localhost:1234/v1', 'x-llm-model': 'local' }, fallback);
    expect(other.apiKey).toBeUndefined();
  });

  it('rejeita provedor desconhecido e baseURL inválida', () => {
    expect(() => resolveLlmConfig({ 'x-llm-provider': 'bard', 'x-llm-model': 'x' }, fallback)).toThrow();
    expect(() => resolveLlmConfig({ 'x-llm-provider': 'openai', 'x-llm-model': 'gpt-5', 'x-llm-base-url': 'not a url' }, fallback)).toThrow();
  });
});

describe('makeModel', () => {
  it('instancia um adaptador para cada kind sem chamar a rede', () => {
    const cases: LlmConfig[] = [
      { kind: 'mock', model: 'mock-1' },
      { kind: 'anthropic', model: 'claude-sonnet-5', apiKey: 'k' },
      { kind: 'openai', model: 'gpt-5', apiKey: 'k' },
      { kind: 'google', model: 'gemini-3.8-flash', apiKey: 'k' },
      { kind: 'openai-compatible', model: 'qwen3:8b', baseURL: 'http://localhost:11434/v1' },
    ];
    for (const cfg of cases) {
      const model = makeModel(cfg) as { modelId: string; specificationVersion: string };
      expect(model.modelId).toBe(cfg.model);
      expect(model.specificationVersion).toBe('v4');
    }
    expect(() => makeModel({ kind: 'openai-compatible', model: 'x' })).toThrow(/baseURL/);
  });
});

describe('providerLabel / describeError', () => {
  it('rótulo sem chave; openai-compatible inclui o host', () => {
    expect(providerLabel({ kind: 'anthropic', model: 'claude-sonnet-5', apiKey: 'segredo' })).toBe('anthropic/claude-sonnet-5');
    expect(providerLabel(fallback)).toBe('openai-compatible(api.z.ai)/glm-4.7-flash');
    expect(providerLabel({ kind: 'mock', model: 'mock-1' })).toBe('mock/mock-1');
  });

  it('redige a chave na mensagem de erro', () => {
    const msg = describeError(new Error('401 for key server-secret'), fallback);
    expect(msg).not.toContain('server-secret');
    expect(msg).toContain('[redacted]');
  });
});

describe('testConnection', () => {
  it('mock responde ok com latência', async () => {
    const r = await testConnection({ kind: 'mock', model: 'mock-1' });
    expect(r).toMatchObject({ ok: true, model: 'mock-1' });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.error).toBeUndefined();
  });

  it('endpoint inacessível → ok=false com erro descritivo (sem a chave)', async () => {
    const r = await testConnection({ kind: 'openai-compatible', model: 'x', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'chave-secreta' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.error).not.toContain('chave-secreta');
  });
});
