import { expect, test } from '@playwright/test';

/** Exercises real browser file selection and the local processing lifecycle at its HTTP boundary. */
test('imports on localhost, preserves accepted marker corrections, and displays excluded regions', async ({ page }) => {
  const analysis = { id: 'browser-analysis', videoPath: 'local-disk://video-1', videoName: 'race.webm', videoStorage: 'local-disk', state: 'draft', phase: 'created', progress: 0, checkpoint: null, acceptedCorrectionSetId: null, error: null, createdAt: '2026-07-14T00:00:00.000Z', updatedAt: '2026-07-14T00:00:00.000Z' };
  let accepted = false; let processing = false;
  let imported = false;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown;
    if (path === '/api/runtime') body = { mode: 'local-node' };
    else if (path === '/api/local-videos') {
      imported = true;
      expect(route.request().headers()['content-type']).toBe('video/webm');
      expect(route.request().headers()['x-video-name']).toBe('race.webm');
      body = { videoPath: analysis.videoPath, localVideoRef: { id: 'video-1', name: 'race.webm', mimeType: 'video/webm', size: 1, lastModified: 1 } };
    } else if (path === '/api/analyses') {
      expect(route.request().postDataJSON()).toMatchObject({ videoStorage: 'local-disk', videoPath: analysis.videoPath });
      body = analysis;
    } else if (path.endsWith('/calibration/start')) body = { ...analysis, state: 'awaiting_calibration', phase: 'calibrating' };
    else if (path.endsWith('/correction-sets') && route.request().method() === 'GET') body = { correctionSets: [] };
    else if (path.endsWith('/correction-sets')) {
      const corrections = route.request().postDataJSON();
      expect(corrections.markers).toHaveLength(3);
      expect(new Set(corrections.markers.map((marker: { id: string }) => marker.id)).size).toBe(3);
      accepted = true;
      body = { ...corrections, id: 'accepted-1', version: 1, accepted: true };
    } else if (path.endsWith('/queue')) {
      expect(accepted).toBe(true);
      body = { ...analysis, state: 'queued', acceptedCorrectionSetId: 'accepted-1' };
    } else if (path.endsWith('/start')) { processing = true; body = { ...analysis, state: 'running' }; }
    else if (path.endsWith('/artifacts')) body = { stabilization: { totalFrames: 10, usableFrames: 7, unusableRegions: [{ startFrame: 7, endFrame: 9, reason: 'insufficient-markers' }] } };
    else if (!processing) body = { ...analysis, state: accepted ? 'ready' : 'draft', acceptedCorrectionSetId: accepted ? 'accepted-1' : null };
    else body = { ...analysis, state: 'needs_correction', phase: 'stabilizing', error: 'Unusable stabilization regions' };
    await route.fulfill({ json: body });
  });
  await page.goto('/');
  // Capture a browser-generated local video; no recordings or provider calls are used.
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No canvas context');
    context.fillStyle = '#272727'; context.fillRect(0, 0, 320, 240);
    const recorder = new MediaRecorder(canvas.captureStream(10), { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    recorder.stop(); await stopped;
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  await page.locator('#video-file').setInputFiles({ name: 'race.webm', mimeType: 'video/webm', buffer: Buffer.from(bytes) });
  await expect(page.getByRole('status')).toHaveText('Video saved on this machine for local processing.');
  expect(imported).toBe(true);
  await page.getByRole('button', { name: 'Create draft' }).click();
  await page.getByRole('button', { name: 'Enable calibration' }).click();
  await page.getByRole('button', { name: 'Set race start' }).click();
  await page.getByRole('button', { name: 'Set marker frame' }).click();
  await page.getByRole('button', { name: 'Detect green markers', exact: true }).click();
  await expect(page.getByText('0 green markers detected.')).toBeVisible();
  const canvas = page.locator('app-calibration-canvas .calibration-hit-area');
  await canvas.click({ position: { x: 40, y: 40 } });
  await canvas.click({ position: { x: 150, y: 50 } });
  await canvas.click({ position: { x: 80, y: 150 } });
  await page.getByRole('button', { name: 'Set car frame' }).click();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Calibration canvas missing');
  await page.mouse.move(box.x + 170, box.y + 100); await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 150); await page.mouse.up();
  await page.getByRole('button', { name: 'Save correction set' }).click();
  await page.getByRole('button', { name: 'Queue batch' }).click();
  await page.getByRole('button', { name: 'Start batch' }).click();
  await expect(page.getByText('7 of 10 frames passed geometry checks.')).toBeVisible();
  await expect(page.getByText('Frames 7–9: insufficient-markers')).toBeVisible();
  await expect(page.getByText('Review excluded stabilization or tracking regions before continuing.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save correction set' })).toBeDisabled();
  await page.getByRole('button', { name: 'Enable calibration' }).click();
  await expect(page.getByRole('region', { name: 'Stabilization review' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save correction set' })).toBeEnabled();
});
