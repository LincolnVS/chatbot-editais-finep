/** Cliente do docling-serve (sidecar HTTP). */

/** Subconjunto tipado do DoclingDocument (schema v1.x) usado pelo normalizador. Campos extras são ignorados. */
export type DoclingRef = { $ref: string };
export type DoclingBBox = { l: number; t: number; r: number; b: number; coord_origin: 'BOTTOMLEFT' | 'TOPLEFT' };
export type DoclingProv = { page_no: number; bbox: DoclingBBox; charspan?: [number, number] };
export type DoclingTextItem = {
  self_ref: string;
  parent?: DoclingRef | null;
  children?: DoclingRef[];
  content_layer?: 'body' | 'furniture' | (string & {});
  label: 'section_header' | 'list_item' | 'text' | 'paragraph' | 'page_header' | 'page_footer' | 'footnote' | 'caption' | 'title' | 'code' | 'formula' | (string & {});
  level?: number;
  /** Texto SEM marcador de lista (o Docling remove "1.1." de list_item). */
  text: string;
  /** Texto original COM marcador — usar de preferência. */
  orig?: string;
  marker?: string;
  enumerated?: boolean;
  prov?: DoclingProv[];
};
export type DoclingTableCell = {
  text: string; row_span: number; col_span: number;
  start_row_offset_idx: number; end_row_offset_idx: number; start_col_offset_idx: number; end_col_offset_idx: number;
  column_header?: boolean; row_header?: boolean; row_section?: boolean; bbox?: DoclingBBox;
};
export type DoclingTableItem = {
  self_ref: string; parent?: DoclingRef | null; children?: DoclingRef[]; label: 'table' | (string & {});
  prov?: DoclingProv[]; captions?: DoclingRef[]; footnotes?: DoclingRef[];
  data: { num_rows: number; num_cols: number; grid: DoclingTableCell[][]; table_cells?: DoclingTableCell[] };
};
export type DoclingGroup = { self_ref: string; parent?: DoclingRef | null; children: DoclingRef[]; name?: string; label?: string };
export type DoclingDocumentJson = {
  schema_name: string; version: string; name: string;
  body: { self_ref: '#/body'; children: DoclingRef[] };
  furniture?: { self_ref: '#/furniture'; children: DoclingRef[] };
  groups: DoclingGroup[]; texts: DoclingTextItem[]; tables: DoclingTableItem[];
  pictures: Array<{ self_ref: string; prov?: DoclingProv[]; captions?: DoclingRef[]; children?: DoclingRef[] }>;
  pages: Record<string, { size: { width: number; height: number }; page_no: number }>;
};
export type DoclingServeResponse = {
  document: { filename: string; json_content: DoclingDocumentJson; md_content?: string | null };
  status: string; errors?: unknown[]; processing_time?: number;
};

export class DoclingUnavailableError extends Error {}

export type DoclingClient = {
  /** Converte um PDF. `filename` só para o multipart. */
  convertPdf(pdf: Buffer, filename: string, opts?: { ocr?: boolean }): Promise<DoclingServeResponse>;
  /** Versão real do docling embutido no sidecar (cacheada). */
  version(): Promise<string>;
  /** true se o sidecar responde. */
  isUp(): Promise<boolean>;
};

const CONVERT_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5_000;
const FALLBACK_VERSION = 'docling-serve@1.32.0';
const UNAVAILABLE_MESSAGE = 'parser indisponível — suba com npm run dev:docling';

/** Erro de rede (conexão recusada, DNS, socket fechado) → sidecar fora do ar. Timeout é outro caso. */
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return false;
  return err.name === 'TypeError' || /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket/i.test(err.message);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

export function createDoclingClient(baseUrl: string): DoclingClient {
  const base = baseUrl.replace(/\/+$/, '');
  let cachedVersion: string | undefined;

  async function getJson(path: string, timeoutMs: number): Promise<unknown> {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`docling-serve respondeu ${res.status} em ${path}`);
    return res.json();
  }

  return {
    async convertPdf(pdf, filename, opts) {
      const form = new FormData();
      form.append('files', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);
      form.append('to_formats', 'json');
      form.append('table_mode', 'accurate');
      form.append('do_ocr', opts?.ocr ? 'true' : 'false');
      form.append('image_export_mode', 'placeholder');

      let res: Response;
      try {
        res = await fetch(`${base}/v1/convert/file`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS),
        });
      } catch (err) {
        if (isNetworkError(err)) throw new DoclingUnavailableError(UNAVAILABLE_MESSAGE, { cause: err });
        if (err instanceof Error && err.name === 'TimeoutError') {
          throw new Error(`docling-serve não respondeu em ${CONVERT_TIMEOUT_MS / 60_000} min (${filename})`, { cause: err });
        }
        throw err;
      }
      if (!res.ok) {
        throw new Error(`docling-serve respondeu ${res.status} ao converter ${filename}: ${await safeText(res)}`);
      }
      const body = (await res.json()) as DoclingServeResponse;
      if (body.status !== 'success' && body.status !== 'partial_success') {
        throw new Error(`docling-serve falhou ao converter ${filename}: status=${body.status} ${JSON.stringify(body.errors ?? []).slice(0, 300)}`);
      }
      if (!body.document?.json_content) {
        throw new Error(`docling-serve não devolveu json_content para ${filename}`);
      }
      return body;
    },

    async version() {
      if (cachedVersion) return cachedVersion;
      try {
        const info = (await getJson('/version', PROBE_TIMEOUT_MS)) as Record<string, unknown>;
        const docling = typeof info?.docling === 'string' ? info.docling : undefined;
        if (docling) {
          cachedVersion = `docling@${docling}`;
          return cachedVersion;
        }
      } catch (err) {
        if (isNetworkError(err)) throw new DoclingUnavailableError(UNAVAILABLE_MESSAGE, { cause: err });
      }
      // Sem /version: confirma que o sidecar responde e usa a versão conhecida do pacote.
      try {
        await getJson('/health', PROBE_TIMEOUT_MS);
      } catch (err) {
        if (isNetworkError(err)) throw new DoclingUnavailableError(UNAVAILABLE_MESSAGE, { cause: err });
        throw err;
      }
      cachedVersion = FALLBACK_VERSION;
      return cachedVersion;
    },

    async isUp() {
      try {
        const health = (await getJson('/health', PROBE_TIMEOUT_MS)) as { status?: string };
        return health?.status === 'ok' || health?.status === undefined;
      } catch {
        return false;
      }
    },
  };
}
