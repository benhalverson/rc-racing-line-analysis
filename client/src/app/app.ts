import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { AnalysisApi, type Analysis, type AnalysisConnectionState } from './app/analysis-api';
import { TimingApi, type TimingDriver, type TimingEvent, type TimingImportSummary, type TimingRace, type TimingTrack } from './app/timing-api';
import { buildTimingImportRequest, confirmTimingSelection, emptyTimingSelection, selectTimingDriver, selectTimingEvent, selectTimingRace, selectTimingTrack, timingDriverOptionKey, timingImportReadiness, timingSelectionIsConfirmed, type TimingSelection } from './app/timing-selection';
import { assignLiveRcLap, correctLapCrossing, createRacingLineReview, type RacingLineReview } from '../../../shared/review-contract';
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
  readonly timingSelection = signal<TimingSelection>(emptyTimingSelection());
  readonly timingError = signal('');
  readonly trackQuery = signal('');
  readonly savedImports = signal<TimingImportSummary[]>([]);
  readonly review = signal<RacingLineReview | undefined>(undefined);
  readonly selectedReviewLap = signal<number | undefined>(undefined);
  readonly crossingTime = signal('');
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
    this.timingApi.tracks(this.trackQuery()).subscribe({ next: (value) => this.tracks.set(value.tracks), error: (error) => this.timingError.set(timingError(error, 'Unable to load LiveRC tracks.')) });
  }
  chooseTrack(track: TimingTrack | undefined) {
    if (!track) return;
    this.timingSelection.set(selectTimingTrack(this.timingSelection(), track));
    this.events.set([]); this.races.set([]); this.drivers.set([]); this.timingError.set('');
    const trackUrl = track.url?.trim();
    if (!trackUrl) {
      this.timingError.set('Unable to load archived events: no track URL was selected.');
      return;
    }
    this.timingApi.events(trackUrl).subscribe({ next: (value) => { if (this.timingSelection().track === track) this.events.set(value.events); }, error: (error) => { if (this.timingSelection().track === track) this.timingError.set(timingError(error, 'Unable to load archived events.')); } });
  }
  chooseEvent(event: TimingEvent | undefined) {
    if (!event) return;
    this.timingSelection.set(selectTimingEvent(this.timingSelection(), event));
    this.races.set([]); this.drivers.set([]); this.timingError.set('');
    this.timingApi.races(event.url).subscribe({ next: (value) => { if (this.timingSelection().event === event) this.races.set(value.races); }, error: (error) => { if (this.timingSelection().event === event) this.timingError.set(timingError(error, 'Unable to load races for this event.')); } });
  }
  chooseRace(race: TimingRace | undefined) {
    if (!race) return;
    this.timingSelection.set(selectTimingRace(this.timingSelection(), race));
    this.drivers.set([]); this.timingError.set('');
    this.timingApi.drivers(race.url).subscribe({ next: (value) => { if (this.timingSelection().race === race) this.drivers.set(value.drivers); }, error: (error) => { if (this.timingSelection().race === race) this.timingError.set(timingError(error, 'Unable to load drivers for this race.')); } });
  }
  chooseDriver(driver: TimingDriver | undefined) { if (driver) this.timingSelection.update((selection) => selectTimingDriver(selection, driver)); }
  setClassLabel(classLabel: string) { this.timingSelection.update((selection) => ({ ...selection, classLabel, importedResult: undefined, confirmedIdentity: undefined })); }
  reviewSelectedTiming() {
    const selection = this.timingSelection();
    if (!timingImportReadiness(selection)) this.timingSelection.set(confirmTimingSelection(selection));
  }
  driverOptionKey(driver: TimingDriver, index: number) { return timingDriverOptionKey(driver, index); }
  isTimingConfirmed() { return timingSelectionIsConfirmed(this.timingSelection()); }
  importSelectedTiming() {
    const selection = this.timingSelection();
    const request = buildTimingImportRequest(selection);
    if (!request || !timingSelectionIsConfirmed(selection)) { this.timingError.set(timingImportReadiness(selection) ?? 'Review and confirm the selected result first.'); return; }
    this.timingError.set('');
    this.timingApi.import(request).subscribe({ next: (value) => { if (this.isCurrentTimingSelection(selection)) { this.timingSelection.update((current) => ({ ...current, importedResult: value })); this.openReview(value); this.message.set(`Imported ${value.laps.length} laps for ${value.driverName}.`); } }, error: (error: { error?: { error?: string } }) => { if (this.isCurrentTimingSelection(selection)) this.timingError.set(error.error?.error ?? 'Unable to import timing.'); } });
  }
  loadSavedImports() { this.timingApi.savedImports().subscribe({ next: (value) => this.savedImports.set(value.imports), error: (error) => this.timingError.set(timingError(error, 'Unable to load saved timing imports.')) }); }
  reopenImport(id: string) {
    this.timingApi.loadImport(id).subscribe({
      next: (value) => {
        this.timingSelection.set({
          track: { host: value.trackHost, name: value.trackName, url: value.trackUrl },
          event: { name: value.eventName, url: value.eventUrl },
          race: { id: value.raceId ?? 'persisted', label: value.raceLabel, url: value.raceUrl },
          classLabel: value.classLabel,
          driver: { name: value.driverName, normalizedName: value.normalizedDriverName, ...(value.driverId ? { driverId: value.driverId } : {}) },
          importedResult: value,
        });
        this.openReview(value);
      },
      error: (error) => this.timingError.set(timingError(error, 'Unable to reopen saved timing import.')),
    });
  }
  openReview(timing: NonNullable<TimingSelection['importedResult']>) {
    const review = createRacingLineReview(timing);
    this.review.set(review);
    this.selectedReviewLap.set(review.laps[0]?.crossingLapNumber);
    this.crossingTime.set(review.laps[0]?.crossingSeconds.toFixed(3) ?? '');
  }
  markStartFinish(event: MouseEvent) {
    const svg = event.currentTarget as SVGElement;
    const bounds = svg.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * 700 / bounds.width;
    const y = (event.clientY - bounds.top) * 300 / bounds.height;
    this.review.update((review) => review ? { ...review, startFinish: { x, y } } : review);
  }
  selectLap(lapNumber: number) {
    const lap = this.review()?.laps.find((value) => value.crossingLapNumber === lapNumber);
    this.selectedReviewLap.set(lapNumber);
    this.crossingTime.set(lap?.crossingSeconds.toFixed(3) ?? '');
  }
  correctCrossing() {
    const lapNumber = this.selectedReviewLap();
    if (lapNumber === undefined) return;
    const seconds = Number(this.crossingTime());
    this.review.update((review) => review ? correctLapCrossing(review, lapNumber, seconds) : review);
  }
  assignLap(liveRcLapNumber: number) {
    const lapNumber = this.selectedReviewLap();
    if (lapNumber === undefined) return;
    this.review.update((review) => review ? assignLiveRcLap(review, lapNumber, liveRcLapNumber) : review);
  }
  assignLapFromEvent(event: Event) {
    this.assignLap(Number((event.target as HTMLSelectElement).value));
  }
  formatVideoTime(seconds: number) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${(seconds % 60).toFixed(3).padStart(6, '0')}`;
  }
  private isCurrentTimingSelection(selection: TimingSelection) {
    const current = this.timingSelection();
    return current.track === selection.track && current.event === selection.event && current.race === selection.race && current.driver === selection.driver && current.classLabel === selection.classLabel;
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

function timingError(error: unknown, fallback: string) {
  if (typeof error === 'object' && error !== null && 'error' in error) {
    const body = (error as { error?: unknown }).error;
    if (typeof body === 'string' && body.trim()) return body;
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const detail = (body as { error?: unknown }).error;
      if (typeof detail === 'string' && detail.trim()) return detail;
    }
  }
  return fallback;
}
