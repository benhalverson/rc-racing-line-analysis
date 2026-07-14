import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import type { NormalizedBox } from '../../../../shared/calibration-contract';
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
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50, width: 400, height: 200, right: 500, bottom: 250, x: 100, y: 50, toJSON: () => ({}) });
    const placed = vi.fn();
    canvas.markerPlaced.subscribe(placed);
    canvas.pointerDown(new PointerEvent('pointerdown', { clientX: 200, clientY: 150 }));
    expect(placed).toHaveBeenCalledWith({ x: 0.25, y: 0.5 });
  });

  it('normalizes a box in any drag direction, clamps it, and replaces it in the parent through one output', () => {
    const fixture = TestBed.createComponent(CalibrationCanvas);
    const canvas = fixture.componentInstance;
    canvas.mode = 'car';
    fixture.detectChanges();
    const element = fixture.nativeElement.querySelector('.calibration-hit-area') as HTMLDivElement;
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
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
});
