import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectiveVideo, fixtureTimes, fixtureWidth, fixtureHeight } from './projective-fixture';

/** Proves real VFR decoding, automatic homography escalation, and synchronized source/reference pixels. */
test('VFR seeks and playback render a nonidentity projective track in reference coordinates', async ({ page }) => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), 'browser-projective-'));
  try {
    const path = await createProjectiveVideo(root);
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.goto('/');
    await page.locator('#video-file').setInputFiles({ name: 'projective-vfr.webm', mimeType: 'video/webm', buffer: await readFile(path) });
    await expect(page.locator('.message[role=status]')).toHaveText('Video saved on this machine for local processing.');
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/analyses' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create draft' }).click(); const analysis = await (await created).json();
    await page.getByRole('button', { name: 'Enable calibration' }).click();
    await page.getByRole('button', { name: 'Set race start' }).click();
    await page.getByRole('button', { name: 'Set marker frame' }).click();
    await page.getByRole('button', { name: 'Detect green markers', exact: true }).click();
    await expect(page.getByText('9 green markers detected.')).toBeVisible();
    await page.getByRole('button', { name: 'Set car frame' }).click();
    const hit = page.locator('.calibration-hit-area'); await hit.scrollIntoViewIfNeeded();
    const bounds = await page.locator('.calibration-panel app-calibration-canvas canvas').boundingBox(); if (!bounds) throw new Error('Calibration canvas missing');
    await page.mouse.move(bounds.x + bounds.width * 80 / fixtureWidth, bounds.y + bounds.height * 55 / fixtureHeight);
    await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * 88 / fixtureWidth, bounds.y + bounds.height * 63 / fixtureHeight); await page.mouse.up();
    await page.getByRole('button', { name: 'Save correction set' }).click();
    await page.getByRole('button', { name: 'Queue batch' }).click(); await page.getByRole('button', { name: 'Start batch' }).click();
    const timed = page.getByRole('region', { name: 'Timed racing-line review' });
    await expect(timed).toBeVisible({ timeout: 20_000 });
    const review = await (await page.request.get(`/api/analyses/${analysis.id}/review`)).json();
    expect(review.tracking.observations.map((o: { seconds: number }) => o.seconds)).toEqual(fixtureTimes);
    expect(review.stabilization.transforms[0].model).toBe('affine');
    expect(review.stabilization.transforms.slice(2).every((t: { model: string; quality: { usable: boolean }; matrix: number[] }) => t.model === 'homography' && t.quality.usable && Math.abs(t.matrix[6]) > .0005)).toBe(true);
    expect(review.tracking.observations.every((o: { quality: string }) => o.quality === 'tracked')).toBe(true);
    const video = timed.locator('video'); const canvas = timed.locator('canvas');
    await expect(timed.getByTestId('review-cursor')).toContainText('frame 0');
    // These targets lie inside irregular presentation intervals; an average-FPS frame index would fail.
    for (const [target, frame] of [[.22, 1], [.34, 2], [.55, 3], [.9, 5], [.22, 1], [.55, 3]] as const) {
      await video.evaluate((element: HTMLVideoElement, seconds) => { element.currentTime = seconds; }, target);
      await expect(timed.getByTestId('review-cursor')).toContainText(`Video ${fixtureTimes[frame].toFixed(3)}s · frame ${frame}`);
      const box = review.tracking.observations[frame].box;
      const style = await timed.locator('.box').getAttribute('style');
      expect(style).toContain(`left:${box.x / fixtureWidth * 100}%`);
      // Capture displayed source pixels; this checks the actual browser decoder, independent of API timestamps.
      const sourcePixel = await video.evaluate((element: HTMLVideoElement, position) => {
        const capture = document.createElement('canvas'); capture.width = element.videoWidth; capture.height = element.videoHeight;
        const context = capture.getContext('2d'); if (!context) throw new Error('Source capture unavailable');
        context.drawImage(element, 0, 0); const pixels = context.getImageData(0, 0, capture.width, capture.height).data;
        return { pixel: Array.from(context.getImageData(position.x + 1, position.y + 1, 1, 1).data), time: element.currentTime, redXs: Array.from({ length: capture.width }, (_, x) => x).filter(x => pixels[(56 * capture.width + x) * 4] > 150) };
      }, box);
      expect(sourcePixel.pixel[0], JSON.stringify({ target, frame, box, sourcePixel })).toBeGreaterThan(150);
      expect(sourcePixel.redXs).toEqual(Array.from({ length: 8 }, (_, x) => 80 + frame * 2 + x));
    }
    const point = review.tracking.observations[3].trackPoint;
    const sourceCenter = { x: review.tracking.observations[3].box.x + 4, y: 59 };
    // Fixture construction supplies the independent projective oracle, without importing rendering math.
    expect(point.x).toBeCloseTo(sourceCenter.x / (1 + .001 * sourceCenter.x), 0);
    expect(point.y).toBeCloseTo(sourceCenter.y / (1 + .001 * sourceCenter.x), 0);
    const pixels = await canvas.evaluate((element: HTMLCanvasElement, trackPoint) => {
      const context = element.getContext('2d'); if (!context) throw new Error('Track canvas unavailable');
      const pixel = (x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data);
      return { marker: pixel(190, 130), landmark: pixel(127, 41), unwarpedLandmark: pixel(145, 47), car: pixel(Math.round(trackPoint.x), Math.round(trackPoint.y)) };
    }, point);
    expect(pixels.marker[1]).toBeGreaterThan(220); expect(pixels.marker[0]).toBeLessThan(30);
    expect(pixels.landmark[0]).toBeGreaterThan(200); expect(pixels.landmark[2]).toBeGreaterThan(200);
    expect(pixels.unwarpedLandmark[0]).toBeLessThan(30);
    expect(pixels.car[1]).toBeGreaterThan(200); expect(pixels.car[2]).toBeGreaterThan(180);
    await timed.getByRole('button', { name: 'Mark start/finish endpoints' }).click();
    const map = await canvas.boundingBox(); if (!map) throw new Error('Reference canvas missing');
    await canvas.click({ position: { x: map.width * 130 / fixtureWidth, y: map.height * 30 / fixtureHeight } });
    const savedGate = page.waitForResponse(response => new URL(response.url()).pathname === `/api/analyses/${analysis.id}/review` && response.request().method() === 'POST');
    await canvas.click({ position: { x: map.width * 130 / fixtureWidth, y: map.height * 80 / fixtureHeight } });
    expect((await savedGate).status()).toBe(201);
    const marked = await (await page.request.get(`/api/analyses/${analysis.id}/review`)).json();
    // Browser pointer events round CSS coordinates; allow at most one reference pixel.
    expect(Math.abs(marked.revision.startFinish.a.x - 130)).toBeLessThan(1); expect(Math.abs(marked.revision.startFinish.a.y - 30)).toBeLessThan(1);
    expect(Math.abs(marked.revision.startFinish.b.x - 130)).toBeLessThan(1); expect(Math.abs(marked.revision.startFinish.b.y - 80)).toBeLessThan(1);
    const gatePixel = await canvas.evaluate((element: HTMLCanvasElement, gate) => Array.from(element.getContext('2d')!.getImageData(Math.round(gate.a.x), 55, 1, 1).data), marked.revision.startFinish);
    expect(gatePixel[0]).toBeGreaterThan(200); expect(gatePixel[1]).toBeGreaterThan(170); expect(gatePixel[2]).toBeLessThan(150);
    await timed.getByRole('button', { name: 'Reload saved review' }).click();
    await expect(timed.getByTestId('review-cursor')).toContainText('frame 0');
    await video.evaluate(async (element: HTMLVideoElement) => { element.muted = true; await element.play(); });
    await expect(timed.getByTestId('review-cursor')).toContainText('Video 1.120s · frame 7');
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.ended)).toBe(true);
    await expect(timed.locator('.box')).toHaveAttribute('style', /left:39.166666666666664%/);
    await video.evaluate((element: HTMLVideoElement) => { element.currentTime = .55; });
    await expect(timed.getByTestId('review-cursor')).toContainText('Video 0.360s · frame 3');
  } finally { await rm(root, { recursive: true, force: true }); }
});
