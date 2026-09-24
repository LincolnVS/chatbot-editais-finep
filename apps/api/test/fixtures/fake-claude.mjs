// Imita `claude -p` (json e stream-json) para os testes do provedor claude-code: ecoa modelo, sistema e prompt.
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const format = opt('--output-format') ?? 'text';
const model = opt('--model') ?? '?';
const system = fs.readFileSync(opt('--system-prompt-file'), 'utf8');
const prompt = fs.readFileSync(0, 'utf8');

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 };
let result;
if (prompt.includes('FALHA-LOGIN')) result = { type: 'result', is_error: true, result: 'Not logged in · Please run /login', usage };
else if (prompt.includes('LIMITE')) result = { type: 'result', is_error: true, result: "You've hit your usage limit. Resets at 3pm", usage };
else if (prompt.includes('CRASH')) { process.stderr.write('boom'); process.exit(3); }
else result = { type: 'result', subtype: 'success', is_error: false, result: `[${model}] sistema=${system.trim()} prompt=${prompt.trim()}`, stop_reason: 'end_turn', usage, total_cost_usd: 0.001, duration_ms: 1, duration_api_ms: 1 };

if (format === 'json') {
  process.stdout.write(JSON.stringify(result) + '\n');
} else {
  const lines = [{ type: 'system', subtype: 'init', model }];
  if (!result.is_error) {
    const half = Math.ceil(result.result.length / 2);
    for (const text of [result.result.slice(0, half), result.result.slice(half)]) lines.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  }
  lines.push(result);
  process.stdout.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
