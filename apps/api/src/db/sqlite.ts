import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export type Db = Database.Database;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Abre (ou cria) o banco, carrega a extensão sqlite-vec, aplica pragmas e migrações. */
export function openDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  const vecVersion = (db.prepare('select vec_version() as v').get() as { v: string }).v;
  const fts5 = db.prepare("select count(*) as n from pragma_compile_options where compile_options = 'ENABLE_FTS5'").get() as { n: number };
  if (!vecVersion) throw new Error('sqlite-vec não carregou (vec_version() vazio)');
  if (!fts5.n) throw new Error('SQLite sem FTS5 — better-sqlite3 deveria trazer FTS5 compilado');

  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set((db.prepare('select name from _migrations').all() as { name: string }[]).map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('insert into _migrations(name, applied_at) values (?, ?)').run(file, new Date().toISOString());
    })();
  }
}

/** Float32Array → BLOB aceito pelo vec0. */
export function vecToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** BLOB → Float32Array. */
export function blobToVec(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}
