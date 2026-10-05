import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser-test',
  workers: 1,
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:4200',
    headless: true,
    launchOptions: {
      executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ?? process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'],
    },
  },
  webServer: {
    command: 'cd client && node_modules/.bin/ng serve --host 127.0.0.1',
    url: 'http://127.0.0.1:4200',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
