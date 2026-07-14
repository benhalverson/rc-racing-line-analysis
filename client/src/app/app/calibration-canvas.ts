import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, type ElementRef, EventEmitter, Input, Output, ViewChild, inject, signal, type AfterViewInit, type OnChanges, type OnDestroy, type SimpleChanges } from '@angular/core';
import type { CorrectionMarker, LocalVideoRef, NormalizedBox, NormalizedPoint } from '../../../../shared/calibration-contract';
import { BrowserSqliteStore } from './browser-sqlite';
import { detectGreenMarkers } from './green-marker-detector';

export type CalibrationMode = 'idle' | 'marker' | 'car';

@Component({
  selector: 'app-calibration-canvas',
  imports: [DecimalPipe],
  templateUrl: './calibration-canvas.html',
  styleUrl: './calibration-canvas.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CalibrationCanvas implements AfterViewInit, OnChanges, OnDestroy {
  @Input() videoRef: LocalVideoRef | undefined;
  @Input() markers: CorrectionMarker[] = [];
  @Input() selectedCarBox: NormalizedBox | null = null;
  @Input() mode: CalibrationMode = 'idle';
  @Input() markerReferenceSeconds: number | null = null;
  @Output() markerPlaced = new EventEmitter<NormalizedPoint>();
  @Output() markerMoved = new EventEmitter<{ id: string; position: NormalizedPoint }>();
  @Output() markersDetected = new EventEmitter<NormalizedPoint[]>();
  @Output() carBoxSelected = new EventEmitter<NormalizedBox>();
  @Output() videoLoaded = new EventEmitter<void>();
  @ViewChild('video', { static: true }) private videoElement!: ElementRef<HTMLVideoElement>;
  @ViewChild('canvas', { static: true }) private canvasElement!: ElementRef<HTMLCanvasElement>;
  @ViewChild('hitArea', { static: true }) private hitAreaElement!: ElementRef<HTMLDivElement>;

  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly videoWidth = signal(0);
  readonly videoHeight = signal(0);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly isLoaded = signal(false);
  readonly detectionCount = signal<number | null>(null);
  readonly detectionError = signal('');
  readonly detecting = signal(false);

  private readonly store = inject(BrowserSqliteStore);
  private objectUrl?: string;
  private loadGeneration = 0;
  private dragStart: NormalizedPoint | undefined;
  private dragCurrent: NormalizedPoint | undefined;
  private dragMarkerId: string | undefined;

  ngAfterViewInit() {
    if (this.videoRef) void this.loadStoredVideo(this.videoRef);
  }

  ngOnChanges(changes: SimpleChanges) {
    // biome-ignore lint/complexity/useLiteralKeys: Angular SimpleChanges uses an index signature.
    const videoChange = changes['videoRef'];
    if (videoChange && this.videoRef && this.videoRef.id !== videoChange.previousValue?.id) {
      void this.loadStoredVideo(this.videoRef);
    }
    this.drawOverlay();
  }

  ngOnDestroy() {
    this.loadGeneration += 1;
    this.revokeObjectUrl();
  }

  async loadStoredVideo(ref: LocalVideoRef) {
    const generation = ++this.loadGeneration;
    this.loading.set(true);
    this.error.set('');
    this.isLoaded.set(false);
    try {
      const blob = await this.store.loadVideo(ref.id);
      if (generation !== this.loadGeneration) return;
      this.revokeObjectUrl();
      this.objectUrl = URL.createObjectURL(blob);
      const video = this.videoElement.nativeElement;
      video.src = this.objectUrl;
      video.load();
    } catch (error) {
      if (generation === this.loadGeneration) this.error.set(error instanceof Error ? error.message : 'Unable to load the stored video.');
    } finally {
      if (generation === this.loadGeneration) this.loading.set(false);
    }
  }

  onLoadedMetadata() {
    const video = this.videoElement.nativeElement;
    this.videoWidth.set(video.videoWidth);
    this.videoHeight.set(video.videoHeight);
    this.duration.set(Number.isFinite(video.duration) ? video.duration : 0);
    this.currentTime.set(Number.isFinite(video.currentTime) ? video.currentTime : 0);
    this.isLoaded.set(video.videoWidth > 0 && video.videoHeight > 0);
    this.drawOverlay();
    this.videoLoaded.emit();
  }

  onTimeUpdate() {
    const time = this.videoElement.nativeElement.currentTime;
    this.currentTime.set(Number.isFinite(time) ? time : 0);
    this.drawOverlay();
  }

  pointerDown(event: PointerEvent) {
    const point = this.normalizedPoint(event);
    if (!point) return;
    if (this.mode === 'marker') {
      const marker = this.nearestMarker(point);
      if (marker) {
        this.dragMarkerId = marker.id;
        this.dragStart = point;
        this.dragCurrent = point;
        (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
      } else {
        this.markerPlaced.emit(point);
      }
      this.drawOverlay();
      return;
    }
    if (this.mode !== 'car') return;
    this.dragStart = point;
    this.dragCurrent = point;
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    this.drawOverlay();
  }

  pointerMove(event: PointerEvent) {
    if (!this.dragStart) return;
    this.dragCurrent = this.normalizedPoint(event) ?? this.dragCurrent;
    this.drawOverlay();
  }

  pointerUp(event: PointerEvent) {
    if (!this.dragStart) return;
    const end = this.normalizedPoint(event) ?? this.dragCurrent;
    const start = this.dragStart;
    const markerId = this.dragMarkerId;
    this.dragStart = undefined;
    this.dragCurrent = undefined;
    this.dragMarkerId = undefined;
    if (markerId && end && (end.x !== start.x || end.y !== start.y)) this.markerMoved.emit({ id: markerId, position: end });
    if (!markerId && end && end.x !== start.x && end.y !== start.y) {
      this.carBoxSelected.emit({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) });
    }
    this.drawOverlay();
  }

  pointerCancel() {
    this.dragStart = undefined;
    this.dragCurrent = undefined;
    this.dragMarkerId = undefined;
    this.drawOverlay();
  }

  async detectGreenMarkers() {
    if (!this.isLoaded() || this.markerReferenceSeconds === null || this.detecting()) return;
    this.detecting.set(true);
    this.detectionError.set('');
    try {
      const video = this.videoElement.nativeElement;
      await this.seek(video, this.markerReferenceSeconds);
      const capture = document.createElement('canvas');
      capture.width = video.videoWidth;
      capture.height = video.videoHeight;
      const context = capture.getContext('2d');
      if (!context) throw new Error('Unable to create a frame capture context.');
      context.drawImage(video, 0, 0, capture.width, capture.height);
      const points = detectGreenMarkers(context.getImageData(0, 0, capture.width, capture.height));
      this.detectionCount.set(points.length);
      this.markersDetected.emit(points);
    } catch (error) {
      this.detectionError.set(error instanceof Error ? error.message : 'Unable to detect green markers.');
    } finally {
      this.detecting.set(false);
    }
  }

  private seek(video: HTMLVideoElement, seconds: number) {
    if (Math.abs(video.currentTime - seconds) < 0.01) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onSeeked = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('Unable to seek to the marker frame.')); };
      const cleanup = () => { video.removeEventListener('seeked', onSeeked); video.removeEventListener('error', onError); };
      video.addEventListener('seeked', onSeeked, { once: true });
      video.addEventListener('error', onError, { once: true });
      video.currentTime = seconds;
    });
  }

  private nearestMarker(point: NormalizedPoint): CorrectionMarker | undefined {
    const threshold = 0.04;
    return this.markers.reduce<CorrectionMarker | undefined>((nearest, marker) => {
      const distance = Math.hypot(marker.position.x - point.x, marker.position.y - point.y);
      return distance <= threshold && (!nearest || distance < Math.hypot(nearest.position.x - point.x, nearest.position.y - point.y)) ? marker : nearest;
    }, undefined);
  }

  private normalizedPoint(event: PointerEvent): NormalizedPoint | undefined {
    const rect = this.hitAreaElement.nativeElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return undefined;
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
  }

  private drawOverlay() {
    const canvas = this.canvasElement?.nativeElement;
    const width = this.videoWidth();
    const height = this.videoHeight();
    if (!canvas || !width || !height) return;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.lineWidth = Math.max(2, width / 400);
    for (const marker of this.markers) {
      const x = marker.position.x * width;
      const y = marker.position.y * height;
      context.fillStyle = marker.source === 'detected' ? '#39d98a' : '#f4c95d';
      context.beginPath();
      context.arc(x, y, Math.max(5, width / 120), 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = '#17202b';
      context.stroke();
    }
    const box = this.dragStart && this.dragCurrent ? boxFromPoints(this.dragStart, this.dragCurrent) : this.selectedCarBox;
    if (box) {
      context.strokeStyle = '#6ee7b7';
      context.setLineDash([Math.max(5, width / 150), Math.max(4, width / 220)]);
      context.strokeRect(box.x * width, box.y * height, box.width * width, box.height * height);
      context.setLineDash([]);
    }
  }

  private revokeObjectUrl() {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
  }
}

function clamp(value: number) { return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)); }
function boxFromPoints(start: NormalizedPoint, end: NormalizedPoint): NormalizedBox { return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }; }
