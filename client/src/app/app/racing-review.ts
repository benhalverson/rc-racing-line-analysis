import { Component, type ElementRef, Input, ViewChild, signal, type AfterViewInit, type OnChanges, type OnDestroy, type SimpleChanges, inject } from '@angular/core';
import { Subscription } from 'rxjs';
import type { AlternativeWorkspace, AlternativeVersion, AlternativeAuthority, Geometry } from '../../../../shared/alternative-contract';
import { HttpClient } from '@angular/common/http';
import { connected, type RacingLineReview } from '../../../../shared/review-contract';
import type { Point } from '../../../../shared/stabilization-contract';

@Component({ selector: 'app-racing-review', templateUrl: './racing-review.html', styleUrl: './racing-review.css' })
export class RacingReview implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) analysisId = '';
  @Input() timingImportId: string | undefined;
  @ViewChild('video', { static: true }) video!: ElementRef<HTMLVideoElement>;
  @ViewChild('trackCanvas', { static: true }) trackCanvas!: ElementRef<HTMLCanvasElement>;
  readonly review = signal<RacingLineReview | undefined>(undefined);
  readonly error = signal('');
  readonly loaded = signal(false);
  readonly busy = signal(false);
  readonly seconds = signal(0);
  readonly quality = signal('No decoded frame');
  readonly selected = signal<string | null>(null);
  readonly crossingTime = signal('');
  readonly marking = signal(false);
  readonly gatePoint = signal<Point | null>(null);
  readonly frame = signal<number | null>(null);
  readonly synchronized = signal(false);
  readonly alternatives = signal<AlternativeWorkspace | undefined>(undefined);
  readonly comparedVersion = signal<string | null>(null);
  readonly alternativeName = signal('');
  readonly alternativeId = signal<string | null>(null);
  readonly alternativeBase = signal(0);
  readonly drawing = signal<Point[]>([]);
  readonly drawingMode = signal(false);
  readonly alternativeBusy = signal(false);
  readonly alternativeError = signal('');
  private alternativeEpoch = 0;
  private draftAuthority: AlternativeAuthority | undefined;
  private readonly alternativeRequests = new Subscription();
  private readonly http = inject(HttpClient);
  private generation = 0;
  private callback: number | undefined;
  private ready = false;
  private presentedMediaTime: number | undefined;

  /** Loads evidence only after the component owns its player and reference canvas. */
  ngAfterViewInit() { this.ready = true; this.reload(); }
  /** Invalidates pending requests whenever navigation changes the analysis identity. */
  ngOnChanges(changes: SimpleChanges) {
    // biome-ignore lint/complexity/useLiteralKeys: Angular SimpleChanges has an index signature.
    if (this.ready && changes['analysisId']) this.reload();
  }
  /** Stops frame callbacks and network result ownership when navigating away. */
  ngOnDestroy() { this.generation++; this.stopFrames(); this.alternativeRequests.unsubscribe(); }
  /** Fetches persisted review without contacting any timing provider. */
  reload() {
    const generation = ++this.generation;
    this.alternatives.set(undefined); this.comparedVersion.set(null); this.cancelAlternative(); this.alternativeBusy.set(false); this.alternativeError.set('');
    this.stopFrames(); this.presentedMediaTime = undefined; this.review.set(undefined); this.selected.set(null); this.error.set(''); this.loaded.set(false); this.synchronized.set(false); this.busy.set(false); this.marking.set(false); this.gatePoint.set(null);
    this.seconds.set(0); this.frame.set(null); this.quality.set('No synchronized decoded observation'); this.draw();
    this.video.nativeElement.pause();
    this.video.nativeElement.src = `/api/analyses/${encodeURIComponent(this.analysisId)}/video`;
    this.video.nativeElement.load();
    this.http.get<RacingLineReview>(`/api/analyses/${this.analysisId}/review`).subscribe({
      next: value => { if (generation === this.generation) { this.review.set(value); this.loadAlternatives(); this.draw(); } },
      error: value => { if (generation === this.generation) this.error.set(value.error?.error ?? 'Unable to load local review evidence.'); },
    });
  }
  /** Applies a revision through the server authority and ignores stale navigation responses. */
  edit(change: Record<string, unknown>) {
    const current = this.review(); if (!current || this.busy() || this.alternativeBusy()) return;
    const generation = this.generation; this.busy.set(true); this.error.set('');
    this.http.post<RacingLineReview>(`/api/analyses/${this.analysisId}/review`, { ...change, version: current.revision.version, evidenceId: current.revision.evidenceId, runId: current.revision.runId }).subscribe({
      next: value => { if (generation === this.generation) { this.busy.set(false); this.review.set(value); this.loadAlternatives(); this.draw(); } },
      error: value => { if (generation === this.generation) { this.busy.set(false); this.error.set(value.error?.error ?? 'Unable to save review revision.'); } },
    });
  }
  /** Binds an explicitly selected cached timing result, retaining its source provenance. */
  bindTiming() { if (this.timingImportId) this.edit({ action: 'timing', timingImportId: this.timingImportId }); }
  /** Selects a lap and seeks the real source player to its decoded video segment. */
  selectLap(id: string) {
    const lap = this.review()?.laps.find(l => l.crossing.id === id); if (!lap) return;
    this.selected.set(id); this.crossingTime.set(String(lap.crossing.seconds));
    this.seek(lap.videoStartSeconds);
  }
  /** Seeks without rendering geometry from a frame that has not yet reached the player. */
  seek(seconds: number) { if (!this.loaded()) return; this.synchronized.set(false); this.video.nativeElement.pause(); this.video.nativeElement.currentTime = seconds; }
  /** Rejects empty timestamps before requesting a manual source-video correction. */
  correct() {
    if (!this.crossingTime().trim() || !Number.isFinite(Number(this.crossingTime()))) { this.error.set('Enter a finite crossing timestamp.'); return; }
    this.edit({ action: 'correct', id: this.selected(), seconds: Number(this.crossingTime()) });
  }
  /** Reads the currently selected explicit lap assignment. */
  assignedLap() { return this.review()?.laps.find(l => l.crossing.id === this.selected())?.crossing.liveRcLapNumber; }
  /** Assigns one explicit LiveRC lap or clears its assignment. */
  assign(event: Event) { const value = (event.target as HTMLSelectElement).value; this.edit({ action: 'assign', id: this.selected(), lapNumber: value ? Number(value) : null }); }
  /** Captures a manual missed crossing from the actual paused source-video cursor. */
  add() { this.edit({ action: 'add', seconds: this.seconds() }); }
  /** Records two endpoint clicks in reference-pixel coordinates, independent of CSS sizing. */
  mark(event: MouseEvent) {
    if (this.drawingMode()) { this.addAlternativePoint(event); return; }
    if (!this.marking() || !this.synchronized() || this.busy()) return;
    const canvas = this.trackCanvas.nativeElement; const rect = canvas.getBoundingClientRect();
    const size = this.review()?.tracking.referenceSize; if (!size) return;
    const point = { x: (event.clientX - rect.left) * size.width / rect.width, y: (event.clientY - rect.top) * size.height / rect.height };
    const prior = this.gatePoint();
    if (!prior) this.gatePoint.set(point);
    else { this.edit({ action: 'gate', line: { a: prior, b: point } }); this.gatePoint.set(null); this.marking.set(false); }
  }
  /** Reopens immutable local revisions and scopes network results to the active analysis. */
  loadAlternatives() {
    const generation = this.generation; const epoch = ++this.alternativeEpoch; this.alternatives.set(undefined);
    this.alternativeRequests.add(this.http.get<AlternativeWorkspace>(`/api/analyses/${encodeURIComponent(this.analysisId)}/alternatives`).subscribe({
      next: value => { if (generation === this.generation && epoch === this.alternativeEpoch) { this.alternatives.set(value); this.draw(); } },
      error: value => { if (generation === this.generation && epoch === this.alternativeEpoch) this.alternativeError.set(value.error?.error ?? 'Unable to load alternatives.'); },
    }));
  }
  /** Starts a new named hypothesis on the synchronized stabilized reference. */
  newAlternative() { this.cancelAlternative(); this.marking.set(false); this.gatePoint.set(null); this.draftAuthority = this.alternatives()?.authority; this.drawingMode.set(true); this.draw(); }
  /** Revises a selected immutable version while checking the latest revision at save time. */
  reviseAlternative(version: AlternativeVersion) {
    this.marking.set(false); this.gatePoint.set(null); this.alternativeId.set(version.alternativeId);
    const latest = Math.max(...(this.alternatives()?.versions.filter(v => v.alternativeId === version.alternativeId).map(v => v.version) ?? [0]));
    this.draftAuthority = this.alternatives()?.authority; this.alternativeBase.set(latest); this.alternativeName.set(version.name); this.drawing.set(structuredClone(version.points)); this.drawingMode.set(true); this.draw();
  }
  /** Clears unsaved geometry and never changes persisted versions. */
  cancelAlternative() { this.draftAuthority = undefined; this.drawingMode.set(false); this.drawing.set([]); this.alternativeName.set(''); this.alternativeId.set(null); this.alternativeBase.set(0); if (this.ready) this.draw(); }
  /** Converts browser pointer coordinates into actual reference pixels. */
  addAlternativePoint(event: MouseEvent) {
    if (!this.synchronized() || this.alternativeBusy()) return;
    const observation = this.observation(); const transform = this.review()?.stabilization.transforms.find(t => t.frame === observation?.frame);
    if (!transform?.quality.usable) { this.alternativeError.set('Seek to a usable stabilized frame before drawing.'); return; }
    const canvas = this.trackCanvas.nativeElement; const bounds = canvas.getBoundingClientRect(); const size = this.alternatives()?.referenceSize;
    if (!size || !bounds.width || !bounds.height) return;
    this.drawing.update(points => [...points, { x: (event.clientX - bounds.left) / bounds.width * size.width, y: (event.clientY - bounds.top) / bounds.height * size.height }]); this.draw();
  }
  /** Removes one unsaved point without changing any stored revision. */
  undoAlternative() { this.drawing.update(points => points.slice(0, -1)); this.draw(); }
  /** Replaces only the unsaved draft geometry. */
  clearAlternativePoints() { this.drawing.set([]); this.draw(); }
  /** Appends a geometry-only hypothesis using explicit optimistic review and revision authority. */
  saveAlternative() {
    const workspace = this.alternatives(); if (!workspace || !this.draftAuthority || this.alternativeBusy()) return;
    if (!this.alternativeName().trim() || this.drawing().length < 2) { this.alternativeError.set('Enter a name and draw at least two distinct points.'); return; }
    const generation = this.generation; this.alternativeBusy.set(true); this.alternativeError.set('');
    this.alternativeRequests.add(this.http.post<AlternativeWorkspace>(`/api/analyses/${encodeURIComponent(this.analysisId)}/alternatives`, { ...this.draftAuthority, alternativeId: this.alternativeId(), baseVersion: this.alternativeBase(), name: this.alternativeName(), points: this.drawing() }).subscribe({
      next: value => { if (generation === this.generation) { this.alternativeBusy.set(false); ++this.alternativeEpoch; this.alternatives.set(value); this.cancelAlternative(); this.draw(); } },
      error: value => { if (generation === this.generation) { this.alternativeBusy.set(false); this.alternativeError.set(value.error?.error ?? 'Unable to save alternative.'); } },
    }));
  }
  /** Selects one historical hypothesis explicitly for the stabilized overlay comparison. */
  compareAlternative(id: string) { this.comparedVersion.set(id); this.draw(); }
  /** Formats sampling-dependent geometry with explicit unavailable values and reference units. */
  geometryLabel(value: Geometry) {
    return `Length ${value.length.toFixed(2)} reference px · mean curvature ${value.meanCurvature === null ? 'unavailable' : `${value.meanCurvature.toFixed(4)} rad/px`} · smoothness (mean turn change) ${value.turnVariationRadians === null ? 'unavailable' : `${value.turnVariationRadians.toFixed(4)} rad`} · ${value.segments} disconnected segment(s)`;
  }
  /** Starts frame callbacks after the decoder has supplied real metadata. */
  metadata() { this.loaded.set(true); this.startFrames(); }
  /** Uses the displayed frame media timestamp during playback and completed seeks. */
  startFrames() {
    this.stopFrames(); const video = this.video.nativeElement; const generation = this.generation;
    const next = () => { if (generation !== this.generation || !this.loaded()) return; this.callback = video.requestVideoFrameCallback((_now, metadata) => { if (generation !== this.generation || !this.loaded()) return; this.seconds.set(metadata.mediaTime); this.presentedMediaTime = metadata.mediaTime; this.synchronized.set(!video.seeking); this.draw(); next(); }); };
    next();
  }
  /** Resets geometry immediately during seeks; the seeked decoder frame repaints both views. */
  seeking() { this.synchronized.set(false); this.draw(); }
  /** Synchronizes paused seeks even when the browser supplies no further playback callback. */
  seeked() {
    const presented = this.presentedMediaTime;
    const targetFrame = this.observationAt(this.video.nativeElement.currentTime);
    const presentedFrame = presented === undefined ? undefined : this.observationAt(presented);
    if (presented !== undefined && targetFrame && presentedFrame?.frame === targetFrame.frame) {
      this.seconds.set(presented); this.synchronized.set(true); this.draw();
    }
  }
  /** Reports unavailable source footage without retaining an accepted overlay. */
  videoError() { this.stopFrames(); this.loaded.set(false); this.synchronized.set(false); this.error.set('Unable to decode the original local video.'); this.draw(); }
  /** Cancels the currently registered browser frame callback. */
  private stopFrames() { if (this.callback !== undefined) this.video.nativeElement.cancelVideoFrameCallback(this.callback); this.callback = undefined; }
  /** Chooses the containing decoded frame, never a future nearest observation. */
  observation() { return this.observationAt(this.seconds()); }
  /** Resolves a decoded timestamp within its actual presentation interval. */
  private observationAt(time: number) {
    const values = this.review()?.tracking.observations ?? [];
    let index = -1;
    for (let i = 0; i < values.length && values[i].seconds <= time + 1e-6; i++) index = i;
    if (index < 0) return undefined;
    const current = values[index]; const next = values[index + 1];
    const span = next ? next.seconds - current.seconds : current.seconds - (values[index - 1]?.seconds ?? current.seconds);
    return time < current.seconds + span + 1e-6 ? current : undefined;
  }
  /** Places the source box in percentages of actual decoded source dimensions. */
  boxStyle() {
    const box = this.synchronized() ? this.observation()?.box : null; const size = this.review()?.tracking.referenceSize;
    return box && size ? `left:${box.x / size.width * 100}%;top:${box.y / size.height * 100}%;width:${box.width / size.width * 100}%;height:${box.height / size.height * 100}%` : 'display:none';
  }
  /** Renders transformed source pixels and disconnected observed line segments at the displayed timestamp. */
  private draw() {
    const review = this.review(); const canvas = this.trackCanvas.nativeElement; const context = canvas.getContext('2d'); if (!context) return;
    const size = review?.tracking.referenceSize;
    const previewScale = size ? Math.min(1, 960 / size.width) : 1;
    canvas.width = Math.round((size?.width ?? 640) * previewScale); canvas.height = Math.round((size?.height ?? 360) * previewScale);
    context.fillStyle = '#111719'; context.fillRect(0, 0, canvas.width, canvas.height);
    const observation = this.synchronized() ? this.observation() : undefined;
    this.frame.set(observation?.frame ?? null);
    this.quality.set(observation ? `${observation.quality} · ${observation.reason}` : 'No synchronized decoded observation');
    if (!review || !observation || !this.loaded()) return;
    const transform = review.stabilization.transforms.find(t => t.frame === observation.frame);
    if (transform?.quality.usable && transform.matrix.length === 6) {
      const m = transform.matrix;
      context.setTransform(m[0] * previewScale, m[3] * previewScale, m[1] * previewScale, m[4] * previewScale, m[2] * previewScale, m[5] * previewScale);
      context.drawImage(this.video.nativeElement, 0, 0, review.tracking.referenceSize.width, review.tracking.referenceSize.height);
      context.resetTransform();
    } else if (transform?.quality.usable) {
      // Inverse mapping handles both affine and projective reference-pixel transforms.
      const m = transform.matrix.length === 6 ? [...transform.matrix, 0, 0, 1] : transform.matrix;
      const inverse = invert(m);
      if (inverse) {
        const capture = document.createElement('canvas'); capture.width = canvas.width; capture.height = canvas.height;
        const source = capture.getContext('2d');
        if (source) {
          source.drawImage(this.video.nativeElement, 0, 0, capture.width, capture.height);
          const pixels = source.getImageData(0, 0, capture.width, capture.height); const output = context.createImageData(canvas.width, canvas.height);
          for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
            const rx = x / previewScale; const ry = y / previewScale;
            const d = inverse[6] * rx + inverse[7] * ry + inverse[8]; if (Math.abs(d) < 1e-9) continue;
            const sx = Math.round((inverse[0] * rx + inverse[1] * ry + inverse[2]) / d * previewScale); const sy = Math.round((inverse[3] * rx + inverse[4] * ry + inverse[5]) / d * previewScale);
            if (sx < 0 || sy < 0 || sx >= canvas.width || sy >= canvas.height) continue;
            const from = (sy * canvas.width + sx) * 4; const to = (y * canvas.width + x) * 4;
            output.data.set(pixels.data.subarray(from, from + 4), to);
          }
          context.putImageData(output, 0, 0);
        }
      }
    } else this.quality.update(q => `${q} · stabilization rejected`);
    context.scale(previewScale, previewScale);
    const selected = review.laps.find(l => l.crossing.id === this.selected());
    const observations = review.tracking.observations.filter(o => o.seconds <= this.seconds() && (!selected || o.seconds >= selected.videoStartSeconds && o.seconds <= selected.videoEndSeconds));
    context.strokeStyle = '#71e1d0'; context.lineWidth = Math.max(1, canvas.width / 250);
    for (let i = 1; i < observations.length; i++) {
      const a = observations[i - 1]; const b = observations[i];
      if (!connected(a, b) || !a.trackPoint || !b.trackPoint || !review.stabilization.transforms.find(t => t.frame === a.frame)?.quality.usable || !review.stabilization.transforms.find(t => t.frame === b.frame)?.quality.usable) continue;
      context.beginPath(); context.moveTo(a.trackPoint.x, a.trackPoint.y); context.lineTo(b.trackPoint.x, b.trackPoint.y); context.stroke();
    }
    // Saved hypotheses are drawn separately and never connected to observed samples.
    context.strokeStyle = '#bc9bff'; context.setLineDash([4, 4]);
    for (const version of this.alternatives()?.versions ?? []) {
      if (!version.current || (this.comparedVersion() ? version.id !== this.comparedVersion() : this.alternatives()?.versions.some(v => v.alternativeId === version.alternativeId && v.version > version.version && v.current))) continue;
      context.beginPath(); version.points.forEach((p, i) => { if (i === 0) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y); }); context.stroke();
    }
    context.setLineDash([]); context.strokeStyle = '#ffb76b';
    const draft = this.drawing();
    context.beginPath(); draft.forEach((p, i) => { if (i === 0) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y); }); context.stroke();
    for (const p of draft) { context.fillStyle = '#ffb76b'; context.beginPath(); context.arc(p.x, p.y, 2, 0, Math.PI * 2); context.fill(); }
    const line = review.revision.startFinish;
    if (line) { context.strokeStyle = '#f5d06f'; context.beginPath(); context.moveTo(line.a.x, line.a.y); context.lineTo(line.b.x, line.b.y); context.stroke(); }
    if (observation.trackPoint && transform?.quality.usable) { context.fillStyle = '#71e1d0'; context.beginPath(); context.arc(observation.trackPoint.x, observation.trackPoint.y, Math.max(2, canvas.width / 150), 0, Math.PI * 2); context.fill(); }
  }
}

/** Inverts a source-to-reference homography; singular transforms render no warped image. */
function invert(m: number[]): number[] | null {
  const [a,b,c,d,e,f,g,h,i] = m;
  const values = [e*i-f*h,c*h-b*i,b*f-c*e,f*g-d*i,a*i-c*g,c*d-a*f,d*h-e*g,b*g-a*h,a*e-b*d];
  const determinant = a*values[0]+b*values[3]+c*values[6];
  return Number.isFinite(determinant) && Math.abs(determinant) > 1e-9 ? values.map(v => v / determinant) : null;
}
