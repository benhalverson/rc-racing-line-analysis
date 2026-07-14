import { describe, expect, it, vi } from 'vitest';
import type { Analysis } from '../src/domain';
import { executeAnalysisProcessing, type ProcessingUpdate } from '../src/processing-runner';

const baseAnalysis: Analysis = {
  id: 'analysis-1',
  videoPath: '/race.mp4',
  videoName: 'race.mp4',
  carDescription: null,
  state: 'running',
  phase: 'calibrating',
  progress: 0,
  checkpoint: 'queued',
  error: null,
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
};

function stepRunner() {
  const sleeps: string[] = [];
  const steps: string[] = [];
  const step = {
    sleep: vi.fn(async (name: string) => { sleeps.push(name); }),
    do: vi.fn(async (name: string, callback: () => Promise<unknown>) => {
      steps.push(name);
      return callback();
    }),
  };
  return { step, sleeps, steps };
}

describe('analysis processing workflow', () => {
  it('runs each checkpoint and completes the processing run', async () => {
    let current = { ...baseAnalysis };
    const published: string[] = [];
    const processing = {
      get: async () => current,
      report: async (_id: string, update: ProcessingUpdate) => {
        current = { ...current, ...update };
        return current;
      },
      complete: async () => {
        current = { ...current, state: 'completed', phase: 'review', progress: 1, checkpoint: 'completed' };
        return current;
      },
      fail: async () => current,
    };
    const { step, sleeps, steps } = stepRunner();

    await executeAnalysisProcessing('analysis-1', step as never, processing, (analysis) => {
      published.push(`${analysis.state}:${analysis.checkpoint}`);
      return Promise.resolve();
    });

    expect(sleeps).toEqual(['calibration checkpoint delay', 'tracking checkpoint delay', 'review checkpoint delay']);
    expect(steps).toEqual([
      'persist calibration checkpoint',
      'persist tracking checkpoint',
      'persist review checkpoint',
      'persist completion',
    ]);
    expect(published).toEqual([
      'running:calibration-complete',
      'running:tracking-halfway',
      'running:review-ready',
      'completed:completed',
    ]);
    expect(current).toMatchObject({ state: 'completed', progress: 1, checkpoint: 'completed' });
  });

  it('does not repeat completed checkpoints after resume', async () => {
    let current: Analysis = { ...baseAnalysis, phase: 'tracking', progress: 0.5, checkpoint: 'tracking-halfway' };
    const reports: string[] = [];
    const processing = {
      get: async () => current,
      report: async (_id: string, update: ProcessingUpdate) => {
        reports.push(update.checkpoint ?? 'none');
        current = { ...current, ...update };
        return current;
      },
      complete: async () => {
        current = { ...current, state: 'completed', phase: 'review', progress: 1, checkpoint: 'completed' };
        return current;
      },
      fail: async () => current,
    };
    const { step } = stepRunner();

    await executeAnalysisProcessing('analysis-1', step as never, processing, () => Promise.resolve());

    expect(reports).toEqual(['review-ready']);
    expect(current.checkpoint).toBe('completed');
  });

  it('persists stabilization artifacts through the calibration checkpoint', async () => {
    let current = { ...baseAnalysis };
    const artifacts = { markerObservations: [], transforms: [] };
    const saveArtifacts = vi.fn(async () => undefined);
    const processing = {
      get: async () => current,
      report: async (_id: string, update: ProcessingUpdate) => {
        current = { ...current, ...update };
        return current;
      },
      complete: async () => {
        current = { ...current, state: 'completed', phase: 'review', progress: 1, checkpoint: 'completed' };
        return current;
      },
      fail: async () => current,
    };
    const { step } = stepRunner();

    await executeAnalysisProcessing(
      'analysis-1',
      step as never,
      processing,
      () => Promise.resolve(),
      { provider: { stabilize: vi.fn(async () => artifacts) }, saveArtifacts },
    );

    expect(saveArtifacts).toHaveBeenCalledWith('analysis-1', artifacts);
  });
});
