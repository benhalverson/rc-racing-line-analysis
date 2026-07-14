import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { of, Subject, throwError } from 'rxjs';
import { vi } from 'vitest';
import { App } from './app';
import { BrowserSqliteStore } from './app/browser-sqlite';
import { TimingApi } from './app/timing-api';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideHttpClient(),
        { provide: BrowserSqliteStore, useValue: { saveVideo: vi.fn(), loadVideo: vi.fn(), saveCorrectionSet: vi.fn() } },
      ],
    }).compileComponents();
  });

  it('uses the selected track URL and surfaces archived-event API details', () => {
    const events = vi.fn().mockReturnValue(throwError(() => ({ error: { error: 'LiveRC returned HTTP 502' } })));
    TestBed.overrideProvider(TimingApi, { useValue: { events, tracks: vi.fn(), races: vi.fn(), drivers: vi.fn(), import: vi.fn() } });
    const fixture = TestBed.createComponent(App);
    fixture.componentInstance.chooseTrack({ host: 'norcalhobbies.liverc.com', name: 'Nor-Cal Hobbies', url: 'https://norcalhobbies.liverc.com/' });
    expect(events).toHaveBeenCalledWith('https://norcalhobbies.liverc.com/');
    expect(fixture.componentInstance.timingError()).toBe('LiveRC returned HTTP 502');
    fixture.componentInstance.chooseTrack(undefined);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the analysis workspace', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Local analysis workspace');
  });

  it('disables Begin calibration once calibration is active', () => {
    const fixture = TestBed.createComponent(App);
    fixture.componentInstance.analysis.set({
      id: 'analysis-1', videoPath: 'browser-sqlite://video-1', videoName: 'race.mp4', carDescription: null,
      state: 'awaiting_calibration', phase: 'calibrating', progress: 0, checkpoint: 'calibration-started',
      error: null, createdAt: '', updatedAt: '', videoStorage: 'browser-sqlite',
      localVideoRef: { id: 'video-1', name: 'race.mp4', mimeType: 'video/mp4', size: 1, lastModified: 1 },
      acceptedCorrectionSetId: null,
    });
    fixture.detectChanges();
    const panel = fixture.nativeElement as HTMLElement;
    expect(panel.querySelector('.calibration-panel button')?.hasAttribute('disabled')).toBe(true);
    expect(panel.querySelector('app-calibration-canvas')).toBeTruthy();
    expect(panel.textContent).toContain('Set race start');
    expect(panel.textContent).toContain('Set marker frame');
    expect(panel.textContent).toContain('Set car frame');
    expect(panel.textContent).toContain('Set race start on the video.');
    fixture.destroy();
  });

  it('fills the video path as soon as a file is selected', () => {
    TestBed.overrideProvider(BrowserSqliteStore, { useValue: { saveVideo: vi.fn().mockResolvedValue({ id: 'video-1' }) } });
    const fixture = TestBed.createComponent(App);
    fixture.componentInstance.selectVideo({ target: { files: [new File(['video'], 'race.mp4')] } } as unknown as Event);
    expect(fixture.componentInstance.videoPath()).toBe('race.mp4');
    fixture.destroy();
  });

  it('renders duplicate driver names as distinct options and ignores an obsolete driver response', async () => {
    const oldDrivers = new Subject<{ drivers: { name: string; normalizedName: string; driverId?: string }[] }>();
    const currentDrivers = new Subject<{ drivers: { name: string; normalizedName: string; driverId?: string }[] }>();
    const timingApi = { events: vi.fn().mockReturnValue(of({ events: [] })), tracks: vi.fn(), races: vi.fn().mockReturnValue(of({ races: [] })), drivers: vi.fn((url: string) => url === 'race-url' ? oldDrivers : currentDrivers), import: vi.fn() };
    TestBed.overrideProvider(TimingApi, { useValue: timingApi });
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    app.chooseTrack({ host: 'track', name: 'Track', url: 'track-url' });
    app.chooseEvent({ name: 'Event', url: 'event-url' });
    app.chooseRace({ id: '1', label: 'Main', url: 'race-url' });
    app.setClassLabel('Buggy');
    oldDrivers.next({ drivers: [{ name: 'Alex Smith', normalizedName: 'alex smith' }, { name: 'Alex Smith', normalizedName: 'alex smith' }] });
    await fixture.whenStable();
    const options = fixture.nativeElement.querySelectorAll('#driver-choice option');
    expect(options).toHaveLength(3);
    expect(options[1].getAttribute('value')).not.toBe(options[2].getAttribute('value'));
    app.chooseRace({ id: '2', label: 'Other Main', url: 'other-race-url' });
    oldDrivers.next({ drivers: [{ name: 'Old Driver', normalizedName: 'old driver' }] });
    await fixture.whenStable();
    expect(app.drivers()).toEqual([]);
  });

  it('requires confirmation for the exact current result and invalidates stale confirmation', () => {
    const importTiming = vi.fn().mockReturnValue(of({ driverName: 'Alex Smith', laps: [] }));
    const timingApi = {
      events: vi.fn().mockReturnValue(of({ events: [] })),
      tracks: vi.fn(), races: vi.fn().mockReturnValue(of({ races: [] })), drivers: vi.fn().mockReturnValue(of({ drivers: [] })),
      import: importTiming, savedImports: vi.fn(), loadImport: vi.fn(),
    };
    TestBed.overrideProvider(TimingApi, { useValue: timingApi });
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    app.chooseTrack({ host: 'track.liverc.com', name: 'Track', url: 'https://track.liverc.com/' });
    app.chooseEvent({ name: 'Event', url: 'https://track.liverc.com/event' });
    app.chooseRace({ id: '44', label: 'Main', url: 'https://track.liverc.com/results/?id=44&p=view_race_result' });
    app.chooseDriver({ name: 'Alex Smith', normalizedName: 'alex smith', driverId: '7' });
    app.setClassLabel('Buggy');
    app.importSelectedTiming();
    expect(importTiming).not.toHaveBeenCalled();
    app.reviewSelectedTiming();
    app.importSelectedTiming();
    expect(importTiming).toHaveBeenCalledTimes(1);
    app.setClassLabel('Truggy');
    app.importSelectedTiming();
    expect(importTiming).toHaveBeenCalledTimes(1);
    expect(app.timingError()).toContain('Review and confirm');
    fixture.destroy();
  });

  it('reopens persisted imports without invoking LiveRC discovery', () => {
    const loadImport = vi.fn().mockReturnValue(of({
      id: 'saved-1', source: 'liverc', trackHost: 'track.liverc.com', trackName: 'Track', trackUrl: 'https://track.liverc.com/',
      eventName: 'Event', eventUrl: 'https://track.liverc.com/event', raceId: '44', raceLabel: 'Main', roundLabel: 'Round', classLabel: 'Buggy',
      raceUrl: 'https://track.liverc.com/results/?id=44&p=view_race_result', driverName: 'Alex Smith', normalizedDriverName: 'alex smith', driverId: '7',
      fetchedAt: '2026-07-14T00:00:00.000Z', parserVersion: 'liverc-html-v1', sourceHash: 'hash', laps: [],
    }));
    const timingApi = { events: vi.fn(), tracks: vi.fn(), races: vi.fn(), drivers: vi.fn(), import: vi.fn(), savedImports: vi.fn(), loadImport };
    TestBed.overrideProvider(TimingApi, { useValue: timingApi });
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    app.reopenImport('saved-1');
    expect(loadImport).toHaveBeenCalledWith('saved-1');
    expect(timingApi.events).not.toHaveBeenCalled();
    expect(timingApi.races).not.toHaveBeenCalled();
    expect(timingApi.drivers).not.toHaveBeenCalled();
    expect(app.timingSelection().importedResult?.id).toBe('saved-1');
    expect(app.timingSelection().driver?.driverId).toBe('7');
    fixture.destroy();
  });
});
