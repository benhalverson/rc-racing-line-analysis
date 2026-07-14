export class BrowserVideoAdapter {
  private readonly video: HTMLVideoElement;
  constructor(createVideo: () => HTMLVideoElement = () => document.createElement('video')) { this.video = createVideo(); this.video.preload = 'metadata'; }
  async load(blob: Blob) { if (!blob.type.startsWith('video/')) throw new Error('unsupported video file'); this.video.src = URL.createObjectURL(blob); await new Promise<void>((resolve, reject) => { this.video.onloadedmetadata = () => resolve(); this.video.onerror = () => reject(new Error('unable to read video metadata')); }); return this.video; }
  async frameAt(seconds: number): Promise<ImageBitmap> { if (!Number.isFinite(seconds) || seconds < 0 || seconds > this.video.duration) throw new Error('timestamp is outside the video'); this.video.currentTime = seconds; await new Promise<void>((resolve) => { this.video.onseeked = () => resolve(); }); return createImageBitmap(this.video); }
  dispose() { if (this.video.src) URL.revokeObjectURL(this.video.src); this.video.removeAttribute('src'); }
}
