import { describe, expect, it } from 'vitest';
import { detectGreenMarkers } from './green-marker-detector';

function image(width: number, height: number, pixels: Record<string, [number, number, number]> = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [key, [red, green, blue]] of Object.entries(pixels)) {
    const [x, y] = key.split(',').map(Number);
    const offset = (y * width + x) * 4;
    data[offset] = red; data[offset + 1] = green; data[offset + 2] = blue; data[offset + 3] = 255;
  }
  return { width, height, data } as ImageData;
}

describe('detectGreenMarkers', () => {
  it('detects saturated green pixels and returns normalized centroids', () => {
    const result = detectGreenMarkers(image(5, 5, { '2,2': [20, 230, 40] }), { minArea: 1, maxAreaRatio: 1 });
    expect(result).toEqual([{ x: 0.4, y: 0.4 }]);
  });

  it('rejects non-green pixels and filters small noise', () => {
    const result = detectGreenMarkers(image(6, 6, {
      '0,0': [220, 30, 30], '1,1': [220, 220, 30], '2,2': [20, 230, 40],
    }));
    expect(result).toEqual([]);
  });

  it('groups diagonal pixels using 8-connected components', () => {
    const pixels: Record<string, [number, number, number]> = {};
    for (const point of ['1,1', '2,2', '3,3']) pixels[point] = [20, 230, 40];
    const result = detectGreenMarkers(image(5, 5, pixels), { minArea: 3, maxAreaRatio: 1 });
    expect(result).toEqual([{ x: 0.4, y: 0.4 }]);
  });

  it('returns one point per separated component and an empty result when none qualify', () => {
    const result = detectGreenMarkers(image(10, 5, {
      '1,1': [20, 230, 40], '1,2': [20, 230, 40], '8,2': [20, 230, 40], '8,3': [20, 230, 40],
    }), { minArea: 2, maxAreaRatio: 1 });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ x: 1 / 10, y: 1.5 / 5 });
    expect(result[1]).toEqual({ x: 8 / 10, y: 2.5 / 5 });
    expect(detectGreenMarkers(image(2, 2))).toEqual([]);
  });

  it('rejects a wall-sized connected green region', () => {
    const pixels: Record<string, [number, number, number]> = {};
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) pixels[`${x},${y}`] = [20, 230, 40];
    expect(detectGreenMarkers(image(10, 10, pixels), { minArea: 1, maxAreaRatio: 0.5 })).toEqual([]);
  });

  it('rejects green text surrounded by a bright yellow banner', () => {
    const pixels: Record<string, [number, number, number]> = {};
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) pixels[`${x},${y}`] = [230, 210, 30];
    }
    pixels['2,2'] = [20, 230, 40];
    expect(detectGreenMarkers(image(5, 5, pixels), { minArea: 1, maxAreaRatio: 1 })).toEqual([]);
  });
});
