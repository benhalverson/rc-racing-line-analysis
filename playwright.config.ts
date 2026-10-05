import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser-test',
  workers: 1,
  use: {
    browserName: 'chromium',
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
});
