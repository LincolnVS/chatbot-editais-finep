import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

/** Caminhos dos binários fora do banco. Tudo relativo a DATA_DIR (backup = copiar a pasta). */
export const storage = {
  ensureDirs(): void {
    for (const d of [config.uploadsDir, config.parsedDir, config.modelsDir]) fs.mkdirSync(d, { recursive: true });
  },
  uploadPath(documentId: string): string {
    return path.join(config.uploadsDir, `${documentId}.pdf`);
  },
  /** JSON congelado da resposta do docling-serve (campo `document.json_content`). */
  parsedJsonPath(documentId: string): string {
    return path.join(config.parsedDir, `${documentId}.docling.json`);
  },
  /** ParsedDocument normalizado (saída de normalize.ts). */
  parsedDocPath(documentId: string): string {
    return path.join(config.parsedDir, `${documentId}.parsed.json`);
  },
  canonicalMdPath(documentId: string): string {
    return path.join(config.parsedDir, `${documentId}.canonical.md`);
  },
  sectionsJsonPath(documentId: string): string {
    return path.join(config.parsedDir, `${documentId}.sections.json`);
  },
  readText(p: string): string | null {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  },
  writeText(p: string, content: string): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  },
  /** Apaga o PDF e os artefatos do parse de um documento (exclusão de documento/workspace). Ignora o que não existir. */
  removeDocumentFiles(documentId: string): void {
    const files = [
      this.uploadPath(documentId), this.parsedJsonPath(documentId), this.parsedDocPath(documentId),
      this.canonicalMdPath(documentId), this.sectionsJsonPath(documentId),
    ];
    for (const p of files) fs.rmSync(p, { force: true });
  },
};
