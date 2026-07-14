export class BrowserVideoAdapter {
  private readonly video: HTMLVideoElement;
  private objectUrl?: string;
  constructor(createVideo: () => HTMLVideoElement = () => document.createElement('video')) { this.video = createVideo(); this.video.preload = 'metadata'; }
  async load(blob: Blob) { if (!blob.type.startsWith('video/')) throw new Error('unsupported video file'); this.revokeObjectUrl(); this.objectUrl = URL.createObjectURL(blob); this.video.src = this.objectUrl; this.video.load(); await new Promise<void>((resolve, reject) => { this.video.onloadedmetadata = () => resolve(); this.video.onerror = () => reject(new Error('unable to read video metadata')); }); return this.video; }
  async frameAt(seconds: number): Promise<ImageBitmap> { if (!Number.isFinite(seconds) || seconds < 0 || seconds > this.video.duration) throw new Error('timestamp is outside the video'); this.video.currentTime = seconds; await new Promise<void>((resolve) => { this.video.onseeked = () => resolve(); }); return createImageBitmap(this.video); }
  dispose() { this.revokeObjectUrl(); this.video.removeAttribute('src'); this.video.load(); }
  private revokeObjectUrl() { if (this.objectUrl) URL.revokeObjectURL(this.objectUrl); this.objectUrl = undefined; }
}
