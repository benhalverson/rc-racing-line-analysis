import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { GEOMETRY_VERSION, geometry, observedGeometry, sameAuthority, type AlternativeAuthority, type AlternativeEdit, type AlternativeVersion, type AlternativeWorkspace } from '../../shared/alternative-contract';
import type { RacingLineReview } from '../../shared/review-contract';
import { alternativeRevisions, analyses, processingRuns, reviewRevisions } from './db/schema';
import type { LocalArtifactStore } from './local-artifacts';
import type { LocalPersistence } from './local-persistence';
import { ReviewWorkflow } from './review-workflow';

/** Persists geometry-only hypotheses under the current decoded review authority. */
export class AlternativeWorkflow {
  /** Reuses the production evidence and local metadata/artifact stores. */
  constructor(private readonly persistence: LocalPersistence, private readonly artifacts: LocalArtifactStore) {}

  /** Hashes the actual stabilization reference rather than inventing a reference identifier. */
  private authority(review: RacingLineReview): AlternativeAuthority {
    return { runId: review.revision.runId, correctionSetId: review.revision.correctionSetId, evidenceId: review.revision.evidenceId, reviewVersion: review.revision.version, trackReferenceId: createHash('sha256').update(JSON.stringify({ stabilization: review.stabilization, referenceSize: review.tracking.referenceSize })).digest('hex') };
  }

  /** Reopens every immutable version, retaining stale provenance without comparing stale evidence. */
  async get(id: string): Promise<AlternativeWorkspace> {
    const review = await new ReviewWorkflow(this.persistence, this.artifacts).get(id); const authority = this.authority(review);
    const rows = this.persistence.db.select().from(alternativeRevisions).where(eq(alternativeRevisions.analysisId, id)).orderBy(alternativeRevisions.createdAt, alternativeRevisions.version).all();
    const versions = await Promise.all(rows.map(async row => {
      const payload = JSON.parse(await readFile(row.path, 'utf8')) as Pick<AlternativeVersion, 'points' | 'geometry' | 'geometryVersion'>;
      return { ...row, ...payload, hypothetical: true as const, current: sameAuthority(row, authority) };
    }));
    return { authority, observed: observedGeometry(review), versions, referenceSize: review.tracking.referenceSize };
  }

  /** Validates input, writes immutable local geometry, and atomically compares then appends metadata. */
  async save(id: string, input: AlternativeEdit): Promise<AlternativeWorkspace> {
    const review = await new ReviewWorkflow(this.persistence, this.artifacts).get(id); const authority = this.authority(review);
    if (!sameAuthority(input, authority)) throw new Error('Review authority changed; reload before saving alternatives');
    const name = input.name.trim(); const size = review.tracking.referenceSize;
    if (!name || name.length > 100 || [...name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error('Enter a name of 1–100 characters without control characters');
    if (!Array.isArray(input.points) || input.points.length < 2 || input.points.length > 10000 || !input.points.every(p => [p.x, p.y].every(Number.isFinite) && p.x >= 0 && p.y >= 0 && p.x <= size.width && p.y <= size.height)) throw new Error('Draw 2–10000 finite points inside the track reference');
    if (input.points.some((p, i) => i > 0 && Math.hypot(p.x - input.points[i - 1].x, p.y - input.points[i - 1].y) < .01)) throw new Error('Adjacent points must be distinct');
    const revisionId = crypto.randomUUID(); const alternativeId = input.alternativeId ?? crypto.randomUUID();
    const directory = join(this.artifacts.root, 'alternatives'); const path = join(directory, `${revisionId}.json`); const temporary = `${path}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify({ points: input.points, geometry: geometry([input.points]), geometryVersion: GEOMETRY_VERSION }), { flag: 'wx' }); await rename(temporary, path);
      const current = this.authority(await new ReviewWorkflow(this.persistence, this.artifacts).get(id));
      if (!sameAuthority(input, current)) throw new Error('Accepted evidence changed; reload before saving alternatives');
      this.persistence.db.transaction(tx => {
        const analysis = tx.select().from(analyses).where(eq(analyses.id, id)).get();
        const run = tx.select().from(processingRuns).where(eq(processingRuns.analysisId, id)).orderBy(desc(processingRuns.createdAt)).get();
        const revision = tx.select().from(reviewRevisions).where(and(eq(reviewRevisions.analysisId, id), eq(reviewRevisions.runId, input.runId))).orderBy(desc(reviewRevisions.version)).get();
        if (analysis?.acceptedCorrectionSetId !== input.correctionSetId || !analysis || !['completed', 'needs_correction', 'cancelled', 'failed'].includes(analysis.state) || run?.id !== input.runId || (revision?.version ?? 0) !== input.reviewVersion) throw new Error('Review authority changed; reload before saving alternatives');
        const prior = tx.select().from(alternativeRevisions).where(and(eq(alternativeRevisions.analysisId, id), eq(alternativeRevisions.alternativeId, alternativeId))).orderBy(desc(alternativeRevisions.version)).get();
        if (input.alternativeId && !prior || (prior?.version ?? 0) !== input.baseVersion) throw new Error('Alternative revision changed; reload before saving');
        tx.insert(alternativeRevisions).values({ id: revisionId, alternativeId, analysisId: id, ...authority, name, version: input.baseVersion + 1, path, createdAt: new Date().toISOString() }).run();
      });
    } catch (error) { await rm(temporary, { force: true }); await rm(path, { force: true }); throw error; }
    return this.get(id);
  }
}
