import { RacingReview } from './app/racing-review';
import type { TrackingArtifacts } from '../../../shared/tracking-contract';
import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, type Subscription } from 'rxjs';
import { AnalysisApi, type Analysis, type AnalysisConnectionState } from './app/analysis-api';
import { TimingApi, type TimingDriver, type TimingEvent, type TimingImportSummary, type TimingRace, type TimingTrack } from './app/timing-api';
import { buildTimingImportRequest, confirmTimingSelection, emptyTimingSelection, selectTimingDriver, selectTimingEvent, selectTimingRace, selectTimingTrack, timingDriverOptionKey, timingImportReadiness, timingSelectionIsConfirmed, type TimingSelection } from './app/timing-selection';
import { LocalRuntime, type StabilizationReview } from './app/local-runtime';
import { BrowserSqliteStore } from './app/browser-sqlite';
import { CalibrationCanvas, type CalibrationMode } from './app/calibration-canvas';
import { addMarker, calibrationReadiness, canStartCalibration as canStartCalibrationState, emptyCalibration, markerStatus, moveMarker, removeMarker, replaceDetectedMarkers, type CalibrationState } from './app/calibration-state';
import type { CorrectionSet, LocalVideoRef, NormalizedBox, NormalizedPoint } from '../../../shared/calibration-contract';
@Component({
  selector: 'app-root',
  imports: [DecimalPipe, CalibrationCanvas, RacingReview],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly api = inject(AnalysisApi);
  private readonly timingApi = inject(TimingApi);
  private readonly videoStore = inject(BrowserSqliteStore);
  private readonly runtime = inject(LocalRuntime);
  readonly savedAnalyses = signal<Analysis[]>([]);
  readonly workspaceError = signal('');
  readonly workspaceLoading = signal(false);
  readonly correctionHistory = signal<CorrectionSet[]>([]);
  readonly calibrationSaving = signal(false);
  readonly correctionBusy = signal(false);
  readonly localVideoUrl = signal<string | undefined>(undefined);
  readonly eventQuery = signal('');
  readonly eventSearching = signal(false);
  private workspaceGeneration = 0;
  private savedGeneration = 0;
  private eventGeneration = 0;
  readonly trackingReview = signal<TrackingArtifacts | undefined>(undefined);
  readonly recoveryBox = signal<NormalizedBox | null>(null);
  readonly recoveryError = signal('');
  readonly localNode = signal(false);
  readonly stabilizationReview = signal<StabilizationReview | undefined>(undefined);
  readonly selectedVideo = signal<Blob | undefined>(undefined);
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
  readonly markerStatus = markerStatus;
  private videoSave?: Promise<void>;
  private videoSelectionGeneration = 0;
  private reviewGeneration = 0;
  private videoSaveFailed = false;
  private videoSaveError = '';
  /** Saves selected footage to the discovered local runtime or browser storage. */
  selectVideo(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    ++this.workspaceGeneration; this.workspaceLoading.set(false); this.workspaceError.set(''); this.calibrationSaving.set(false); this.correctionBusy.set(false); this.correctionHistory.set([]); this.localVideoUrl.set(undefined);
    const generation = ++this.videoSelectionGeneration;
    this.localVideoRef.set(undefined);
    this.selectedVideo.set(undefined);
    this.updates?.unsubscribe();
    this.analysis.set(undefined);
    this.clearStabilizationReview();
    this.calibration.set(emptyCalibration());
    this.videoSaveFailed = false;
    this.videoSaveError = '';
    this.videoPath.set(file.name);
    this.message.set('Saving video in browser storage…');
    this.videoSave = this.runtime.available().then(async (local) => {
      if (generation !== this.videoSelectionGeneration) return;
      this.localNode.set(local);
      if (local) {
        const imported = await this.runtime.importVideo(file);
        if (generation !== this.videoSelectionGeneration) return;
        this.selectedVideo.set(file);
        this.localVideoRef.set(imported.localVideoRef);
        this.videoPath.set(imported.videoPath);
        this.message.set('Video saved on this machine for local processing.');
        return;
      }
      this.selectedVideo.set(undefined);
      const ref = await this.videoStore.saveVideo(file);
      if (generation !== this.videoSelectionGeneration) return;
      this.localVideoRef.set(ref);
      this.videoPath.set(`browser-sqlite://${ref.id}`);
      this.message.set('Video saved in browser SQLite.');
    })
      .catch((error: Error) => {
        if (generation !== this.videoSelectionGeneration) return;
        this.videoSaveFailed = true;
        this.videoSaveError = error.message;
        this.message.set(error.message);
      });
  }
  /** Creates a draft only after the selected local video has finished saving. */
  async createDraft() {
    const generation = ++this.workspaceGeneration;
    this.calibrationSaving.set(false); this.correctionBusy.set(false); this.workspaceLoading.set(false);
    this.updates?.unsubscribe();
    if (this.videoSave) this.message.set('Finishing video save before creating the draft…');
    try {
      await this.videoSave;
    } catch {
      return;
    }
    if (generation !== this.workspaceGeneration) return;
    if (this.videoSaveFailed) {
      this.message.set(this.videoSaveError || 'The video was not saved in browser storage.');
      return;
    }
    this.api
      .createDraft({
        videoPath: this.videoPath(),
        videoName: this.localVideoRef()?.name ?? this.videoPath().split('/').pop() ?? '',
        carDescription: this.carDescription() || undefined,
        videoStorage: this.localNode() ? 'local-disk' : 'browser-sqlite',
        localVideoRef: this.localVideoRef(),
      })
      .subscribe({
        next: (value) => {
          if (generation !== this.workspaceGeneration) return;
          this.analysis.set(value);
          this.clearStabilizationReview(); this.correctionHistory.set([]);
          this.message.set('Draft saved locally.');
        },
        error: () => { if (generation === this.workspaceGeneration) this.message.set('Unable to create draft.'); },
      });
  }
  /** Discovers local persistence and lists saved workspaces without loading source videos. */
  async loadSavedAnalyses() {
    const generation = ++this.savedGeneration; this.workspaceError.set('');
    try {
      const local = await this.runtime.available(); this.localNode.set(local);
      if (!local) throw new Error('Open the localhost runtime to reopen saved analyses.');
      const value = await firstValueFrom(this.api.list());
      if (generation === this.savedGeneration) this.savedAnalyses.set(value.analyses);
    } catch (error) { if (generation === this.savedGeneration) this.workspaceError.set(timingError(error, 'Unable to list saved analyses. Retry.')); }
  }
  /** Restores metadata, accepted calibration, disk video and review using only persisted local identities. */
  async openAnalysis(id: string) {
    const generation = ++this.workspaceGeneration; ++this.videoSelectionGeneration;
    this.videoPath.set(''); this.carDescription.set('');
    this.updates?.unsubscribe(); this.clearStabilizationReview(); this.analysis.set(undefined); this.correctionHistory.set([]);
    this.selectedVideo.set(undefined); this.localVideoRef.set(undefined); this.localVideoUrl.set(undefined); this.calibration.set(emptyCalibration());
    this.workspaceLoading.set(true); this.workspaceError.set(''); this.correctionBusy.set(false); this.calibrationSaving.set(false);
    try {
      const local = await this.runtime.available();
      if (!local) throw new Error('Open the localhost runtime to reopen saved analyses.');
      const [analysis, history] = await Promise.all([firstValueFrom(this.api.get(id)), firstValueFrom(this.api.correctionSets(id))]);
      if (generation !== this.workspaceGeneration) return;
      this.localNode.set(true); this.analysis.set(analysis); this.correctionHistory.set(history.correctionSets);
      this.videoPath.set(analysis.videoPath); this.carDescription.set(analysis.carDescription ?? ''); this.localVideoRef.set(analysis.localVideoRef);
      this.localVideoUrl.set(`/api/analyses/${encodeURIComponent(id)}/video`);
      const accepted = history.correctionSets.find(set => set.id === analysis.acceptedCorrectionSetId);
      if (accepted) this.hydrateCorrection(accepted);
      this.videoSave = undefined; this.videoSaveFailed = false; this.calibrationMode.set('idle');
      this.connectToUpdates(id); this.workspaceLoading.set(false);
    } catch (error) { if (generation === this.workspaceGeneration) { this.workspaceLoading.set(false); this.workspaceError.set(timingError(error, 'Unable to open saved analysis. It may have been removed; refresh the list.')); } }
  }
  /** Copies accepted geometry into the editor without mutating any stored correction payload. */
  private hydrateCorrection(set: CorrectionSet) {
    this.calibration.set({ raceStartSeconds: set.raceStartSeconds, markerReferenceSeconds: set.markerReferenceSeconds, carSelectionSeconds: set.carSelectionSeconds, markers: structuredClone(set.markers), selectedCarBox: structuredClone(set.selectedCarBox), markerDetectionStatus: 'found' });
    this.carDescription.set(set.carDescription ?? this.analysis()?.carDescription ?? '');
  }
  /** Reloads immutable correction history only for the currently selected workspace. */
  loadCorrectionHistory() {
    const current = this.analysis(); const generation = this.workspaceGeneration; if (!current) return;
    this.api.correctionSets(current.id).subscribe({ next: value => { if (generation === this.workspaceGeneration && this.analysis()?.id === current.id) this.correctionHistory.set(value.correctionSets); }, error: error => { if (generation === this.workspaceGeneration) this.workspaceError.set(timingError(error, 'Unable to load correction history. Reopen the analysis.')); } });
  }
  /** Selects prior immutable authority, retaining all versions and requiring a fresh queued run. */
  selectCorrection(set: CorrectionSet) {
    const current = this.analysis(); const generation = this.workspaceGeneration; if (!current || this.correctionBusy() || this.calibrationSaving()) return;
    this.correctionBusy.set(true); this.workspaceError.set('');
    this.api.selectCorrectionSet(current, set.id).subscribe({
      next: value => { if (generation !== this.workspaceGeneration || this.analysis()?.id !== current.id) return; this.correctionBusy.set(false); this.analysis.set(value); this.hydrateCorrection(set); this.clearStabilizationReview(); this.loadCorrectionHistory(); },
      error: error => { if (generation === this.workspaceGeneration) { this.correctionBusy.set(false); this.workspaceError.set(timingError(error, 'Unable to select correction version. Reopen the analysis.')); } },
    });
  }
  /** Restricts selection to stopped or unqueued lifecycle states. */
  canSelectCorrection() { return !this.correctionBusy() && !this.calibrationSaving() && ['ready', 'awaiting_calibration', 'completed', 'needs_correction', 'failed', 'cancelled'].includes(this.analysis()?.state ?? ''); }

  /** Enters correction mode through the workflow authority before accepting a revision. */
  startCalibration() { const current = this.analysis(); if (!current || !canStartCalibrationState(current.state)) return; this.api.startCalibration(current.id).subscribe({ next: (value) => { if (this.analysis()?.id !== current.id) return; this.analysis.set(value); this.clearStabilizationReview(); this.calibrationMode.set('car'); }, error: (error) => { if (this.analysis()?.id === current.id) this.calibrationError.set(timingError(error, 'Unable to start calibration.')); } }); }
  setRaceStart(seconds: number) { this.calibration.update((state) => ({ ...state, raceStartSeconds: finiteOrNull(seconds) })); this.calibrationMode.set('idle'); }
  setMarkerReference(seconds: number) { this.calibration.update((state) => ({ ...state, markerReferenceSeconds: finiteOrNull(seconds), markers: [], markerDetectionStatus: 'not-run' })); this.calibrationMode.set('marker'); }
  setCarSelection(seconds: number) { this.calibration.update((state) => ({ ...state, carSelectionSeconds: finiteOrNull(seconds) })); this.calibrationMode.set('car'); }
  addCalibrationMarker(position: NormalizedPoint) { this.calibration.update((state) => addMarker(state, position)); }
  moveCalibrationMarker(change: { id: string; position: NormalizedPoint }) { this.calibration.update((state) => moveMarker(state, change.id, change.position)); }
  replaceDetectedCalibrationMarkers(positions: NormalizedPoint[]) {
    const current = this.calibration();
    if (current.markers.length && !window.confirm('Replace the current marker corrections with fresh detection results?')) return;
    this.calibration.update((state) => replaceDetectedMarkers(state, positions));
  }
  setCarBox(box: NormalizedBox) { this.calibration.update((state) => ({ ...state, selectedCarBox: box })); }
  removeCalibrationMarker(id: string) { this.calibration.update((state) => removeMarker(state, id)); }
  /** Persists accepted corrections through the active local analysis authority. */
  saveCalibration() {
    const current = this.analysis(); const generation = this.workspaceGeneration;
    const state = this.calibration();
    const readiness = calibrationReadiness(state);
    if (this.calibrationSaving() || this.correctionBusy()) return;
    if (current?.state !== 'awaiting_calibration' || readiness || state.raceStartSeconds === null || state.markerReferenceSeconds === null || state.carSelectionSeconds === null || !state.selectedCarBox) {
      this.calibrationError.set(readiness ?? 'Enable calibration before saving corrections.');
      return;
    }
    this.calibrationError.set(''); this.calibrationSaving.set(true);
    const payload = { raceStartSeconds: state.raceStartSeconds, markerReferenceSeconds: state.markerReferenceSeconds, carSelectionSeconds: state.carSelectionSeconds, markers: state.markers, selectedCarBox: state.selectedCarBox, carDescription: this.carDescription() || undefined };
    const localSet: CorrectionSet = { ...payload, id: crypto.randomUUID(), analysisId: current.id, version: 0, accepted: false, createdAt: new Date().toISOString() };
    const localNode = this.localNode();
    (localNode ? Promise.resolve() : this.videoStore.saveCorrectionSet(localSet)).then(() => { if (generation !== this.workspaceGeneration) return; this.api.saveCorrectionSet(current.id, payload, current).subscribe({
      next: (set) => {
        if (!localNode) this.videoStore.saveCorrectionSet(set).catch(() => undefined);
        if (generation !== this.workspaceGeneration || this.analysis()?.id !== current.id) return;
        this.api.get(current.id).subscribe({
          next: value => { if (generation !== this.workspaceGeneration) return; this.calibrationSaving.set(false); this.analysis.set(value); this.clearStabilizationReview(); this.loadCorrectionHistory(); this.message.set(`Correction set v${set.version} saved for processing.`); },
          error: error => { if (generation === this.workspaceGeneration) { this.calibrationSaving.set(false); this.workspaceError.set(timingError(error, 'Corrections saved; reopen the analysis to refresh authority.')); } },
        });
      },
      error: (error) => { if (generation !== this.workspaceGeneration) return; this.calibrationSaving.set(false); this.calibrationError.set(timingError(error, localNode ? 'Unable to save corrections to the local workflow. Reopen and retry.' : 'Saved locally; synchronization failed. Retry when connected.')); },
    }); }).catch((error: Error) => { if (generation === this.workspaceGeneration) { this.calibrationSaving.set(false); this.calibrationError.set(error.message); } });
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
    const generation = ++this.eventGeneration; this.eventQuery.set(''); this.eventSearching.set(true);
    this.events.set([]); this.races.set([]); this.drivers.set([]); this.timingError.set('');
    const trackUrl = track.url?.trim();
    if (!trackUrl) {
      this.eventSearching.set(false); this.timingError.set('Unable to load archived events: no track URL was selected.');
      return;
    }
    this.timingApi.events(trackUrl).subscribe({ next: (value) => { if (this.timingSelection().track === track && generation === this.eventGeneration) { this.events.set(value.events); this.eventSearching.set(false); } }, error: (error) => { if (this.timingSelection().track === track && generation === this.eventGeneration) { this.eventSearching.set(false); this.timingError.set(timingError(error, 'Unable to load archived events.')); } } });
  }
  /** Searches archived event names for the selected exact venue, invalidating old race confirmation. */
  searchEvents() {
    const track = this.timingSelection().track; if (!track) return;
    const generation = ++this.eventGeneration; this.eventSearching.set(true); this.events.set([]); this.races.set([]); this.drivers.set([]); this.timingError.set('');
    this.timingSelection.set(selectTimingTrack(this.timingSelection(), track));
    this.timingApi.events(track.url, this.eventQuery()).subscribe({
      next: value => { if (generation === this.eventGeneration && this.timingSelection().track === track) { this.events.set(value.events); this.eventSearching.set(false); } },
      error: error => { if (generation === this.eventGeneration && this.timingSelection().track === track) { this.eventSearching.set(false); this.timingError.set(timingError(error, 'Unable to search archived events. Retry.')); } },
    });
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
        race: { id: value.raceId ?? 'persisted', label: value.raceLabel, classLabel: value.classLabel, url: value.raceUrl },
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
  /** Applies a lifecycle transition through the workflow and invalidates stale run diagnostics. */
  private action(action: 'queue' | 'start' | 'cancel' | 'resume') {
    const current = this.analysis(); const generation = this.workspaceGeneration;
    if (!current || this.correctionBusy() || this.calibrationSaving()) return;
    this.correctionBusy.set(true);
    this.api
      .action(current.id, action)
      .subscribe({
        next: (value) => {
          if (generation !== this.workspaceGeneration || this.analysis()?.id !== current.id) return;
          this.correctionBusy.set(false); this.analysis.set(value);
          if (action === 'queue' || action === 'start') this.clearStabilizationReview();
          if (action === 'start' || action === 'resume') this.connectToUpdates(value.id);
          if (action === 'cancel') this.updates?.unsubscribe();
        },
        error: () => { if (generation === this.workspaceGeneration && this.analysis()?.id === current.id) { this.correctionBusy.set(false); this.message.set('That lifecycle action was not accepted.'); } },
      });
  }
  /** Invalidates pending diagnostics whenever a different correction or run is selected. */
  private clearStabilizationReview() {
    this.reviewGeneration += 1;
    this.stabilizationReview.set(undefined);
    this.trackingReview.set(undefined);
    this.recoveryBox.set(null);
    this.recoveryError.set('');
  }

  /** Groups retained uncertainty for review without filling any missing car path. */
  trackingIntervals() {
    const regions: Array<{ startFrame: number; endFrame: number; quality: string }> = [];
    for (const item of this.trackingReview()?.observations ?? []) {
      if (item.quality !== 'lost' && item.quality !== 'suspect') continue;
      const last = regions.at(-1);
      if (last && last.quality === item.quality && last.endFrame + 1 === item.frame) last.endFrame = item.frame;
      else regions.push({ startFrame: item.frame, endFrame: item.frame, quality: item.quality });
    }
    return regions;
  }
  /** Binds the drawn confirmation to the nearest actual decoded lost frame at the video cursor. */
  confirmRecovery(seconds: number) {
    const current = this.analysis(); const generation = this.workspaceGeneration; const box = this.recoveryBox(); const output = this.trackingReview();
    if (!current || !box || !output) return;
    const observation = output.observations.reduce((nearest, item) => Math.abs(item.seconds - seconds) < Math.abs(nearest.seconds - seconds) ? item : nearest, output.observations[0]);
    if (observation?.quality !== 'lost') { this.recoveryError.set('Seek to a lost source frame before confirming identity.'); return; }
    this.api.rebox(current.id, observation.frame, box).subscribe({
      next: () => { if (generation !== this.workspaceGeneration || this.analysis()?.id !== current.id) return; this.recoveryError.set(''); this.clearStabilizationReview(); this.resume(); },
      error: (error) => { if (generation === this.workspaceGeneration) this.recoveryError.set(timingError(error, 'Unable to confirm this recovery box.')); },
    });
  }
  /** Observes persisted progress and loads local quality diagnostics after the run. */
  private connectToUpdates(id: string) {
    const workspaceGeneration = this.workspaceGeneration;
    this.updates?.unsubscribe();
    this.updates = this.api
      .updates(id, (state) => this.connectionState.set(state), this.localNode())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (message) => {
        if (workspaceGeneration !== this.workspaceGeneration || this.analysis()?.id !== id) return;
        this.analysis.set(message.analysis);
        if (this.localNode() && ['completed', 'needs_correction', 'failed', 'cancelled'].includes(message.analysis.state)) {
          const generation = this.reviewGeneration;
          this.api.tracking(id).subscribe({ next: value => { if (this.analysis()?.id === id && generation === this.reviewGeneration) this.trackingReview.set(value.tracking); }, error: () => { if (workspaceGeneration === this.workspaceGeneration) this.message.set('Unable to load tracking diagnostics.'); } });
          this.api.artifacts(id).subscribe({ next: (value) => { if (this.analysis()?.id === id && generation === this.reviewGeneration) this.stabilizationReview.set(value.stabilization); }, error: () => { if (workspaceGeneration === this.workspaceGeneration) this.message.set('Unable to load stabilization diagnostics.'); } });
        }
      } });
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
