import fs from 'node:fs';
import path from 'node:path';
import { generateText, streamText } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeError, createClaudeCodeModel, defaultClaudeCli } from '../src/llm/claude-code.ts';
import { cliOverheadMs } from '../src/llm/expand.ts';
import { makeModel, providerLabel, resolveLlmConfig } from '../src/llm/providers.ts';

const fake = { command: process.execPath, args: [path.join(import.meta.dirname, 'fixtures', 'fake-claude.mjs')] };

describe('provedor claude-code (CLI headless)', () => {
  it('gera: instruções vão no arquivo de sistema, a pergunta no stdin, o modelo no --model; usage soma cache', async () => {
    const r = await generateText({ model: createClaudeCodeModel('sonnet', fake), system: 'Responda em PT.', prompt: 'Qual o prazo?' });
    expect(r.text).toBe('[sonnet] sistema=Responda em PT. prompt=Qual o prazo?');
    expect(r.usage.inputTokens).toBe(13);
    expect(r.usage.outputTokens).toBe(5);
    expect(r.finishReason).toBe('stop');
    // tempo de relógio da chamada e tempo do turno dentro do CLI (a diferença é a subida do processo)
    const t = r.finalStep.providerMetadata?.['claude-code'] as { wallMs: number; cliMs: number; apiMs: number };
    expect(t.cliMs).toBe(1);
    expect(t.apiMs).toBe(1);
    expect(t.wallMs).toBeGreaterThan(1);
    expect(cliOverheadMs(r.finalStep.providerMetadata)).toBe(t.wallMs - 1);
    expect(cliOverheadMs(undefined)).toBe(0);
  });

  it('EPERM ao limpar o diretório temporário não derruba a resposta (Windows segura o cwd do CLI)', async () => {
    const eperm = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM, Permission denied'), { code: 'EPERM' });
    });
    try {
      const r = await generateText({ model: createClaudeCodeModel('sonnet', fake), prompt: 'Qual o prazo?' });
      expect(r.text).toBe('[sonnet] sistema= prompt=Qual o prazo?');
      expect(eperm).toHaveBeenCalled();
    } finally {
      eperm.mockRestore();
    }
  });

  it('transmite os deltas do stream-json na ordem e termina com usage', async () => {
    const s = streamText({ model: createClaudeCodeModel('opus', fake), prompt: 'Oi' });
    let text = '';
    for await (const delta of s.textStream) text += delta;
    expect(text).toBe('[opus] sistema= prompt=Oi');
    expect((await s.usage).outputTokens).toBe(5);
    expect(cliOverheadMs((await s.finalStep).providerMetadata)).toBeGreaterThan(0);
  });

  it('erros do CLI viram ClaudeCodeError com código: sem login, limite de uso, saída anormal, binário ausente', async () => {
    const model = createClaudeCodeModel('sonnet', fake);
    await expect(generateText({ model, prompt: 'FALHA-LOGIN' })).rejects.toMatchObject({ name: 'ClaudeCodeError', code: 'not_logged_in' });
    await expect(generateText({ model, prompt: 'LIMITE' })).rejects.toMatchObject({ code: 'usage_limit' });
    await expect(generateText({ model, prompt: 'CRASH', maxRetries: 0 })).rejects.toMatchObject({ code: 'cli', message: expect.stringContaining('código 3') });
    const missing = createClaudeCodeModel('sonnet', { command: path.join(import.meta.dirname, 'nao-existe.exe'), args: [] });
    await expect(generateText({ model: missing, prompt: 'x', maxRetries: 0 })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('CLAUDE_CLI_PATH: caminho do binário, ou off para desativar; sem variável usa `claude` do PATH; em produção fica desligado', () => {
    const before = process.env.CLAUDE_CLI_PATH;
    const env = process.env.NODE_ENV;
    try {
      delete process.env.CLAUDE_CLI_PATH;
      expect(defaultClaudeCli()).toEqual({ command: 'claude', args: [] });
      process.env.CLAUDE_CLI_PATH = 'C:\\apps\\claude.exe';
      expect(defaultClaudeCli().command).toBe('C:\\apps\\claude.exe');
      process.env.CLAUDE_CLI_PATH = 'off';
      expect(() => defaultClaudeCli()).toThrow(ClaudeCodeError);
      delete process.env.CLAUDE_CLI_PATH;
      process.env.NODE_ENV = 'production';
      expect(() => defaultClaudeCli()).toThrow(/BYOK/);
      process.env.CLAUDE_CLI_PATH = 'claude';
      expect(defaultClaudeCli().command).toBe('claude');
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CLI_PATH;
      else process.env.CLAUDE_CLI_PATH = before;
      process.env.NODE_ENV = env;
    }
  });

  it('entra pelo LlmConfig sem chave: header X-LLM-Provider: claude-code, rótulo e fábrica', () => {
    const cfg = resolveLlmConfig({ 'x-llm-provider': 'claude-code', 'x-llm-model': 'haiku' }, { kind: 'mock', model: 'mock-1' });
    expect(cfg).toEqual({ kind: 'claude-code', model: 'haiku' });
    expect(providerLabel(cfg)).toBe('claude-code/haiku');
    expect(makeModel(cfg)).toMatchObject({ provider: 'claude-code', modelId: 'haiku' });
  });
});
