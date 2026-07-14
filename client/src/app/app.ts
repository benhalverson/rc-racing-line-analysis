import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { AnalysisApi, type Analysis, type AnalysisConnectionState } from './app/analysis-api';
import { TimingApi, type TimingDriver, type TimingEvent, type TimingImportSummary, type TimingRace, type TimingTrack } from './app/timing-api';
import { buildTimingImportRequest, confirmTimingSelection, emptyTimingSelection, selectTimingDriver, selectTimingEvent, selectTimingRace, selectTimingTrack, timingDriverOptionKey, timingImportReadiness, timingSelectionIsConfirmed, type TimingSelection } from './app/timing-selection';
import { BrowserSqliteStore } from './app/browser-sqlite';
import { CalibrationCanvas, type CalibrationMode } from './app/calibration-canvas';
import { addMarker, calibrationReadiness, canStartCalibration as canStartCalibrationState, emptyCalibration, removeMarker, type CalibrationState } from './app/calibration-state';
import type { CorrectionSet, LocalVideoRef, NormalizedBox, NormalizedPoint } from '../../../shared/calibration-contract';
@Component({
  selector: 'app-root',
  imports: [DecimalPipe, CalibrationCanvas],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly api = inject(AnalysisApi);
  private readonly timingApi = inject(TimingApi);
  private readonly videoStore = inject(BrowserSqliteStore);
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
  readonly localVideoRef = signal<LocalVideoRef | undefined>(undefined);
  readonly calibration = signal<CalibrationState>(emptyCalibration());
  readonly markerX = signal(0.5);
  readonly markerY = signal(0.5);
  readonly samStatus = signal<'idle' | 'loading' | 'webgpu' | 'wasm' | 'failed'>('idle');
  readonly calibrationError = signal('');
  readonly calibrationMode = signal<CalibrationMode>('idle');
  readonly canStartCalibration = canStartCalibrationState;
  readonly calibrationReadiness = calibrationReadiness;
  private videoSave?: Promise<void>;
  private videoSaveFailed = false;
  private videoSaveError = '';
  selectVideo(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.videoSaveFailed = false;
    this.videoSaveError = '';
    this.videoPath.set(file.name);
    this.message.set('Saving video in browser storage…');
    this.videoSave = this.videoStore.saveVideo(file)
      .then((ref) => {
        this.localVideoRef.set(ref);
        this.videoPath.set(`browser-sqlite://${ref.id}`);
        this.message.set('Video saved in browser SQLite.');
      })
      .catch((error: Error) => {
        this.videoSaveFailed = true;
        this.videoSaveError = error.message;
        this.message.set(error.message);
      });
  }
  async createDraft() {
    if (this.videoSave) this.message.set('Finishing video save before creating the draft…');
    try {
      await this.videoSave;
    } catch {
      return;
    }
    if (this.videoSaveFailed) {
      this.message.set(this.videoSaveError || 'The video was not saved in browser storage.');
      return;
    }
    this.api
      .createDraft({
        videoPath: this.videoPath(),
        videoName: this.videoPath().split('/').pop() ?? '',
        carDescription: this.carDescription() || undefined,
        videoStorage: 'browser-sqlite',
        localVideoRef: this.localVideoRef(),
      })
      .subscribe({
        next: (value) => {
          this.analysis.set(value);
          this.message.set('Draft saved locally.');
        },
        error: () => this.message.set('Unable to create draft.'),
      });
  }
  startCalibration() { const current = this.analysis(); if (current?.state !== 'draft') return; this.api.startCalibration(current.id).subscribe({ next: (value) => this.analysis.set(value), error: (error) => this.calibrationError.set(timingError(error, 'Unable to start calibration.')) }); }
  setRaceStart(seconds: number) { this.calibration.update((state) => ({ ...state, raceStartSeconds: finiteOrNull(seconds) })); this.calibrationMode.set('idle'); }
  setMarkerReference(seconds: number) { this.calibration.update((state) => ({ ...state, markerReferenceSeconds: finiteOrNull(seconds) })); this.calibrationMode.set('marker'); }
  setCarSelection(seconds: number) { this.calibration.update((state) => ({ ...state, carSelectionSeconds: finiteOrNull(seconds) })); this.calibrationMode.set('car'); }
  addCalibrationMarker(position: NormalizedPoint) { this.calibration.update((state) => addMarker(state, position)); }
  setCarBox(box: NormalizedBox) { this.calibration.update((state) => ({ ...state, selectedCarBox: box })); }
  removeCalibrationMarker(id: string) { this.calibration.update((state) => removeMarker(state, id)); }
  saveCalibration() { const current = this.analysis(); const state = this.calibration(); const readiness = calibrationReadiness(state); if (!current || readiness || state.raceStartSeconds === null || state.markerReferenceSeconds === null || state.carSelectionSeconds === null || !state.selectedCarBox) { this.calibrationError.set(readiness ?? 'Create a draft before saving calibration.'); return; } const payload = { ...state, raceStartSeconds: state.raceStartSeconds, markerReferenceSeconds: state.markerReferenceSeconds, carSelectionSeconds: state.carSelectionSeconds, selectedCarBox: state.selectedCarBox, carDescription: this.carDescription() || undefined }; const localSet: CorrectionSet = { ...payload, id: crypto.randomUUID(), analysisId: current.id, version: 0, accepted: false, createdAt: new Date().toISOString() }; this.videoStore.saveCorrectionSet(localSet).then(() => this.api.saveCorrectionSet(current.id, payload).subscribe({ next: (set) => { this.videoStore.saveCorrectionSet(set).catch(() => undefined); this.analysis.update((analysis) => analysis ? { ...analysis, state: 'ready', acceptedCorrectionSetId: set.id } : analysis); this.message.set(`Correction set v${set.version} synchronized to D1.`); }, error: () => this.calibrationError.set('Saved locally; synchronization failed. Retry when connected.') })).catch((error: Error) => this.calibrationError.set(error.message)); }
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
    this.timingApi.import(request).subscribe({ next: (value) => { if (this.isCurrentTimingSelection(selection)) { this.timingSelection.update((current) => ({ ...current, importedResult: value })); this.message.set(`Imported ${value.laps.length} laps for ${value.driverName}.`); } }, error: (error: { error?: { error?: string } }) => { if (this.isCurrentTimingSelection(selection)) this.timingError.set(error.error?.error ?? 'Unable to import timing.'); } });
  }
  loadSavedImports() { this.timingApi.savedImports().subscribe({ next: (value) => this.savedImports.set(value.imports), error: (error) => this.timingError.set(timingError(error, 'Unable to load saved timing imports.')) }); }
  reopenImport(id: string) {
    this.timingApi.loadImport(id).subscribe({
      next: (value) => this.timingSelection.set({
        track: { host: value.trackHost, name: value.trackName, url: value.trackUrl },
        event: { name: value.eventName, url: value.eventUrl },
        race: { id: value.raceId ?? 'persisted', label: value.raceLabel, url: value.raceUrl },
        classLabel: value.classLabel,
        driver: { name: value.driverName, normalizedName: value.normalizedDriverName, ...(value.driverId ? { driverId: value.driverId } : {}) },
        importedResult: value,
      }),
      error: (error) => this.timingError.set(timingError(error, 'Unable to reopen saved timing import.')),
    });
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

function finiteOrNull(value: number) { return Number.isFinite(value) && value >= 0 ? value : null; }
