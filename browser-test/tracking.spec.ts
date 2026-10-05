import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Exercises a real localhost worker with browser uploads and HTTP lifecycle/correction actions. */
test('decoded selected-car tracking repeats, cancels/resumes, and accepts a drawn manual recovery', async ({ page }) => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), 'browser-tracking-fixture-'));
  try {
    const frames = Array.from({ length: 100 }, (_, frame) => {
      const rgb = Buffer.alloc(100 * 100 * 3, 12);
      for (const [mx, my] of [[15, 15], [85, 15], [85, 85]]) for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) rgb[((my + y) * 100 + mx + x) * 3 + 1] = 255;
      const left = frame === 0 ? 40 : frame === 1 ? 42 : 46;
      if (frame !== 2) for (let y = 50; y < 58; y++) for (let x = left; x < left + 8; x++) { const i = (y * 100 + x) * 3; rgb[i] = 180; rgb[i + 1] = (x - left + y) % 2 ? 40 : 90; rgb[i + 2] = 60; }
      return rgb;
    });
    const raw = join(root, 'frames.rgb'); const video = join(root, 'race.webm'); await writeFile(raw, Buffer.concat(frames));
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '100x100', '-framerate', '10', '-i', raw, '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuv444p', video]);
    await page.goto('/'); await page.locator('#video-file').setInputFiles({ name: 'race.webm', mimeType: 'video/webm', buffer: await readFile(video) });
    await expect(page.locator('.message[role=status]')).toHaveText('Video saved on this machine for local processing.');
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/analyses' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create draft' }).click(); const analysis = await (await created).json();
    await page.getByRole('button', { name: 'Enable calibration' }).click();
    await page.getByRole('button', { name: 'Set race start' }).click();
    await page.getByRole('button', { name: 'Set marker frame' }).click();
    await page.getByRole('button', { name: 'Detect green markers', exact: true }).click();
    await expect(page.getByText('3 green markers detected.')).toBeVisible();
    await page.getByRole('button', { name: 'Set car frame' }).click();
    const selection = page.locator('.calibration-hit-area'); await selection.scrollIntoViewIfNeeded();
    const initial = await selection.boundingBox(); if (!initial) throw new Error('Selection canvas missing');
    await page.mouse.move(initial.x + initial.width * .4, initial.y + initial.height * .5); await page.mouse.down(); await page.mouse.move(initial.x + initial.width * .48, initial.y + initial.height * .58); await page.mouse.up();
    await page.getByRole('button', { name: 'Save correction set' }).click();
    await page.getByRole('button', { name: 'Queue batch' }).click(); await page.getByRole('button', { name: 'Start batch' }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume batch' })).toBeVisible(); await page.getByRole('button', { name: 'Resume batch' }).click();
    await expect(page.getByRole('region', { name: 'Selected car tracking review' })).toBeVisible({ timeout: 20_000 });
    const tracking = (await (await page.request.get(`/api/analyses/${analysis.id}/tracking`)).json()).tracking;
    expect(tracking.observations[2].quality).toBe('lost'); expect(tracking.observations.at(-1).quality).toBe('lost');
    const timed = page.getByRole('region', { name: 'Timed racing-line review' });
    await expect(timed.getByText('No observed crossings.', { exact: false })).toBeVisible();
    const sourceVideo = timed.locator('video');
    await expect(timed.getByTestId('review-cursor')).toContainText('frame 0');
    await sourceVideo.evaluate((video: HTMLVideoElement) => { video.currentTime = .15; });
    await expect(timed.getByTestId('review-cursor')).toContainText('Video 0.100s · frame 1');
    await expect(timed.locator('.box')).toHaveAttribute('style', /left:42%/);
    const actualCarPixel = await timed.locator('canvas').evaluate((canvas: HTMLCanvasElement) => Array.from(canvas.getContext('2d')!.getImageData(42, 51, 1, 1).data));
    expect(actualCarPixel[0]).toBeGreaterThan(150);

    await timed.getByRole('button', { name: 'Mark start/finish endpoints' }).click();
    const track = timed.locator('canvas'); const map = await track.boundingBox(); if (!map) throw new Error('Track map missing');
    await track.click({ position: { x: map.width * .45, y: map.height * .4 } });
    await track.click({ position: { x: map.width * .45, y: map.height * .7 } });
    await expect(timed.getByRole('button', { name: 'Review crossing 1', exact: true })).toBeVisible();
    const gateReview = await (await page.request.get(`/api/analyses/${analysis.id}/review`)).json();
    expect(gateReview.laps[0].crossing.seconds).toBeGreaterThan(.04); expect(gateReview.laps[0].crossing.seconds).toBeLessThan(.06); expect(gateReview.laps[0].liveRcLap).toBeNull();
    await page.getByRole('button', { name: 'Load saved imports' }).click();
    await page.getByRole('button', { name: /Review fixture driver/ }).click();
    // Selecting cached timing must preserve the actual playback frame.
    await expect(timed.getByTestId('review-cursor')).toContainText('frame 1');
    await timed.getByRole('button', { name: 'Bind selected cached timing' }).click();
    await timed.getByRole('button', { name: 'Review crossing 1', exact: true }).click();
    await expect(timed.getByTestId('review-cursor')).toContainText('frame 0');
    await timed.locator('#review-lap').selectOption('1');
    await expect(timed.getByRole('cell', { name: 'Lap 1 · 19.500', exact: true })).toBeVisible();
    await timed.locator('#review-crossing-time').fill(''); await timed.getByRole('button', { name: 'Save crossing correction' }).click();
    await expect(timed.getByRole('alert')).toContainText('finite crossing timestamp');
    await timed.locator('#review-crossing-time').fill('.06'); await timed.getByRole('button', { name: 'Save crossing correction' }).click();
    await expect(timed.getByText('manual 0.060s', { exact: false })).toBeVisible();
    await sourceVideo.evaluate((video: HTMLVideoElement) => { video.currentTime = .25; });
    await expect(timed.getByTestId('review-cursor')).toContainText('Video 0.200s · frame 2');
    await expect(timed.getByTestId('review-quality')).toContainText('lost');
    await expect(timed.locator('.box')).toHaveAttribute('style', 'display:none');
    const lostPixel = await timed.locator('canvas').evaluate((canvas: HTMLCanvasElement) => Array.from(canvas.getContext('2d')!.getImageData(42, 51, 1, 1).data));
    expect(lostPixel[0]).toBeLessThan(30);
    await timed.getByRole('button', { name: 'Add missed crossing at cursor' }).click();
    await expect(timed.getByText('Selected-car identity was lost; no path is filled.', { exact: true })).toBeVisible();
    await timed.getByRole('button', { name: 'Review crossing 2', exact: true }).click();
    await timed.locator('#review-lap').selectOption('2');
    await expect(timed.getByRole('cell', { name: 'Lap 2 · 20.000', exact: true })).toBeVisible();
    const savedRevision = (await (await page.request.get(`/api/analyses/${analysis.id}/review`)).json()).revision;
    for (let navigation = 0; navigation < 2; navigation++) {
      await timed.getByRole('button', { name: 'Reload saved review' }).click();
      await expect(timed.getByRole('button', { name: 'Review crossing 2', exact: true })).toBeVisible();
      await expect(timed.getByTestId('review-cursor')).toContainText('frame 0');
      expect((await (await page.request.get(`/api/analyses/${analysis.id}/review`)).json()).revision).toEqual(savedRevision);
      await timed.getByRole('button', { name: 'Review crossing 2', exact: true }).click();
    }
    const review = page.getByRole('region', { name: 'Selected car tracking review' });
    const recoveryVideo = review.locator('video');
    await recoveryVideo.evaluate(async (element: HTMLVideoElement) => { element.currentTime = .3; await new Promise<void>(resolve => element.addEventListener('seeked', () => resolve(), { once: true })); element.dispatchEvent(new Event('timeupdate')); });
    const hit = review.locator('.calibration-hit-area'); await hit.scrollIntoViewIfNeeded(); const rect = await hit.boundingBox(); if (!rect) throw new Error('Recovery canvas missing');
    await page.mouse.move(rect.x + rect.width * .46, rect.y + rect.height * .5); await page.mouse.down(); await page.mouse.move(rect.x + rect.width * .54, rect.y + rect.height * .58); await page.mouse.up();
    await review.getByRole('button', { name: 'Confirm identity and resume tracking' }).click();
    await expect.poll(async () => (await (await page.request.get(`/api/analyses/${analysis.id}`)).json()).state, { timeout: 20_000 }).toBe('completed');
    const recovered = (await (await page.request.get(`/api/analyses/${analysis.id}/tracking`)).json()).tracking;
    expect(recovered.observations[2].quality).toBe('lost'); expect(recovered.observations[3].quality).toBe('reacquired');
    const priorRun = (await (await page.request.get(`/api/analyses/${analysis.id}/artifacts`)).json()).run.id;
    await page.request.post(`/api/analyses/${analysis.id}/queue`); await page.request.post(`/api/analyses/${analysis.id}/start`);
    await expect.poll(async () => (await (await page.request.get(`/api/analyses/${analysis.id}`)).json()).state, { timeout: 20_000 }).toBe('completed');
    expect((await (await page.request.get(`/api/analyses/${analysis.id}/artifacts`)).json()).run.id).not.toBe(priorRun);
    await timed.getByRole('button', { name: 'Reload saved review' }).click();
    await expect(timed.getByText('No observed crossings.', { exact: false })).toBeVisible();
    await page.route(`**/api/analyses/${analysis.id}/video`, route => route.fulfill({ status: 404, body: 'Unavailable fixture video' }));
    await timed.getByRole('button', { name: 'Reload saved review' }).click();
    await expect(timed.getByRole('alert')).toContainText('Unable to decode');
    await expect(timed.locator('.box')).toHaveAttribute('style', 'display:none');
    await page.locator('#video-file').setInputFiles({ name: 'second-race.webm', mimeType: 'video/webm', buffer: await readFile(video) });
    await expect(timed).toHaveCount(0);
    await expect(page.locator('.message[role=status]')).toHaveText('Video saved on this machine for local processing.');
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page.getByText('second-race.webm', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Timed racing-line review' })).toHaveCount(0);

  } finally { await rm(root, { recursive: true, force: true }); }
});
