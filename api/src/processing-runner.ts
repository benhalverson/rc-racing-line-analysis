import type { Analysis } from "./domain";
import { errorMessage } from "./errors";
import type { StabilizationArtifacts, MarkerStabilizationProvider } from "./stabilization";

const phases = [
  { name: 'calibration', phase: 'calibrating' as const, progress: 0.25, checkpoint: 'calibration-complete' },
  { name: 'tracking', phase: 'tracking' as const, progress: 0.5, checkpoint: 'tracking-halfway' },
  { name: 'review', phase: 'review' as const, progress: 0.75, checkpoint: 'review-ready' },
];
const checkpointOrder = ['queued', ...phases.map(({ checkpoint }) => checkpoint)];

export interface ProcessingStep {
  sleep(name: string, duration: number): Promise<void>;
  do(name: string, callback: (context: unknown) => Promise<Analysis | null>): Promise<Analysis | null>;
}

export type ProcessingUpdate = {
  phase: Analysis['phase'];
  progress: number;
  checkpoint?: string;
};

export interface AnalysisProcessingService {
  get(id: string): Promise<Analysis>;
  report(id: string, update: ProcessingUpdate): Promise<Analysis>;
  complete(id: string): Promise<Analysis>;
  fail(id: string, error: string): Promise<Analysis>;
}

export type StabilizationProcessing = {
  provider: MarkerStabilizationProvider;
  saveArtifacts: (analysisId: string, artifacts: StabilizationArtifacts) => Promise<void>;
};

export async function executeAnalysisProcessing(
  id: string,
  step: ProcessingStep,
  processing: AnalysisProcessingService,
  publish: (analysis: Analysis) => Promise<void>,
  stabilization?: StabilizationProcessing,
): Promise<void> {
  try {
    for (const phase of phases) {
      await step.sleep(`${phase.name} checkpoint delay`, 1);
      await step.do(`persist ${phase.name} checkpoint`, async () => {
        const current = await processing.get(id);
        if (current.state !== 'running') {
          await publish(current);
          return current;
        }
        if (checkpointOrder.indexOf(current.checkpoint ?? 'queued') >= checkpointOrder.indexOf(phase.checkpoint)) {
          await publish(current);
          return current;
        }
        if (phase.name === 'calibration' && stabilization) {
          await stabilization.saveArtifacts(id, await stabilization.provider.stabilize());
        }
        const updated = await processing.report(id, phase);
        await publish(updated);
        return updated;
      });
    }
    await step.do('persist completion', async () => {
      const current = await processing.get(id);
      if (current.state !== 'running') {
        await publish(current);
        return current;
      }
      const completed = await processing.complete(id);
      await publish(completed);
      return completed;
    });
  } catch (error) {
    await step.do('persist failure', async () => {
      const current = await processing.get(id).catch(() => undefined);
      if (!current) return null;
      if (current.state === 'running') {
        const failed = await processing.fail(id, errorMessage(error));
        await publish(failed);
        return failed;
      } else {
        await publish(current);
        return current;
      }
    });
    throw error;
  }
}
