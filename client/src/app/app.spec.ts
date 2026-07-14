import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { throwError } from 'rxjs';
import { of, Subject } from 'rxjs';
import { vi } from 'vitest';
import { App } from './app';
import { TimingApi } from './app/timing-api';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient()],
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

  it('renders duplicate driver names as distinct options and ignores an obsolete driver response', async () => {
    const oldDrivers = new Subject<{ drivers: { name: string; normalizedName: string }[] }>();
    const currentDrivers = new Subject<{ drivers: { name: string; normalizedName: string }[] }>();
    const timingApi = { events: vi.fn().mockReturnValue(of({ events: [] })), tracks: vi.fn(), races: vi.fn().mockReturnValue(of({ races: [] })), drivers: vi.fn((url: string) => url === 'race-url' ? oldDrivers : currentDrivers), import: vi.fn() };
    TestBed.overrideProvider(TimingApi, { useValue: timingApi });
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    app.chooseTrack({ host: 'track', name: 'Track', url: 'track-url' });
    app.chooseEvent({ name: 'Event', url: 'event-url' });
    app.chooseRace({ id: null, label: 'Main', url: 'race-url' });
    app.setClassLabel('Buggy');
    oldDrivers.next({ drivers: [{ name: 'Alex Smith', normalizedName: 'alex smith' }, { name: 'Alex Smith', normalizedName: 'alex smith' }] });
    await fixture.whenStable();
    const options = fixture.nativeElement.querySelectorAll('#driver-choice option');
    expect(options).toHaveLength(3);
    expect(options[1].getAttribute('value')).not.toBe(options[2].getAttribute('value'));
    app.chooseRace({ id: null, label: 'Other Main', url: 'other-race-url' });
    oldDrivers.next({ drivers: [{ name: 'Old Driver', normalizedName: 'old driver' }] });
    await fixture.whenStable();
    expect(app.drivers()).toEqual([]);
  });
});
