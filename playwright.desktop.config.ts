import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.electron.ts',
  workers: 1,
  timeout: 30000,
  outputDir: 'test-results/desktop',
});
