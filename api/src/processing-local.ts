import { LocalVideoTrackingProvider, TRACKING_PROVIDER_VERSION, type TrackingOptions, type SelectedCarTrackingProvider } from './local-video-tracking';
import type { AnalysisWorkflow } from './workflow';
import type { LocalPersistence, ProcessingRun } from './local-persistence';
import type { LocalArtifactStore } from './local-artifacts';
import { STABILIZATION_PROVIDER_VERSION, LocalVideoStabilizationProvider, type LocalVideoStabilizationOptions } from './local-video-stabilization';
import type { MarkerStabilizationProvider, StabilizationArtifacts } from './stabilization';
import { errorMessage } from './errors';

export type LocalProcessingOptions = {
  signal?: AbortSignal;
  resolveVideoPath: (videoPath: string) => Promise<string>;
  trackingProviderFactory?: (options: TrackingOptions) => SelectedCarTrackingProvider;
  providerFactory?: (options: LocalVideoStabilizationOptions) => MarkerStabilizationProvider;
};

/** Merge checkpoint and resumed suffix without interpolating missing or invalid frames. */
function mergeArtifacts(prior: StabilizationArtifacts | undefined, next: StabilizationArtifacts): StabilizationArtifacts {
  const first = next.transforms[0]?.frame ?? Infinity;
  return {
    ...next,
    markerObservations: [...(prior?.markerObservations.filter((item) => item.frame < first) ?? []), ...next.markerObservations],
    transforms: [...(prior?.transforms.filter((item) => item.frame < first) ?? []), ...next.transforms],
  };
}

/** Execute real local stabilization through the public lifecycle, provider, and storage ports. */
export async function executeLocalStabilization(
  id: string,
  workflow: AnalysisWorkflow,
  persistence: LocalPersistence,
  artifacts: LocalArtifactStore,
  options: LocalProcessingOptions,
): Promise<void> {
  let run: ProcessingRun | undefined;
  try {
    const analysis = await workflow.get(id);
    if (analysis.state !== 'running') return;
    const correction = (await workflow.listCorrectionSets(id)).find((item) => item.id === analysis.acceptedCorrectionSetId && item.accepted);
    if (!correction) throw new Error('An accepted correction set is required for stabilization');
    run = await persistence.startRun(id, correction.id, `${STABILIZATION_PROVIDER_VERSION}+${TRACKING_PROVIDER_VERSION}`, analysis.checkpoint === 'queued');
    const prior = await artifacts.readCheckpoint(run);
    const lastFrame = prior?.transforms.at(-1)?.frame ?? -1;
    if (run.frame > lastFrame) throw new Error('Processing checkpoint file is missing committed frames');
    const currentRun = run;
    /** Commit disk output before advancing the durable lifecycle checkpoint. */
    const checkpoint = async (partial: StabilizationArtifacts): Promise<void> => {
      options.signal?.throwIfAborted();
      if ((await workflow.get(id)).state !== 'running') throw new Error('Processing interrupted');
      const combined = mergeArtifacts(prior, partial);
      const frame = combined.transforms.at(-1)?.frame ?? -1;
      await artifacts.writeCheckpoint(currentRun, combined);
      await persistence.updateRun(currentRun.id, { frame });
      await workflow.report(id, { phase: 'calibrating', progress: combined.totalFrames ? Math.min(0.49, .49 * combined.transforms.length / combined.totalFrames) : 0, checkpoint: `stabilization-frame-${frame}` });
    };
    const providerOptions: LocalVideoStabilizationOptions = {
      videoPath: await options.resolveVideoPath(analysis.videoPath),
      markers: correction.markers,
      markerReferenceSeconds: correction.markerReferenceSeconds,
      raceStartSeconds: correction.raceStartSeconds,
      // Replay the boundary frame so a crash after final decode can still finish publication.
      startFrame: Math.max(0, lastFrame),
      signal: options.signal,
      onFrame: checkpoint,
    };
    const provider = options.providerFactory?.(providerOptions) ?? new LocalVideoStabilizationProvider(providerOptions);
    const result = mergeArtifacts(prior, await provider.stabilize());
    options.signal?.throwIfAborted();
    if ((await workflow.get(id)).state !== 'running') throw new Error('Processing interrupted');
    if (!result.transforms.length) throw new Error('No race frames were decoded');
    await checkpoint(result);
    const priorTracking = await artifacts.readTrackingCheckpoint(currentRun);
    if (currentRun.trackingFrame > (priorTracking?.observations.at(-1)?.frame ?? -1)) throw new Error('Tracking checkpoint file is missing committed frames');
    const trackingOptions: TrackingOptions = {
      videoPath: await options.resolveVideoPath(analysis.videoPath), correction, stabilization: result,
      recoveries: await persistence.listTrackingRecoveries(id, correction.id), signal: options.signal,
      onFrame: async output => {
        options.signal?.throwIfAborted();
        if ((await workflow.get(id)).state !== 'running') throw new Error('Processing interrupted');
        const frame = output.observations.at(-1)?.frame ?? -1;
        // Deterministic replay restores appearance and loss state; never move the durable boundary backwards.
        if (frame < currentRun.trackingFrame) return;
        await artifacts.writeTrackingCheckpoint(currentRun, output);
        await persistence.updateRun(currentRun.id, { trackingFrame: frame });
        await workflow.report(id, { phase: 'tracking', progress: .5 + .49 * output.observations.length / result.transforms.length, checkpoint: `tracking-frame-${frame}` });
      },
    };
    await workflow.report(id, { phase: 'tracking', progress: .5 });
    const trackingProvider = options.trackingProviderFactory?.(trackingOptions) ?? new LocalVideoTrackingProvider(trackingOptions);
    const tracking = await trackingProvider.track();
    await trackingOptions.onFrame?.(tracking);
    options.signal?.throwIfAborted();
    if ((await workflow.get(id)).state !== 'running') throw new Error('Processing interrupted');
    await artifacts.commit(currentRun, result, tracking);
    if (result.transforms.some((item) => !item.quality.usable) || ["lost", "suspect"].includes(tracking.observations.at(-1)?.quality ?? "lost")) {
      const reason = 'Review stabilization and tracking uncertainty; lost intervals require manual re-boxing and remain excluded from track-relative output';
      await persistence.updateRun(currentRun.id, { status: 'needs_correction', error: reason });
      await workflow.needsCorrection(id, reason);
    } else {
      await persistence.updateRun(currentRun.id, { status: 'completed', error: null });
      await workflow.complete(id);
    }
  } catch (error) {
    const current = await workflow.get(id);
    const cancelled = options.signal?.aborted || current.state === 'cancelled';
    if (run) await persistence.updateRun(run.id, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : errorMessage(error) });
    if (current.state === 'running') {
      if (cancelled) await workflow.cancel(id);
      else await workflow.fail(id, errorMessage(error));
    }
    if (!cancelled) throw error;
  }
}
