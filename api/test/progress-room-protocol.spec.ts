import { describe, expect, it } from 'vitest';
import type { Analysis } from '../src/domain';
import { createProgressMessage, isTerminalAnalysisState } from '../src/progress-room-protocol';

const analysis: Analysis = {
  id: 'analysis-1',
  videoPath: '/race.mp4',
  videoName: 'race.mp4',
  carDescription: null,
  state: 'running',
  phase: 'tracking',
  progress: 0.5,
  checkpoint: 'tracking-halfway',
  error: null,
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
};

describe('analysis progress protocol', () => {
  it('creates snapshot and update messages with the complete analysis', () => {
    expect(createProgressMessage(analysis, 'snapshot')).toEqual({ type: 'snapshot', analysis });
    expect(createProgressMessage(analysis)).toEqual({ type: 'updated', analysis });
  });

  it('recognizes terminal analysis states', () => {
    expect(isTerminalAnalysisState('completed')).toBe(true);
    expect(isTerminalAnalysisState('failed')).toBe(true);
    expect(isTerminalAnalysisState('cancelled')).toBe(true);
    expect(isTerminalAnalysisState('running')).toBe(false);
  });
});
