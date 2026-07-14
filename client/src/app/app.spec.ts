import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { throwError } from 'rxjs';
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
});
