import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', '../../packages/shared/src/**/*.ts'],
      // worker/reranker carregam modelos ONNX; retrieval-lab e cli são scripts de linha de comando
      exclude: ['src/index.ts', 'src/embed/worker.ts', 'src/embed/reranker.ts', 'src/eval/retrieval-lab.ts', 'src/eval/cli.ts'],
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: '../../coverage/api',
      thresholds: { lines: 85, functions: 85, branches: 70, statements: 85 },
    },
  },
});
