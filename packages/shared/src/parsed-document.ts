/** Representação intermediária de um documento após o parse (Docling) e a normalização. */

/** Caixa normalizada 0..1 com origem no canto SUPERIOR-esquerdo da página (pronta para overlay no viewer). */
export type BBox = { page: number; x0: number; y0: number; x1: number; y1: number };

export type BlockKind =
  | 'title'          // título do documento
  | 'section'        // cabeçalho de seção numerada ("6. DESPESAS APOIÁVEIS") ou não numerada ("ANEXO I")
  | 'item'           // item numerado ("6.5.5 ...", "2.1.1 ...")
  | 'alinea'         // "a) ...", "I - ..."
  | 'paragraph'      // texto corrido sem numeração
  | 'table'          // tabela (ver `table`)
  | 'footnote'
  | 'caption'
  | 'other';

export type TableData = {
  numRows: number;
  numCols: number;
  /** Grade completa (linha × coluna) já com spans resolvidos por repetição do texto. */
  rows: string[][];
  /** Índices das linhas que são cabeçalho (`column_header` no Docling). */
  headerRows: number[];
  /** Linhas divisórias de grupo (`row_section` ou célula única ocupando todas as colunas): "Grau de Inovação". */
  sectionRows?: number[];
  caption?: string;
};

export type Block = {
  /** Índice de ordem de leitura (0..n-1). */
  index: number;
  kind: BlockKind;
  /** Nível hierárquico: 0 = título, 1 = seção, 2 = item "6.5", 3 = "6.5.5", 4 = alínea... paragraph herda o nível do pai. */
  level: number;
  /** Número do item quando existir: "6", "6.5", "6.5.5", "ANEXO I", "CLÁUSULA 3ª", "a", "II". */
  itemNumber?: string;
  /** Texto normalizado (espaços colapsados, hífens de quebra removidos). Para `item`, INCLUI a numeração. */
  text: string;
  /** Caminho de seção legível até este bloco (sem incluir o próprio bloco), ex.: "6. DESPESAS APOIÁVEIS › 6.5 …". */
  sectionPath: string;
  /** Números de item dos ancestrais, ex.: ["6", "6.5"]. */
  ancestors: string[];
  pageStart: number;
  pageEnd: number;
  bboxes: BBox[];
  table?: TableData;
  /** Origem no JSON do Docling (self_ref), para depuração. */
  sourceRef?: string;
};

export type PageInfo = { page: number; width: number; height: number; charCount: number };

export type ParsedDocument = {
  /** Título do documento (primeira seção de nível 0 ou nome do arquivo). */
  title: string;
  pages: PageInfo[];
  blocks: Block[];
  /** Estatísticas para a UI/monografia. */
  stats: { sections: number; items: number; tables: number; footnotes: number; removedHeaderFooterLines: number };
  parser: { name: 'docling'; version: string };
};

/** Seção do `canonical.md` com offsets — usada pelo baseline (âncoras) e pelo padrão-ouro. */
export type CanonicalSection = {
  anchor: string;        // "sec-6.5.5" ou "sec-anexo-i"
  itemNumber?: string;
  heading: string;
  page: number;
  charStart: number;
  charEnd: number;
};

export type CanonicalDocument = {
  /** Markdown na ordem de leitura, com âncoras `{#sec-6.5.5 p=10}` no fim de cada cabeçalho. */
  markdown: string;
  sections: CanonicalSection[];
  /** Offsets (charStart, charEnd) de cada bloco dentro do markdown, indexado por `block.index`. */
  blockOffsets: Array<{ blockIndex: number; charStart: number; charEnd: number }>;
};
