import type { NormalizedPoint } from '../../../../shared/calibration-contract';

/** Tunable browser-only detector thresholds. */
export const GREEN_MARKER_DETECTOR = {
  minArea: 8,
  minSaturation: 0.45,
  minValue: 0.2,
  minHue: 70,
  maxHue: 170,
  maxAreaRatio: 0.02,
  minDarkNeighborRatio: 0.5,
  darkNeighborValue: 0.35,
} as const;
export type GreenMarkerDetectorOptions = { [Key in keyof typeof GREEN_MARKER_DETECTOR]: number };

export function detectGreenMarkers(
  image: ImageData,
  thresholds: Partial<GreenMarkerDetectorOptions> = {},
): NormalizedPoint[] {
  const options = { ...GREEN_MARKER_DETECTOR, ...thresholds };
  const { width, height, data } = image;
  if (!width || !height) return [];

  const qualifying = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [hue, saturation, value] = rgbToHsv(data[offset], data[offset + 1], data[offset + 2]);
      if (hue >= options.minHue && hue <= options.maxHue && saturation >= options.minSaturation && value >= options.minValue) {
        qualifying[y * width + x] = 1;
      }
    }
  }

  const visited = new Uint8Array(width * height);
  const points: NormalizedPoint[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (!qualifying[start] || visited[start]) continue;
      const queue = [start];
      visited[start] = 1;
      let area = 0;
      let sumX = 0;
      let sumY = 0;
      const componentPixels: number[] = [];
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const index = queue[cursor];
        const pointX = index % width;
        const pointY = Math.floor(index / width);
        area += 1;
        sumX += pointX;
        sumY += pointY;
        componentPixels.push(index);
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dy) continue;
            const neighborX = pointX + dx;
            const neighborY = pointY + dy;
            if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) continue;
            const neighbor = neighborY * width + neighborX;
            if (qualifying[neighbor] && !visited[neighbor]) {
              visited[neighbor] = 1;
              queue.push(neighbor);
            }
          }
        }
      }
      if (area >= options.minArea && area / (width * height) <= options.maxAreaRatio && hasDarkSurrounding(
        componentPixels,
        width,
        height,
        data,
        options.darkNeighborValue,
        options.minDarkNeighborRatio,
      )) {
        points.push({ x: sumX / area / width, y: sumY / area / height });
      }
    }
  }
  return points;
}

function hasDarkSurrounding(
  componentPixels: number[],
  width: number,
  height: number,
  data: Uint8ClampedArray,
  darkValue: number,
  minimumDarkRatio: number,
) {
  const component = new Set(componentPixels);
  let samples = 0;
  let darkSamples = 0;
  for (const index of componentPixels) {
    const x = index % width;
    const y = Math.floor(index / width);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const neighborX = x + dx;
        const neighborY = y + dy;
        if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) continue;
        const neighbor = neighborY * width + neighborX;
        if (component.has(neighbor)) continue;
        const offset = neighbor * 4;
        const [, , value] = rgbToHsv(data[offset], data[offset + 1], data[offset + 2]);
        samples += 1;
        if (value <= darkValue) darkSamples += 1;
      }
    }
  }
  return samples > 0 && darkSamples / samples >= minimumDarkRatio;
}

function rgbToHsv(red: number, green: number, blue: number): [number, number, number] {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return [hue, max ? delta / max : 0, max];
}
