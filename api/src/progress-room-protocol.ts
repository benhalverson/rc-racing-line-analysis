import type { Analysis, AnalysisState } from './domain.js';

export type AnalysisProgressMessage = {
  type: 'snapshot' | 'updated';
  analysis: Analysis;
};

export function createProgressMessage(
  analysis: Analysis,
  type: AnalysisProgressMessage['type'] = 'updated',
): AnalysisProgressMessage {
  return { type, analysis };
}

export function isTerminalAnalysisState(state: AnalysisState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}
