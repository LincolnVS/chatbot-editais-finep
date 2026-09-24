/**
 * Provedor `claude-code`: responde pelo CLI do Claude Code em modo headless (`claude -p`), usando o login/assinatura
 * desta máquina — sem chave de API. Uso local, de desenvolvimento e pesquisa (o CLI é de uso pessoal, não de produto).
 * Prompt do usuário via stdin, instruções via `--system-prompt-file`, sem ferramentas, um turno, sem persistir sessão.
 * `--setting-sources ""` + `--strict-mcp-config` isolam a chamada (sem hooks, MCP, agentes ou CLAUDE.md do usuário). `--bare` NÃO serve: também pula o login.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LanguageModel } from 'ai';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
  SharedV4Warning,
} from '@ai-sdk/provider';

export type ClaudeCli = { command: string; args: string[] };

/** Caminho do CLI: `CLAUDE_CLI_PATH` (ex.: o claude.exe do app Claude Desktop), `claude` no PATH, ou `off` para desativar. Em produção (NODE_ENV) só liga com CLAUDE_CLI_PATH explícito: o produto é BYOK. */
export function defaultClaudeCli(): ClaudeCli {
  const configured = process.env.CLAUDE_CLI_PATH?.trim();
  if (configured && ['off', '0', 'false'].includes(configured.toLowerCase())) throw new ClaudeCodeError('disabled', 'Provedor claude-code desativado neste servidor (CLAUDE_CLI_PATH=off)');
  if (!configured && process.env.NODE_ENV === 'production') throw new ClaudeCodeError('disabled', 'Provedor claude-code é só para desenvolvimento local; em produção use um provedor com chave (BYOK)');
  return { command: configured || 'claude', args: [] };
}

export type ClaudeCliStatus = { available: boolean; command?: string; reason?: string };

/** O CLI existe nesta máquina? (caminho configurado ou `claude` no PATH, com .exe/.cmd no Windows). Não testa o login. */
export function claudeCliStatus(): ClaudeCliStatus {
  let cli: ClaudeCli;
  try {
    cli = defaultClaudeCli();
  } catch (e) {
    return { available: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const found = findExecutable(cli.command);
  if (found) return { available: true, command: found };
  return { available: false, reason: `CLI do Claude Code não encontrado (${cli.command}); instale-o (irm https://claude.ai/install.ps1 | iex), faça login com \`claude\`, ou aponte CLAUDE_CLI_PATH` };
}

function findExecutable(command: string): string | null {
  if (/[\\/]/.test(command)) return fs.existsSync(command) ? command : null;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export type ClaudeCodeErrorCode = 'disabled' | 'not_found' | 'not_logged_in' | 'usage_limit' | 'cli';

export class ClaudeCodeError extends Error {
  readonly code: ClaudeCodeErrorCode;
  constructor(code: ClaudeCodeErrorCode, message: string) {
    super(message);
    this.name = 'ClaudeCodeError';
    this.code = code;
  }
}

/** Saída de `claude -p --output-format json` (campos usados). */
type CliResult = {
  type?: string;
  is_error?: boolean;
  result?: string;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  total_cost_usd?: number;
  /** Tempo do turno dentro do CLI (depois de o processo subir); a diferença para o relógio é a subida. */
  duration_ms?: number;
  duration_api_ms?: number;
};

type CliStreamLine = CliResult & { event?: { type?: string; delta?: { type?: string; text?: string } } };

const TEXT_ID = 'claude-code-text';

export function createClaudeCodeModel(modelId: string, cli: ClaudeCli = defaultClaudeCli()): LanguageModel {
  return new ClaudeCodeModel(modelId, cli);
}

class ClaudeCodeModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider = 'claude-code';
  readonly modelId: string;
  readonly supportedUrls = {};
  private readonly cli: ClaudeCli;

  constructor(modelId: string, cli: ClaudeCli) {
    this.modelId = modelId;
    this.cli = cli;
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const { system, user, warnings } = splitPrompt(options);
    const t0 = performance.now();
    const stdout = await this.run(['--output-format', 'json'], system, user, options.abortSignal);
    const result = parseJson<CliResult>(lastJsonLine(stdout));
    throwIfError(result);
    return { content: [{ type: 'text', text: result.result ?? '' }], finishReason: finishReason(result.stop_reason), usage: usage(result), warnings, providerMetadata: cliTiming(result, t0) };
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const { system, user, warnings } = splitPrompt(options);
    const t0 = performance.now();
    const stdout = await this.run(['--output-format', 'stream-json', '--verbose', '--include-partial-messages'], system, user, options.abortSignal);
    // O CLI só termina depois da resposta inteira; entregamos os deltas na ordem em que vieram (ou o texto final, se não houve parciais).
    const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings }, { type: 'text-start', id: TEXT_ID }];
    let streamed = false;
    let result: CliResult | undefined;
    for (const line of stdout.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      const item = parseJson<CliStreamLine>(line);
      if (item.type === 'stream_event' && item.event?.type === 'content_block_delta' && item.event.delta?.type === 'text_delta' && item.event.delta.text) {
        parts.push({ type: 'text-delta', id: TEXT_ID, delta: item.event.delta.text });
        streamed = true;
      } else if (item.type === 'result') {
        result = item;
      }
    }
    if (!result) throw new ClaudeCodeError('cli', 'O CLI do Claude Code terminou sem a linha de resultado');
    throwIfError(result);
    if (!streamed && result.result) parts.push({ type: 'text-delta', id: TEXT_ID, delta: result.result });
    parts.push({ type: 'text-end', id: TEXT_ID }, { type: 'finish', finishReason: finishReason(result.stop_reason), usage: usage(result), providerMetadata: cliTiming(result, t0) });
    return {
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start: (controller) => {
          for (const p of parts) controller.enqueue(p);
          controller.close();
        },
      }),
    };
  }

  /** Roda `claude -p` com o prompt no stdin e devolve o stdout inteiro. */
  private async run(formatArgs: string[], system: string, user: string, abortSignal?: AbortSignal): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editais-claude-'));
    const systemFile = path.join(dir, 'system.md');
    fs.writeFileSync(systemFile, system);
    const args = [...this.cli.args, '-p', ...formatArgs, '--model', this.modelId, '--tools', '', '--max-turns', '1', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--system-prompt-file', systemFile];
    try {
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(this.cli.command, args, { cwd: dir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: abortSignal });
        let out = '';
        let err = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { err += chunk; });
        child.on('error', (e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') reject(new ClaudeCodeError('not_found', `CLI do Claude Code não encontrado (${this.cli.command}); instale-o ou aponte CLAUDE_CLI_PATH`));
          else if (e.name === 'AbortError') reject(new ClaudeCodeError('cli', 'Tempo esgotado ao chamar o CLI do Claude Code'));
          else reject(new ClaudeCodeError('cli', `Falha ao executar o CLI do Claude Code: ${e.message}`));
        });
        child.on('close', (code) => {
          if (code === 0 || out.trim().startsWith('{')) resolve(out);
          else reject(new ClaudeCodeError('cli', `CLI do Claude Code saiu com código ${code}: ${(err || out).trim().slice(0, 400)}`));
        });
        child.stdin.on('error', () => { /* o processo pode fechar antes de ler o stdin; o erro real vem em close */ });
        child.stdin.end(user);
      });
    } finally {
      removeTempDir(dir);
    }
  }
}

/**
 * Limpeza do diretório temporário da chamada. No Windows o processo do CLI (que roda com cwd nele) às vezes ainda segura
 * o diretório alguns milissegundos depois de sair, e o rm dá EPERM. Estando no `finally`, esse erro substituía a resposta
 * que tinha vindo certa. Tenta de novo com espera e, se ainda assim falhar, deixa a sobra no temp.
 */
function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // sobra no temp do sistema: não vale perder uma resposta por isso
  }
}

/** Mensagens de sistema → instruções; usuário/assistente → texto do stdin (uma pergunta, ou a conversa em texto quando há mais de uma mensagem). */
function splitPrompt(options: LanguageModelV4CallOptions): { system: string; user: string; warnings: SharedV4Warning[] } {
  const warnings: SharedV4Warning[] = [];
  const system: string[] = [];
  const turns: Array<{ role: string; text: string }> = [];
  for (const message of options.prompt) {
    if (message.role === 'system') system.push(message.content);
    else if (message.role === 'user' || message.role === 'assistant') {
      const text = message.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
      if (message.content.some((p) => p.type !== 'text')) warnings.push({ type: 'unsupported', feature: 'non-text content', details: 'claude-code: partes não textuais ignoradas' });
      turns.push({ role: message.role, text });
    }
  }
  if (options.temperature !== undefined) warnings.push({ type: 'unsupported', feature: 'temperature' });
  if (options.responseFormat && options.responseFormat.type !== 'text') warnings.push({ type: 'unsupported', feature: 'responseFormat' });
  const user = turns.length === 1 ? turns[0]!.text : turns.map((t) => `${t.role === 'user' ? 'Usuário' : 'Assistente'}:\n${t.text}`).join('\n\n');
  return { system: system.join('\n\n'), user, warnings };
}

/** Ambiente do filho sem as variáveis da sessão do Claude Code que estiver rodando este servidor (evita "sessão aninhada"). */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')) env[k] = v;
  return env;
}

function lastJsonLine(stdout: string): string {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  if (lines.length === 0) throw new ClaudeCodeError('cli', `O CLI do Claude Code não devolveu JSON: ${stdout.trim().slice(0, 300)}`);
  return lines.at(-1)!;
}

function parseJson<T>(line: string): T {
  try {
    return JSON.parse(line) as T;
  } catch {
    throw new ClaudeCodeError('cli', `Linha inválida na saída do CLI do Claude Code: ${line.slice(0, 200)}`);
  }
}

function throwIfError(result: CliResult): void {
  if (!result.is_error) return;
  const text = result.result ?? 'erro sem mensagem';
  if (/not logged in|\/login/i.test(text)) throw new ClaudeCodeError('not_logged_in', `CLI do Claude Code sem login: rode \`claude\` e depois \`/login\` uma vez nesta máquina (${text})`);
  if (/usage limit|hit your limit|rate limit/i.test(text)) throw new ClaudeCodeError('usage_limit', `Limite de uso da assinatura: ${text}`);
  throw new ClaudeCodeError('cli', `CLI do Claude Code: ${text}`);
}

function finishReason(stop: string | null | undefined): LanguageModelV4FinishReason {
  const raw = stop ?? undefined;
  if (stop === 'max_tokens') return { unified: 'length', raw };
  return { unified: 'stop', raw };
}

/**
 * Metadados do provedor: tempo de relógio da chamada e tempo que o CLI passou executando o turno (`duration_ms`,
 * medido depois de o processo subir). A diferença é a subida do processo, que não existe com chave própria ou modelo local.
 * (`duration_api_ms` soma as requisições à API e pode passar de `duration_ms`; fica só como informação.)
 */
function cliTiming(result: CliResult, t0: number): Record<string, Record<string, number>> {
  const wallMs = Math.round(performance.now() - t0);
  return {
    'claude-code': {
      wallMs,
      ...(result.duration_ms === undefined ? {} : { cliMs: Math.round(result.duration_ms) }),
      ...(result.duration_api_ms === undefined ? {} : { apiMs: Math.round(result.duration_api_ms) }),
    },
  };
}

function usage(result: CliResult): LanguageModelV4Usage {
  const u = result.usage ?? {};
  const noCache = u.input_tokens;
  const cacheRead = u.cache_read_input_tokens;
  const cacheWrite = u.cache_creation_input_tokens;
  const total = noCache === undefined && cacheRead === undefined && cacheWrite === undefined ? undefined : (noCache ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    inputTokens: { total, noCache, cacheRead, cacheWrite },
    outputTokens: { total: u.output_tokens, text: u.output_tokens, reasoning: undefined },
    ...(result.total_cost_usd === undefined ? {} : { raw: { totalCostUsd: result.total_cost_usd } }),
  };
}
