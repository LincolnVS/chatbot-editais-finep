import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** SHA-256 hex de string ou bytes (isomórfico: Node e navegador). */
export function sha256(input: string | Uint8Array): string {
  return bytesToHex(nobleSha256(typeof input === 'string' ? utf8ToBytes(input) : input));
}

/** JSON canônico: chaves ordenadas recursivamente, sem espaços — base para hashes reprodutíveis. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(byCodeUnit)) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** Rótulo curto de chunk usado no prompt e nas citações: `c_` + 6 hex derivados de um hash estável. */
export function chunkLabel(seed: string): string {
  return `c_${sha256(seed).slice(0, 6)}`;
}

/** Ordem por code unit (independente de locale): a mesma em qualquer máquina, o que o hash canônico exige. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
