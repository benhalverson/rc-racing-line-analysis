import type { CorrectionSet, NormalizedBox } from '../../shared/calibration-contract';
import { transformUsablePoint, type StabilizationArtifacts } from '../../shared/stabilization-contract';
import type { CarObservation, PixelBox, TrackingArtifacts, TrackingRecovery } from '../../shared/tracking-contract';
import { FfmpegVideoFrameSource, type VideoFrame, type VideoFrameSource } from './local-video-stabilization';

export const TRACKING_PROVIDER_VERSION = 'local-rgb-template-v1';
export type TrackingOptions = { videoPath: string; correction: CorrectionSet; stabilization: StabilizationArtifacts; recoveries: TrackingRecovery[]; signal?: AbortSignal; onFrame?: (output: TrackingArtifacts) => Promise<void> };
export interface SelectedCarTrackingProvider { track(): Promise<TrackingArtifacts>; }

/** Converts an accepted normalized box to decoded pixel geometry. */
function pixelBox(box: NormalizedBox, frame: VideoFrame): PixelBox {
  const x = Math.min(frame.width - 1, Math.round(box.x * frame.width)); const y = Math.min(frame.height - 1, Math.round(box.y * frame.height));
  return { x, y, width: Math.min(frame.width - x, Math.max(1, Math.round(box.width * frame.width))), height: Math.min(frame.height - y, Math.max(1, Math.round(box.height * frame.height))) };
}

/** Samples a fixed RGB appearance grid, keeping search cost independent of car size. */
function sample(frame: VideoFrame, box: PixelBox): number[] {
  const values: number[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const px = box.x + Math.min(box.width - 1, Math.floor((x + .5) * box.width / 8));
    const py = box.y + Math.min(box.height - 1, Math.floor((y + .5) * box.height / 8));
    const index = (py * frame.width + px) * 3;
    values.push(frame.rgb[index], frame.rgb[index + 1], frame.rgb[index + 2]);
  }
  return values;
}

/** Compares decoded pixels with the immutable operator-confirmed appearance. */
function appearanceError(template: number[], candidate: number[]): number {
  return template.reduce((sum, value, index) => sum + Math.abs(value - candidate[index]), 0) / template.length / 255;
}

/** Searches bounded motion, rejecting equally plausible identities rather than switching cars. */
function search(frame: VideoFrame, prior: PixelBox, template: number[]) {
  const radius = Math.max(8, Math.ceil(Math.max(prior.width, prior.height) * 1.5));
  const step = Math.max(1, Math.floor(Math.min(prior.width, prior.height) / 6));
  const candidates: Array<{ box: PixelBox; error: number }> = [];
  for (let y = Math.max(0, prior.y - radius); y <= Math.min(frame.height - prior.height, prior.y + radius); y += step) {
    for (let x = Math.max(0, prior.x - radius); x <= Math.min(frame.width - prior.width, prior.x + radius); x += step) {
      const box = { ...prior, x, y }; candidates.push({ box, error: appearanceError(template, sample(frame, box)) });
    }
  }
  candidates.sort((a, b) => a.error - b.error);
  const best = candidates[0];
  if (!best) return undefined;
  // Neighbouring offsets represent one candidate, not a competing identity.
  const competing = candidates.find(item => Math.hypot(item.box.x - best.box.x, item.box.y - best.box.y) >= Math.max(3, Math.min(prior.width, prior.height) * .7));
  return { ...best, margin: competing ? competing.error - best.error : 1 };
}

/** Tracks only the selected appearance; loss is latched until an explicit manual identity confirmation. */
export class LocalVideoTrackingProvider implements SelectedCarTrackingProvider {
  /** Supplies decoded local footage and accepted correction authority. */
  constructor(private readonly options: TrackingOptions, private readonly source: VideoFrameSource = new FfmpegVideoFrameSource()) {}

  /** Replays from selection on resume so appearance and loss state are reproduced exactly. */
  async track(): Promise<TrackingArtifacts> {
    const { correction, stabilization, signal } = this.options;
    const transforms = new Map(stabilization.transforms.map(item => [item.frame, item]));
    const output: TrackingArtifacts = { providerVersion: TRACKING_PROVIDER_VERSION, correctionSetId: correction.id, referenceSize: stabilization.referenceSize ?? { width: 0, height: 0 }, observations: [], segments: [] };
    // Resolve the operator cursor to the same nearest-frame convention as marker calibration.
    let selection: VideoFrame | undefined; let before: VideoFrame | undefined;
    for await (const frame of this.source.frames(this.options.videoPath, signal)) {
      if (frame.seconds >= correction.carSelectionSeconds) {
        selection = before && correction.carSelectionSeconds - before.seconds < frame.seconds - correction.carSelectionSeconds ? before : frame;
        break;
      }
      before = { ...frame, rgb: frame.rgb.slice() };
    }
    if (!selection) throw new Error('Accepted car selection is outside decoded footage');
    const selectionFrame = selection.frame;
    let velocity = { x: 0, y: 0 };
    let template: number[] | undefined; let box: PixelBox | undefined; let segmentId: string | null = null; let lost = true; let initialized = false; let previous = -1; let previousSeconds = -1;
    const recoveryFrames = new Map(this.options.recoveries.map(item => [item.frame, item]));
    for await (const frame of this.source.frames(this.options.videoPath, signal)) {
      signal?.throwIfAborted();
      if (frame.frame !== previous + 1 || !Number.isFinite(frame.seconds) || frame.seconds <= previousSeconds || frame.rgb.length !== frame.width * frame.height * 3) throw new Error('Invalid tracking decoded frame order or pixels');
      previous = frame.frame; previousSeconds = frame.seconds;
      if (!output.referenceSize.width) output.referenceSize = { width: frame.width, height: frame.height };
      if (frame.width !== output.referenceSize.width || frame.height !== output.referenceSize.height) throw new Error('Tracking and stabilization reference dimensions differ');
      let confirmed = false;
      if (!initialized && frame.frame === selectionFrame) {
        box = pixelBox(correction.selectedCarBox, frame); template = sample(frame, box); segmentId = `selection-${correction.id}`; initialized = true; lost = false; confirmed = true;
        output.segments.push({ id: segmentId, startFrame: frame.frame, seconds: frame.seconds, box, source: 'selection' });
      }
      const recovery = recoveryFrames.get(frame.frame);
      if (recovery) {
        if (!lost || recovery.correctionSetId !== correction.id || Math.abs(recovery.seconds - frame.seconds) > .000001) throw new Error('Recovery must confirm an actual lost source frame in the accepted correction');
        velocity = { x: 0, y: 0 }; box = pixelBox(recovery.box, frame); template = sample(frame, box); segmentId = recovery.id; lost = false; confirmed = true;
        output.segments.push({ id: segmentId, startFrame: frame.frame, seconds: frame.seconds, box, source: 'manual' });
      }
      let observation: CarObservation = { frame: frame.frame, seconds: frame.seconds, segmentId, quality: 'lost', box: null, trackPoint: null, appearanceError: null, ambiguityMargin: null, reason: initialized ? 'Manual re-box required after identity loss' : 'Before accepted car selection' };
      if (confirmed && box) observation = { ...observation, quality: recovery ? 'reacquired' : 'tracked', box: { ...box }, appearanceError: 0, reason: 'Operator-confirmed identity' };
      else if (!lost && template && box) {
        const match = search(frame, box, template);
        if (!match || match.error > .20 || match.margin < .025 || Math.hypot(match.box.x - box.x - velocity.x, match.box.y - box.y - velocity.y) > Math.max(2, Math.min(box.width, box.height) * .5)) { lost = true; observation.reason = match && match.margin < .025 ? 'Ambiguous appearance; identity withheld' : 'Appearance missing or motion continuity rejected; identity withheld'; }
        else {
          const suspect = match.error > .10 || match.margin < .06;
          const matchedBox = match.box;
          // Suspect observations never move the trusted identity anchor or velocity.
          if (!suspect) { velocity = { x: matchedBox.x - box.x, y: matchedBox.y - box.y }; box = matchedBox; }
          observation = { ...observation, quality: suspect ? 'suspect' : 'tracked', box: { ...matchedBox }, appearanceError: match.error, ambiguityMargin: match.margin, reason: suspect ? 'Appearance uncertain; excluded from track-relative output' : 'Selected appearance matched' };
        }
        if (match) { observation.appearanceError = match.error; observation.ambiguityMargin = match.margin; }
      }
      const transform = transforms.get(frame.frame);
      if (transform && observation.box && ['tracked', 'reacquired'].includes(observation.quality)) observation.trackPoint = transformUsablePoint(transform, { x: observation.box.x + observation.box.width / 2, y: observation.box.y + observation.box.height / 2 });
      if (frame.seconds >= correction.raceStartSeconds) {
        if (!transform) throw new Error('Tracking source frame has no stabilization quality record');
        output.observations.push(observation);
        if (output.observations.length % 30 === 0) await this.options.onFrame?.(output);
      }
    }
    if (!initialized || !output.observations.length) throw new Error('Accepted car selection or race start is outside decoded footage');
    if (this.options.recoveries.some(item => item.frame > previous)) throw new Error('Recovery is outside decoded footage');
    await this.options.onFrame?.(output);
    return output;
  }
}
