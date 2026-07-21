import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import type { NormalizedBox } from '../../../../shared/calibration-contract';
import type { CorrectionMarker } from '../../../../shared/calibration-contract';
import { BrowserSqliteStore } from './browser-sqlite';
import { CalibrationCanvas } from './calibration-canvas';

describe('CalibrationCanvas', () => {
  const videoRef = { id: 'video-1', name: 'race.mp4', mimeType: 'video/mp4', size: 1, lastModified: 1 };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CalibrationCanvas],
      providers: [{ provide: BrowserSqliteStore, useValue: { loadVideo: vi.fn().mockResolvedValue(new Blob(['video'], { type: 'video/mp4' })) } }],
    }).compileComponents();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:race');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  });

  it('loads the stored video Blob into the video element and revokes its object URL', async () => {
    const fixture = TestBed.createComponent(CalibrationCanvas);
    const canvas = fixture.componentInstance;
    canvas.videoRef = videoRef;
    fixture.detectChanges();
    await canvas.loadStoredVideo(videoRef);
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    expect(video.src).toContain('blob:race');
    canvas.ngOnDestroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:race');
  });

  it('converts pointer coordinates to normalized marker coordinates', () => {
    const fixture = TestBed.createComponent(CalibrationCanvas);
    const canvas = fixture.componentInstance;
    canvas.mode = 'marker';
    fixture.detectChanges();
    const element = fixture.nativeElement.querySelector('.calibration-hit-area') as HTMLDivElement;
    const rect = { left: 100, top: 50, width: 400, height: 200, right: 500, bottom: 250, x: 100, y: 50, toJSON: () => ({}) };
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(fixture.nativeElement.querySelector('canvas'), 'getBoundingClientRect').mockReturnValue(rect);
    const placed = vi.fn();
    canvas.markerPlaced.subscribe(placed);
    canvas.pointerDown(new PointerEvent('pointerdown', { clientX: 200, clientY: 150 }));
    expect(placed).toHaveBeenCalledWith({ x: 0.25, y: 0.5 });
  });

  it('uses the full canvas coordinate space when the hit area avoids video controls', () => {
    const fixture = TestBed.createComponent(CalibrationCanvas);
    const canvas = fixture.componentInstance;
    canvas.mode = 'marker';
    fixture.detectChanges();
    const hitArea = fixture.nativeElement.querySelector('.calibration-hit-area') as HTMLDivElement;
    const canvasElement = fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    vi.spyOn(hitArea, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50, width: 400, height: 154, right: 500, bottom: 204, x: 100, y: 50, toJSON: () => ({}) });
    vi.spyOn(canvasElement, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50, width: 400, height: 200, right: 500, bottom: 250, x: 100, y: 50, toJSON: () => ({}) });
    const placed = vi.fn();
    canvas.markerPlaced.subscribe(placed);

    canvas.pointerDown(new PointerEvent('pointerdown', { clientX: 300, clientY: 150 }));

    expect(placed).toHaveBeenCalledWith({ x: 0.5, y: 0.5 });
  });

  it('normalizes a box in any drag direction, clamps it, and replaces it in the parent through one output', () => {
    const fixture = TestBed.createComponent(CalibrationCanvas);
    const canvas = fixture.componentInstance;
    canvas.mode = 'car';
    fixture.detectChanges();
    const element = fixture.nativeElement.querySelector('.calibration-hit-area') as HTMLDivElement;
    const rect = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) };
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(fixture.nativeElement.querySelector('canvas'), 'getBoundingClientRect').mockReturnValue(rect);
    const selected: NormalizedBox[] = [];
    canvas.carBoxSelected.subscribe((box) => selected.push(box));
    canvas.pointerDown(new PointerEvent('pointerdown', { clientX: 90, clientY: 80, pointerId: 1 }));
    canvas.pointerUp(new PointerEvent('pointerup', { clientX: -10, clientY: 120, pointerId: 1 }));
    canvas.pointerDown(new PointerEvent('pointerdown', { clientX: 10, clientY: 20, pointerId: 2 }));
    canvas.pointerUp(new PointerEvent('pointerup', { clientX: 40, clientY: 60, pointerId: 2 }));
    expect(selected).toHaveLength(2);
    expect(selected[0]).toMatchObject({ x: 0, y: 0.8, width: 0.9 });
    expect(selected[0].height).toBeCloseTo(0.2);
    expect(selected[1]).toMatchObject({ x: 0.1, y: 0.2 });
    expect(selected[1].width).toBeCloseTo(0.3);
    expect(selected[1].height).toBeCloseTo(0.4);
  });

  it('moves an existing detected marker instead of adding another marker', () => {
    const fixture = TestBed.createComponent(CalibrationCanvas);
    const canvas = fixture.componentInstance;
    canvas.mode = 'marker';
    canvas.markers = [{ id: 'detected-1', position: { x: 0.25, y: 0.5 }, source: 'detected' } satisfies CorrectionMarker];
    fixture.detectChanges();
    const element = fixture.nativeElement.querySelector('.calibration-hit-area') as HTMLDivElement;
    const rect = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) };
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(fixture.nativeElement.querySelector('canvas'), 'getBoundingClientRect').mockReturnValue(rect);
    const moved = vi.fn();
    const placed = vi.fn();
    canvas.markerMoved.subscribe(moved);
    canvas.markerPlaced.subscribe(placed);
    canvas.pointerDown(new PointerEvent('pointerdown', { clientX: 25, clientY: 50, pointerId: 1 }));
    canvas.pointerUp(new PointerEvent('pointerup', { clientX: 40, clientY: 60, pointerId: 1 }));
    expect(moved).toHaveBeenCalledWith({ id: 'detected-1', position: { x: 0.4, y: 0.6 } });
    expect(placed).not.toHaveBeenCalled();
  });

  it('adds a manual marker when marker mode starts on empty space', () => {
    const fixture = TestBed.createComponent(CalibrationCanvas);
    const canvas = fixture.componentInstance;
    canvas.mode = 'marker';
    fixture.detectChanges();
    const element = fixture.nativeElement.querySelector('.calibration-hit-area') as HTMLDivElement;
    const rect = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) };
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(fixture.nativeElement.querySelector('canvas'), 'getBoundingClientRect').mockReturnValue(rect);
    const placed = vi.fn();
    canvas.markerPlaced.subscribe(placed);
    canvas.pointerDown(new PointerEvent('pointerdown', { clientX: 90, clientY: 10 }));
    expect(placed).toHaveBeenCalledWith({ x: 0.9, y: 0.1 });
  });

  it('only resizes the overlay canvas when video dimensions change', () => {
    const fixture = TestBed.createComponent(CalibrationCanvas);
    const canvas = fixture.componentInstance;
    fixture.detectChanges();
    const element = fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    let canvasWidth = 0;
    let canvasHeight = 0;
    let widthAssignments = 0;
    let heightAssignments = 0;
    Object.defineProperties(element, {
      width: { configurable: true, get: () => canvasWidth, set: (value: number) => { canvasWidth = value; widthAssignments += 1; } },
      height: { configurable: true, get: () => canvasHeight, set: (value: number) => { canvasHeight = value; heightAssignments += 1; } },
    });
    vi.spyOn(element, 'getContext').mockReturnValue({ clearRect: vi.fn() } as unknown as CanvasRenderingContext2D);

    canvas.videoWidth.set(1920);
    canvas.videoHeight.set(1080);
    canvas.ngOnChanges({});
    canvas.ngOnChanges({});
    expect(widthAssignments).toBe(1);
    expect(heightAssignments).toBe(1);

    canvas.videoWidth.set(1280);
    canvas.ngOnChanges({});
    expect(widthAssignments).toBe(2);
    expect(heightAssignments).toBe(1);
  });
});
