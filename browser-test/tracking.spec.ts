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
      const left = frame < 2 ? 40 : 46;
      if (frame !== 2) for (let y = 50; y < 58; y++) for (let x = left; x < left + 8; x++) { const i = (y * 100 + x) * 3; rgb[i] = 180; rgb[i + 1] = (x - left + y) % 2 ? 40 : 90; rgb[i + 2] = 60; }
      return rgb;
    });
    const raw = join(root, 'frames.rgb'); const video = join(root, 'race.webm'); await writeFile(raw, Buffer.concat(frames));
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '100x100', '-framerate', '10', '-i', raw, '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuv444p', video]);
    await page.goto('/'); await page.locator('#video-file').setInputFiles({ name: 'race.webm', mimeType: 'video/webm', buffer: await readFile(video) });
    await expect(page.getByRole('status')).toHaveText('Video saved on this machine for local processing.');
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
  } finally { await rm(root, { recursive: true, force: true }); }
});
