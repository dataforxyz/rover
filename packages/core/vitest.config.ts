import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  define: {
    __BUILD_CONFIG__: JSON.stringify({
      apiKey: 'test-api-key',
      host: 'https://example.test',
    }),
  },
  resolve: {
    alias: {
      'rover-schemas': fileURLToPath(
        new URL('../schemas/src/index.ts', import.meta.url)
      ),
      'rover-telemetry': fileURLToPath(
        new URL('../telemetry/src/index.ts', import.meta.url)
      ),
    },
  },
  plugins: [
    {
      name: 'text-loader',
      transform(_src, id) {
        if (id.endsWith('.md')) {
          const content = readFileSync(id, 'utf-8');
          return {
            code: `export default ${JSON.stringify(content)};`,
          };
        }
      },
    },
  ],
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/__tests__/**',
        'vitest.config.ts',
      ],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
