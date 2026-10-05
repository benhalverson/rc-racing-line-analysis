import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

export const fixtureWidth = 240;
export const fixtureHeight = 180;
export const fixtureTimes = [0, .12, .32, .36, .68, .8, 1.04, 1.12];
export const referenceMarkers = [20, 110, 190].flatMap(x => [20, 80, 130].map(y => ({ x, y })));

/** Encodes genuinely irregular timestamps and a gradual projective camera warp into lossless source pixels. */
export async function createProjectiveVideo(root: string) {
  const frames = fixtureTimes.map((_seconds, frame) => {
    const rgb = Buffer.alloc(fixtureWidth * fixtureHeight * 3, 12);
    const perspective = Math.min(frame, 3) / 3 * .001;
    for (const marker of referenceMarkers) {
      const denominator = 1 - perspective * marker.x;
      const mx = Math.round(marker.x / denominator); const my = Math.round(marker.y / denominator);
      for (let y = my - 2; y <= my + 2; y++) for (let x = mx - 2; x <= mx + 2; x++) {
        const i = (y * fixtureWidth + x) * 3; rgb[i] = 0; rgb[i + 1] = 255; rgb[i + 2] = 0;
      }
    }
    const left = 80 + frame * 2;
    for (let y = 55; y < 63; y++) for (let x = left; x < left + 8; x++) {
      const i = (y * fixtureWidth + x) * 3; rgb[i] = 180; rgb[i + 1] = (x - left + y) % 2 ? 40 : 90; rgb[i + 2] = 60;
    }
    // A source-space magenta landmark tests the image inverse warp independently of tracker geometry.
    for (let y = 43; y <= 51; y++) for (let x = 141; x <= 149; x++) {
      const i = (y * fixtureWidth + x) * 3; rgb[i] = 230; rgb[i + 1] = 0; rgb[i + 2] = 230;
    }
    return rgb;
  });
  const raw = join(root, 'projective.rgb'); const video = join(root, 'projective-vfr.webm');
  await writeFile(raw, Buffer.concat(frames));
  const ticks = fixtureTimes.map(seconds => Math.round(seconds * 25));
  let expression = String(ticks.at(-1));
  for (let frame = ticks.length - 2; frame >= 0; frame--) expression = `if(eq(N,${frame}),${ticks[frame]},${expression})`;
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${fixtureWidth}x${fixtureHeight}`, '-framerate', '25', '-i', raw, '-vf', `setpts='${expression}/25/TB'`, '-fps_mode', 'vfr', '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuv444p', video]);
  return video;
}
