import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { test, expect } from '@playwright/test';
import { createApp } from '../api/src/app';
import { InMemoryAnalysisStore } from '../api/src/store';
import { InMemoryTimingStore } from '../api/src/timing';
import { AnalysisWorkflow } from '../api/src/workflow';

let server: Server;
let baseUrl: string;
let browserCalls = 0;
let directCalls = 0;
let failBrowser = false;
const raceHtml = readFileSync(new URL('../api/test/fixtures/timing/dom-race.html', import.meta.url), 'utf8');

/** Serve the built Angular UI and public Hono API using fixture-only timing ports. */
test.beforeAll(async () => {
  const timingStore = new InMemoryTimingStore();
  const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
    store: timingStore,
    fetch: async (url) => {
      directCalls += 1;
      const parsed = new URL(url);
      let html = '<main id="app"></main>';
      if (parsed.hostname === 'live.liverc.com') html = '<a href="https://rcra.liverc.com/"><b>RCRA &amp; Club</b></a>';
      else if (parsed.pathname === '/events/') html = '<a href="/results/?p=view_event&amp;id=11">Summer Race</a>';
      else if (parsed.searchParams.get('p') === 'view_event') html = '<a href="/results/?id=44&amp;p=view_race_result">Buggy Heat 2/7</a><a href="/results/?id=45&amp;p=view_race_result">Buggy Heat 3/7</a>';
      return { url, status: 200, html };
    },
    browser: async (url) => {
      browserCalls += 1;
      return { url, status: failBrowser ? 429 : 200, html: raceHtml };
    },
  });
  server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith('/api/')) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await app.request(request.url.slice(4), {
          method: request.method,
          headers: { 'content-type': 'application/json' },
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        });
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(await result.text());
        return;
      }
      const root = resolve('client/dist/client/browser');
      const path = resolve(root, `.${new URL(request.url ?? '/', 'http://localhost').pathname}`);
      if (!path.startsWith(`${root}/`) && path !== root) { response.writeHead(403); response.end(); return; }
      const target = extname(path) ? path : resolve(root, 'index.html');
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.ico': 'image/x-icon' };
      response.writeHead(200, { 'content-type': types[extname(target)] ?? 'application/octet-stream' });
      response.end(readFileSync(target));
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('browser fixture server failed');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await new Promise<void>((done) => server.close(() => done())); });

test('selects the exact repeated heat and duplicate driver, confirms, imports and reopens offline', async ({ page }) => {
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'Search tracks', exact: true }).click();
  await page.getByRole('button', { name: /RCRA & Club/ }).click();
  await page.getByLabel('Archived event').selectOption({ label: 'Summer Race' });
  await page.getByLabel('Heat or main event').selectOption({ label: 'Buggy Heat 2/7' });
  await expect(page.getByLabel('Driver').locator('option')).toHaveCount(3);
  await page.getByLabel('Driver').selectOption({ index: 2 });
  await page.getByRole('button', { name: 'Review/confirm selected result' }).click();
  const importedResponse = page.waitForResponse((response) => response.url().endsWith('/api/timing/imports') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Import timing', exact: true }).click();
  expect(await (await importedResponse).json()).toMatchObject({ raceId: '44', driverId: '202', classLabel: 'Buggy', laps: [{ lapTimeSeconds: 19.2 }] });
  await expect(page.locator('.timing-panel [role=status]')).toHaveText("José O'Brien · 1 laps imported and cached locally.");
  expect(browserCalls).toBe(2);
  await page.getByRole('button', { name: 'Load saved imports' }).click();
  const calls = directCalls;
  await page.getByRole('button', { name: /José O'Brien · Buggy Heat 2\/7/ }).click();
  await expect(page.locator('.timing-panel [role=status]')).toContainText('1 laps imported');
  expect(directCalls).toBe(calls);
});

test('shows a controlled browser rate-limit error in the timing flow', async ({ page }) => {
  failBrowser = true;
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'Search tracks', exact: true }).click();
  await page.getByRole('button', { name: /RCRA & Club/ }).click();
  await page.getByLabel('Archived event').selectOption({ label: 'Summer Race' });
  await page.getByLabel('Heat or main event').selectOption({ label: 'Buggy Heat 3/7' });
  await expect(page.getByRole('alert')).toHaveText('Browser Run returned HTTP 429');
  await expect(page.getByLabel('Driver').locator('option')).toHaveCount(1);
});
