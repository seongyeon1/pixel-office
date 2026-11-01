import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:4318',
    trace: 'retain-on-failure',
    // Existing journeys exercise managed team work. Native CLI journeys override this preference.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://127.0.0.1:4318',
          localStorage: [{ name: 'pixel.workMode', value: 'team' }],
        },
      ],
    },
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'npx tsx e2e/server.ts',
    url: 'http://127.0.0.1:4318',
    reuseExistingServer: false,
    timeout: 20000,
  },
});
