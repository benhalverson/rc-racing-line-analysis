import { isNormalizedBox, type NormalizedBox } from '../../shared/calibration-contract';
import type { LocalArtifactStore } from './local-artifacts';
import type { LocalPersistence } from './local-persistence';
import type { AnalysisWorkflow } from './workflow';

/** Coordinates manual recovery with accepted calibration and published decoded observations. */
export class TrackingWorkflow {
  /** Reuses the analysis lifecycle and local metadata/artifact ports. */
  constructor(private readonly workflow: AnalysisWorkflow, private readonly persistence: LocalPersistence, private readonly artifacts: LocalArtifactStore) {}

  /** Reads only current run/correction tracking evidence. */
  async get(id: string) { await this.workflow.get(id); return this.artifacts.readPublishedTracking(id); }

  /** Appends an identity confirmation at an actual decoded lost frame without accepting artifact paths. */
  async rebox(id: string, frame: number, box: NormalizedBox) {
    const analysis = await this.workflow.get(id);
    if (analysis.state !== 'needs_correction') throw new Error('Re-boxing requires a finished run needing correction');
    if (!Number.isInteger(frame) || frame < 0 || !isNormalizedBox(box)) throw new Error('Invalid recovery frame or normalized box');
    const tracking = await this.get(id);
    const observation = tracking?.observations.find(item => item.frame === frame);
    // Confirmation resumes after an existing loss; it cannot erase the first lost frame.
    if (!tracking || observation?.quality !== 'lost' || !tracking.observations.some(item => item.frame < frame && item.quality === 'lost' && item.segmentId !== null)) throw new Error('Choose a decoded frame after selected-car identity was lost');
    const correctionSetId = analysis.acceptedCorrectionSetId;
    if (!correctionSetId || tracking.correctionSetId !== correctionSetId) throw new Error('Accepted tracking authority changed');
    const prior = await this.persistence.listTrackingRecoveries(id, correctionSetId);
    if (prior.some(item => item.frame >= frame)) throw new Error('Recovery confirmations must advance source frames');
    return this.persistence.addTrackingRecovery({ analysisId: id, correctionSetId, frame, seconds: observation.seconds, box });
  }
}
