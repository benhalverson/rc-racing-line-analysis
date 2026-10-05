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

    // Real browser alternative drawing uses the same decoded stabilized canvas.
    const alternatives = timed.getByRole('region', { name: 'Hypothetical alternatives' });
    await alternatives.getByRole('button', { name: 'Draw new alternative' }).click();
    await alternatives.getByRole('button', { name: 'Save alternative version' }).click();
    await expect(alternatives.getByRole('alert')).toContainText('Enter a name');
    await alternatives.getByLabel('Alternative name').fill('Late apex');
    const alternativeBounds = await canvas.boundingBox(); if (!alternativeBounds) throw new Error('Track canvas unavailable');
    await canvas.click({ position: { x: alternativeBounds.width * .25, y: alternativeBounds.height * .3 } });
    await canvas.click({ position: { x: alternativeBounds.width * .5, y: alternativeBounds.height * .3 } });
    await canvas.click({ position: { x: alternativeBounds.width * .6, y: alternativeBounds.height * .6 } });
    await alternatives.getByRole('button', { name: 'Save alternative version' }).click();
    await expect(alternatives.getByRole('heading', { name: 'Late apex · v1 · Hypothetical' })).toBeVisible();
    await alternatives.getByRole('button', { name: 'Revise Late apex v1', exact: true }).click();
    await alternatives.getByLabel('Alternative name').fill('Later apex');
    await alternatives.getByRole('button', { name: 'Undo alternative point' }).click();
    await canvas.click({ position: { x: alternativeBounds.width * .7, y: alternativeBounds.height * .7 } });
    await alternatives.getByRole('button', { name: 'Save alternative version' }).click();
    await expect(alternatives.getByRole('heading', { name: 'Later apex · v2 · Hypothetical' })).toBeVisible();
    await alternatives.getByRole('button', { name: 'Compare Late apex v1 on track' }).click();
    await alternatives.getByRole('button', { name: 'Draw new alternative' }).click();
    await alternatives.getByLabel('Alternative name').fill('Outside');
    await canvas.click({ position: { x: alternativeBounds.width * .1, y: alternativeBounds.height * .6 } });
    await canvas.click({ position: { x: alternativeBounds.width * .8, y: alternativeBounds.height * .7 } });
    await alternatives.getByRole('button', { name: 'Save alternative version' }).click();
    await expect(alternatives.locator('.alternative-card')).toHaveCount(3);
    const alternativeUrl = `/api/analyses/${analysis.id}/alternatives`;
    const persisted = await (await page.request.get(alternativeUrl)).json();
    expect(persisted.versions[0].points).not.toEqual(persisted.versions[1].points);
    expect(persisted.versions.every((v: { hypothetical: boolean }) => v.hypothetical)).toBe(true);
    await timed.getByRole('button', { name: 'Reload saved review' }).click();
    await expect(alternatives.locator('.alternative-card')).toHaveCount(3);
    await expect(timed.getByTestId('review-cursor')).toContainText('frame 0');
    expect(await (await page.request.get(alternativeUrl)).json()).toEqual(persisted);
    await alternatives.getByRole('button', { name: 'Draw new alternative' }).click();
    await alternatives.getByLabel('Alternative name').fill('Cancelled draft');
    await alternatives.getByRole('button', { name: 'Cancel alternative draft' }).click();
    await expect(alternatives.getByLabel('Alternative name')).toHaveCount(0);
    expect(await (await page.request.get(alternativeUrl)).json()).toEqual(persisted);
    // Two browser clients revise the same durable version: one must reload.
    await alternatives.getByRole('button', { name: 'Revise Later apex v2', exact: true }).click();
    const competing = await page.request.post(alternativeUrl, { data: { ...persisted.authority, alternativeId: persisted.versions[1].alternativeId, baseVersion: 2, name: 'Concurrent', points: [{ x: 10, y: 10 }, { x: 20, y: 20 }] } });
    expect(competing.status()).toBe(201);
    await alternatives.getByRole('button', { name: 'Save alternative version' }).click();
    await expect(alternatives.getByRole('alert')).toContainText('Alternative revision changed');
    await timed.getByRole('button', { name: 'Reload saved review' }).click();
    await expect(alternatives.locator('.alternative-card')).toHaveCount(4);
    await expect(timed.getByTestId('review-cursor')).toContainText('frame 0');
    // A correction elsewhere invalidates an in-progress draft instead of rebasing it.
    await alternatives.getByRole('button', { name: 'Draw new alternative' }).click();
    await alternatives.getByLabel('Alternative name').fill('Stale draft');
    const redrawBounds = await canvas.boundingBox(); if (!redrawBounds) throw new Error('Track canvas unavailable');
    await canvas.click({ position: { x: redrawBounds.width * .1, y: redrawBounds.height * .1 } });
    await canvas.click({ position: { x: redrawBounds.width * .2, y: redrawBounds.height * .2 } });
    const currentReview = await (await page.request.get(`/api/analyses/${analysis.id}/review`)).json();
    expect((await page.request.post(`/api/analyses/${analysis.id}/review`, { data: { version: currentReview.revision.version, evidenceId: currentReview.revision.evidenceId, runId: currentReview.revision.runId, action: 'add', seconds: .4 } })).status()).toBe(201);
    await alternatives.getByRole('button', { name: 'Save alternative version' }).click();
    await expect(alternatives.getByRole('alert')).toContainText('Review authority changed');
    await timed.getByRole('button', { name: 'Reload saved review' }).click();
    await expect(alternatives.getByText('Stale evidence: retained history; excluded from current overlay and comparison', { exact: true })).toHaveCount(4);
    const invalidAuthority = (await (await page.request.get(alternativeUrl)).json()).authority;
    const invalidCoordinates = await page.request.post(alternativeUrl, { data: { ...invalidAuthority, alternativeId: null, baseVersion: 0, name: 'Invalid', points: [{ x: -1, y: 1 }, { x: 2, y: 2 }] } });
    expect(invalidCoordinates.status()).toBe(400); expect((await invalidCoordinates.json()).error).toContain('finite points inside');
    // Delay an actual old GET while a review edit causes a newer GET in the same component.
    let releaseOld!: () => void; let oldReady!: () => void; let oldDone!: () => void;
    const oldFinished = new Promise<void>(resolve => { oldDone = resolve; });
    const oldCaptured = new Promise<void>(resolve => { oldReady = resolve; });
    const release = new Promise<void>(resolve => { releaseOld = resolve; });
    let intercept = true;
    await page.route(`**${alternativeUrl}`, async route => {
      if (route.request().method() !== 'GET' || !intercept) { await route.continue(); return; }
      intercept = false; const response = await route.fetch(); oldReady(); await release; await route.fulfill({ response }); oldDone();
    });
    await timed.getByRole('button', { name: 'Reload saved review' }).click(); await oldCaptured;
    await expect(timed.getByTestId('review-cursor')).toContainText('frame 0');
    await video.evaluate((element: HTMLVideoElement) => { element.currentTime = .55; });
    await expect(timed.getByTestId('review-cursor')).toContainText('frame 3');
    const editResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/analyses/${analysis.id}/review` && response.request().method() === 'POST');
    await timed.getByRole('button', { name: 'Add missed crossing at cursor' }).click();
    expect((await editResponse).status()).toBe(201);
    const newest = await (await page.request.get(alternativeUrl)).json();
    await expect(alternatives.getByText(`Track reference ${newest.authority.trackReferenceId} · review revision ${newest.authority.reviewVersion}`, { exact: true })).toBeVisible();
    releaseOld(); await oldFinished; await page.unroute(`**${alternativeUrl}`);
    await expect(alternatives.getByText(`Track reference ${newest.authority.trackReferenceId} · review revision ${newest.authority.reviewVersion}`, { exact: true })).toBeVisible();
    // Navigation discards an unsaved draft and does not attach it to the replacement analysis.
    await expect(timed.getByTestId('review-cursor')).toContainText('frame 3');
    await alternatives.getByRole('button', { name: 'Draw new alternative' }).click();
    await alternatives.getByLabel('Alternative name').fill('Navigation draft');
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(timed).toHaveCount(0);
    expect((await (await page.request.get(alternativeUrl)).json()).versions).toHaveLength(4);
  } finally { await rm(root, { recursive: true, force: true }); }
});
