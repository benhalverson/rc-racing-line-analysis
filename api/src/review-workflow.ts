import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { createRacingLineReview, detectCrossings, type ReviewRevision, type StartFinishLine } from '../../shared/review-contract';
import { reviewRevisions } from './db/schema';
import type { LocalPersistence } from './local-persistence';
import type { LocalArtifactStore } from './local-artifacts';
import { LocalTimingStore } from './local-timing-store';

export type ReviewEdit = { version: number; evidenceId: string; runId: string } & (
  { action: 'gate'; line: StartFinishLine } | { action: 'timing'; timingImportId: string } |
  { action: 'add'; seconds: number } | { action: 'correct'; id: string; seconds: number } |
  { action: 'remove'; id: string } | { action: 'assign'; id: string; lapNumber: number | null }
);

/** Keeps review corrections under the local accepted run authority, independent of CV calibration. */
export class ReviewWorkflow {
  /** Reuses existing disk artifacts and the generated Drizzle metadata schema. */
  constructor(private readonly persistence: LocalPersistence, private readonly artifacts: LocalArtifactStore) {}

  /** Loads current decoded evidence and only decisions belonging to that run/correction set. */
  async get(id: string) {
    const analysis = await this.persistence.get(id); const run = await this.persistence.getRun(id);
    if (!analysis || !run || run.correctionSetId !== analysis.acceptedCorrectionSetId || !['completed', 'needs_correction', 'cancelled', 'failed'].includes(analysis.state)) throw new Error('Review requires published evidence from the accepted terminal run');
    const tracking = await this.artifacts.readPublishedTracking(id); const stabilization = await this.artifacts.readPublished(id);
    const correction = (await this.persistence.listCorrectionSets(id)).find(c => c.id === run.correctionSetId);
    if (!tracking || !stabilization || !correction) throw new Error('No decoded evidence is available for review');
    const row = this.persistence.db.select().from(reviewRevisions).where(and(eq(reviewRevisions.analysisId, id), eq(reviewRevisions.runId, run.id), eq(reviewRevisions.correctionSetId, run.correctionSetId))).orderBy(desc(reviewRevisions.version)).get();
    const evidenceId = createHash('sha256').update(JSON.stringify({ tracking, stabilization })).digest('hex');
    const saved: ReviewRevision | undefined = row ? JSON.parse(row.payload) : undefined;
    const revision: ReviewRevision = saved?.evidenceId === evidenceId ? saved : { version: row?.version ?? 0, evidenceId, runId: run.id, correctionSetId: run.correctionSetId, timingImportId: null, startFinish: null, crossings: [] };
    const timing = revision.timingImportId ? await new LocalTimingStore(this.persistence.db).getTimingImport(revision.timingImportId) ?? null : null;
    return createRacingLineReview(revision, tracking, stabilization, correction.raceStartSeconds, timing);
  }

  /** Validates an optimistic append-only edit against source timestamps and immutable timing provenance. */
  async edit(id: string, input: ReviewEdit) {
    const review = await this.get(id);
    if (input.version !== review.revision.version || input.runId !== review.revision.runId || input.evidenceId !== review.revision.evidenceId) throw new Error('Review authority changed; reload before editing');
    const revision: ReviewRevision = structuredClone(review.revision);
    const crossing = 'id' in input ? revision.crossings.find(c => c.id === input.id) : undefined;
    if ('id' in input && !crossing) throw new Error('Crossing not found');
    if (input.action === 'gate') {
      const size = review.tracking.referenceSize;
      if (![input.line.a, input.line.b].every(p => [p.x, p.y].every(Number.isFinite) && p.x >= 0 && p.y >= 0 && p.x <= size.width && p.y <= size.height) || Math.hypot(input.line.a.x - input.line.b.x, input.line.a.y - input.line.b.y) < 1) throw new Error('Choose distinct gate endpoints inside reference pixels');
      if (revision.crossings.some(c => c.source === 'manual' || c.liveRcLapNumber !== null)) throw new Error('Remove corrected or assigned crossings before replacing the gate');
      revision.startFinish = input.line;
      revision.crossings = detectCrossings(review.tracking, input.line, review.raceStartSeconds);
    } else if (input.action === 'timing') {
      if (!await new LocalTimingStore(this.persistence.db).getTimingImport(input.timingImportId)) throw new Error('Saved timing import not found');
      revision.timingImportId = input.timingImportId;
      revision.crossings.forEach(c => { c.liveRcLapNumber = null; });
    } else if (input.action === 'add' || input.action === 'correct') {
      const end = review.tracking.observations.at(-1)?.seconds ?? 0;
      if (!Number.isFinite(input.seconds) || input.seconds <= review.raceStartSeconds || input.seconds > end) throw new Error('Crossing must be inside the decoded video interval after race start');
      if (input.action === 'add') revision.crossings.push({ id: crypto.randomUUID(), seconds: input.seconds, source: 'manual', frameBefore: null, frameAfter: null, liveRcLapNumber: null });
      else if (crossing) {
        const index = revision.crossings.indexOf(crossing);
        if (input.seconds <= (revision.crossings[index - 1]?.seconds ?? review.raceStartSeconds) || input.seconds >= (revision.crossings[index + 1]?.seconds ?? Infinity)) throw new Error('Correction must remain between adjacent crossings');
        crossing.seconds = input.seconds; crossing.source = 'manual'; crossing.frameBefore = null; crossing.frameAfter = null;
      }
      revision.crossings.sort((a, b) => a.seconds - b.seconds);
      if (revision.crossings.some((c, i) => i > 0 && c.seconds <= revision.crossings[i - 1].seconds)) throw new Error('Crossings must have distinct ordered times');
    } else if (input.action === 'remove') revision.crossings = revision.crossings.filter(c => c.id !== input.id);
    else if (input.action === 'assign' && crossing) {
      if (input.lapNumber !== null && (!review.timing?.laps.some(l => l.lapNumber === input.lapNumber) || revision.crossings.some(c => c.id !== crossing.id && c.liveRcLapNumber === input.lapNumber))) throw new Error('Choose an unassigned lap from the bound LiveRC import');
      crossing.liveRcLapNumber = input.lapNumber;
    }
    // Check authority again after async reads, then compare-and-append in one SQLite transaction.
    const current = await this.get(id);
    if (current.revision.runId !== input.runId || current.revision.correctionSetId !== revision.correctionSetId || current.revision.evidenceId !== revision.evidenceId) throw new Error('Accepted evidence changed');
    this.persistence.db.transaction(tx => {
      const latest = tx.select().from(reviewRevisions).where(and(eq(reviewRevisions.analysisId, id), eq(reviewRevisions.runId, input.runId))).orderBy(desc(reviewRevisions.version)).get();
      if ((latest?.version ?? 0) !== input.version) throw new Error('Review changed; reload before editing');
      revision.version += 1;
      tx.insert(reviewRevisions).values({ id: crypto.randomUUID(), analysisId: id, runId: revision.runId, correctionSetId: revision.correctionSetId, version: revision.version, payload: JSON.stringify(revision), createdAt: new Date().toISOString() }).run();
    });
    return this.get(id);
  }
}
