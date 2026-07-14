import { describe, expect, it } from 'vitest';
import { compareLine, reviseAlternative } from './alternative-lines';

describe('alternative lines', () => {
  it('calculates geometry-only comparisons without a lap-time prediction', () => {
    const comparison = compareLine([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);

    expect(comparison).toMatchObject({ length: 20, corner: { entry: 0, apex: 50, exit: 100 } });
    expect(comparison.uncertainty).toBeGreaterThan(0);
    expect(comparison).not.toHaveProperty('lapTime');
  });

  it('retains prior versions when a named alternative is revised', () => {
    const first = reviseAlternative([], 'analysis-1', 'Late apex', [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    const revised = reviseAlternative(first, 'analysis-1', 'Late apex', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);

    expect(revised[0]).toMatchObject({ analysisId: 'analysis-1', correctionSetId: 'accepted', trackReferenceId: 'stabilized-track' });
    expect(revised[0].versions).toHaveLength(2);
    expect(revised[0].versions[0].points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 10 }]);
  });
});
