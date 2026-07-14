import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { AnalysisApi, type Analysis, type AnalysisConnectionState } from './app/analysis-api';
import { TimingApi, type TimingDriver, type TimingEvent, type TimingImport, type TimingRace, type TimingTrack } from './app/timing-api';
@Component({
  selector: 'app-root',
  imports: [DecimalPipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly api = inject(AnalysisApi);
  private readonly timingApi = inject(TimingApi);
  private readonly destroyRef = inject(DestroyRef);
  private updates?: Subscription;
  readonly videoPath = signal('');
  readonly carDescription = signal('');
  readonly message = signal('');
  readonly analysis = signal<Analysis | undefined>(undefined);
  readonly connectionState = signal<AnalysisConnectionState>('disconnected');
  readonly tracks = signal<TimingTrack[]>([]);
  readonly events = signal<TimingEvent[]>([]);
  readonly races = signal<TimingRace[]>([]);
  readonly drivers = signal<TimingDriver[]>([]);
  readonly selectedTrack = signal<TimingTrack | undefined>(undefined);
  readonly selectedEvent = signal<TimingEvent | undefined>(undefined);
  readonly selectedRace = signal<TimingRace | undefined>(undefined);
  readonly selectedDriver = signal<TimingDriver | undefined>(undefined);
  readonly classLabel = signal('');
  readonly timingImport = signal<TimingImport | undefined>(undefined);
  readonly timingError = signal('');
  readonly trackQuery = signal('');
  selectVideo(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.videoPath.set(`local://${file.name}`);
  }
  createDraft() {
    this.api
      .createDraft({
        videoPath: this.videoPath(),
        videoName: this.videoPath().split('/').pop() ?? '',
        carDescription: this.carDescription() || undefined,
      })
      .subscribe({
        next: (value) => {
          this.analysis.set(value);
          this.message.set('Draft saved locally.');
        },
        error: () => this.message.set('Unable to create draft.'),
      });
  }
  queue() {
    this.action('queue');
  }
  start() {
    this.action('start');
  }
  cancel() {
    this.action('cancel');
  }
  resume() {
    this.action('resume');
  }
  searchTracks() {
    this.timingError.set('');
    this.timingApi.tracks(this.trackQuery()).subscribe({ next: (value) => this.tracks.set(value.tracks), error: () => this.timingError.set('Unable to load LiveRC tracks.') });
  }
  chooseTrack(track: TimingTrack) {
    this.selectedTrack.set(track); this.selectedEvent.set(undefined); this.selectedRace.set(undefined); this.selectedDriver.set(undefined); this.events.set([]); this.races.set([]); this.drivers.set([]);
    this.timingApi.events(track.url).subscribe({ next: (value) => this.events.set(value.events), error: () => this.timingError.set('Unable to load archived events.') });
  }
  chooseEvent(event: TimingEvent) {
    this.selectedEvent.set(event); this.selectedRace.set(undefined); this.selectedDriver.set(undefined); this.races.set([]); this.drivers.set([]);
    this.timingApi.races(event.url).subscribe({ next: (value) => this.races.set(value.races), error: () => this.timingError.set('Unable to load races for this event.') });
  }
  chooseRace(race: TimingRace) {
    this.selectedRace.set(race); this.classLabel.set(race.label); this.selectedDriver.set(undefined); this.drivers.set([]);
    this.timingApi.drivers(race.url).subscribe({ next: (value) => this.drivers.set(value.drivers), error: () => this.timingError.set('Unable to load drivers for this race.') });
  }
  chooseDriver(driver: TimingDriver) { this.selectedDriver.set(driver); }
  importSelectedTiming() {
    const track = this.selectedTrack(); const event = this.selectedEvent(); const race = this.selectedRace(); const driver = this.selectedDriver();
    if (!track || !event || !race || !driver) return;
    this.timingError.set('');
    this.timingApi.import({ trackHost: track.host, trackName: track.name, trackUrl: track.url, eventName: event.name, eventUrl: event.url, raceId: race.id ?? '', raceLabel: race.label, roundLabel: race.label, classLabel: this.classLabel(), raceUrl: race.url, driverName: driver.name, ...(driver.driverId ? { driverId: driver.driverId } : {}) }).subscribe({ next: (value) => { this.timingImport.set(value); this.message.set(`Imported ${value.laps.length} laps for ${value.driverName}.`); }, error: (error: { error?: { error?: string } }) => this.timingError.set(error.error?.error ?? 'Unable to import timing.') });
  }
  private action(action: 'queue' | 'start' | 'cancel' | 'resume') {
    const current = this.analysis();
    if (!current) return;
    this.api
      .action(current.id, action)
      .subscribe({
        next: (value) => {
          this.analysis.set(value);
          if (action === 'start' || action === 'resume') this.connectToUpdates(value.id);
          if (action === 'cancel') this.updates?.unsubscribe();
        },
        error: () => this.message.set('That lifecycle action was not accepted.'),
      });
  }
  private connectToUpdates(id: string) {
    this.updates?.unsubscribe();
    this.updates = this.api
      .updates(id, (state) => this.connectionState.set(state))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (message) => this.analysis.set(message.analysis) });
  }
}
