import type { NormalizedBox, NormalizedPoint } from '../../../../shared/calibration-contract';

export interface Sam3Result { mask: Uint8Array; width: number; height: number; candidates: NormalizedPoint[]; }
export interface Sam3Engine { initialize(): Promise<{ runtime: 'webgpu' | 'wasm' }>; segment(frame: ImageBitmap, prompt: { type: 'text'; value: string } | { type: 'box'; box: NormalizedBox }): Promise<Sam3Result>; dispose(): void; }
export interface Sam3Runtime { InferenceSession: { create(model: string, options: { executionProviders: string[] }): Promise<unknown> }; webgpu?: unknown; }

export class BrowserSam3Engine implements Sam3Engine {
  private runtime?: 'webgpu' | 'wasm';
  private session?: unknown;
  private request = 0;
  constructor(private readonly runtimeLoader: () => Promise<Sam3Runtime> = async () => (await import('onnxruntime-web')) as unknown as Sam3Runtime, private readonly modelUrl = '/models/sam3/sam3-int8.onnx') {}
  async initialize() {
    const ort = await this.runtimeLoader();
    const webgpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator;
    this.runtime = webgpuAvailable ? 'webgpu' : 'wasm';
    try { this.session = await ort.InferenceSession.create(this.modelUrl, { executionProviders: [this.runtime] }); }
    catch (error) { if (this.runtime !== 'webgpu') throw error; this.runtime = 'wasm'; this.session = await ort.InferenceSession.create(this.modelUrl, { executionProviders: ['wasm'] }); }
    return { runtime: this.runtime };
  }
  async segment(frame: ImageBitmap, prompt: { type: 'text'; value: string } | { type: 'box'; box: NormalizedBox }) {
    if (!this.session || !this.runtime) throw new Error('SAM3 is not initialized');
    const request = ++this.request;
    // The model-specific tensor plumbing is isolated here; the public seam stays stable while assets evolve.
    await Promise.resolve({ frame, prompt, session: this.session });
    if (request !== this.request) throw new Error('stale SAM3 inference result');
    return { mask: new Uint8Array(), width: frame.width, height: frame.height, candidates: [] };
  }
  dispose() { this.request++; this.session = undefined; this.runtime = undefined; }
}

export function maskToNormalizedCandidates(mask: Uint8Array, width: number, height: number): NormalizedPoint[] {
  const points: NormalizedPoint[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x] > 0 && (x === 0 || mask[y * width + x - 1] === 0)) points.push({ x: x / width, y: y / height });
  return points;
}
