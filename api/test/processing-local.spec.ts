import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalPersistence } from '../src/local-persistence';
import { LocalArtifactStore } from '../src/local-artifacts';
import { executeLocalStabilization } from '../src/processing-local';
import { AnalysisWorkflow } from '../src/workflow';
import type { StabilizationArtifacts } from '../src/stabilization';

const cleanups: Array<() => Promise<void>> = [];
/** Create real isolated metadata and artifact ports for workflow behavior. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'stabilization-workflow-'));
  const persistence = new LocalPersistence(join(root, 'metadata.sqlite'), resolve('api/drizzle/local-migrations'));
  const artifacts = new LocalArtifactStore(join(root, 'artifacts'), persistence);
  const workflow = new AnalysisWorkflow(persistence);
  const analysis = await workflow.createDraft({ videoPath: 'local-disk://fixture', videoName: 'fixture.mkv', videoStorage: 'local-disk' });
  await workflow.startCalibration(analysis.id);
  const correction = await workflow.createAndAcceptCorrectionSet(analysis.id, { raceStartSeconds: 0, markerReferenceSeconds: 0, carSelectionSeconds: 0, markers: [{ id: 'a', position: { x: .2, y: .2 }, source: 'manual' }], selectedCarBox: { x: .2, y: .2, width: .1, height: .1 } });
  await workflow.queue(analysis.id); await workflow.start(analysis.id);
  cleanups.push(async () => { persistence.close(); await rm(root, { recursive: true, force: true }); });
  return { root, persistence, artifacts, workflow, analysis, correction };
}
/** Supply explicit transform fixtures through the provider contract. */
function fixture(frame: number, usable = true): StabilizationArtifacts {
  return { markerObservations: [], transforms: [{ frame, model: 'affine', matrix: [1, 0, 0, 0, 1, 0], quality: { enoughMarkers: usable, reprojectionValid: usable, inliersValid: usable, scaleValid: usable, rotationValid: usable, cropValid: usable, usable } }] };
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe('local stabilization lifecycle with durable public ports', () => {
  it('recovers publication failure after the final decoded frame', async () => {
    const ctx = await setup();
    const commit = vi.spyOn(ctx.artifacts, 'commit').mockRejectedValueOnce(new Error('disk publication interrupted'));
    const options = { resolveVideoPath: async () => '/fixture', providerFactory: () => ({ stabilize: async () => fixture(0) }) };
    await expect(executeLocalStabilization(ctx.analysis.id, ctx.workflow, ctx.persistence, ctx.artifacts, options)).rejects.toThrow('disk publication interrupted');
    expect(await ctx.workflow.get(ctx.analysis.id)).toMatchObject({ state: 'failed', checkpoint: 'stabilization-frame-0' });
    await ctx.workflow.resume(ctx.analysis.id);
    await executeLocalStabilization(ctx.analysis.id, ctx.workflow, ctx.persistence, ctx.artifacts, { ...options, providerFactory: supplied => ({ stabilize: async () => { expect(supplied.startFrame).toBe(0); return fixture(0); } }) });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(await ctx.workflow.get(ctx.analysis.id)).toMatchObject({ state: 'completed' });
    expect((await ctx.artifacts.readPublished(ctx.analysis.id))?.transforms).toHaveLength(1);
  });

  it('writes local payloads and SQLite references under the accepted correction authority', async () => {
    const ctx = await setup();
    await executeLocalStabilization(ctx.analysis.id, ctx.workflow, ctx.persistence, ctx.artifacts, { resolveVideoPath: async () => '/fixture.mkv', providerFactory: options => ({ stabilize: async () => { expect(options.markers).toEqual(ctx.correction.markers); return fixture(0); } }) });
    expect(await ctx.workflow.get(ctx.analysis.id)).toMatchObject({ state: 'completed', checkpoint: 'completed' });
    const run = await ctx.persistence.getRun(ctx.analysis.id);
    expect(run).toMatchObject({ correctionSetId: ctx.correction.id, status: 'completed', frame: 0 });
    const refs = await ctx.persistence.listArtifacts(ctx.analysis.id);
    expect(refs).toHaveLength(3);
    expect(refs.every(ref => ref.correctionSetId === ctx.correction.id && ref.path.startsWith(ctx.root))).toBe(true);
    const transforms = refs.find(ref => ref.kind === 'transforms');
    if (!transforms) throw new Error('Transform reference missing');
    expect(JSON.parse(await readFile(transforms.path, 'utf8'))).toEqual(fixture(0).transforms);
  });
  it('retains a failure checkpoint and resumes without losing its prefix', async () => {
    const ctx = await setup();
    await expect(executeLocalStabilization(ctx.analysis.id, ctx.workflow, ctx.persistence, ctx.artifacts, { resolveVideoPath: async () => '/fixture', providerFactory: options => ({ stabilize: async () => { await options.onFrame?.(fixture(0)); throw new Error('decoder failed'); } }) })).rejects.toThrow('decoder failed');
    expect(await ctx.workflow.get(ctx.analysis.id)).toMatchObject({ state: 'failed', checkpoint: 'stabilization-frame-0', error: 'decoder failed' });
    const run = await ctx.persistence.getRun(ctx.analysis.id);
    await ctx.workflow.resume(ctx.analysis.id);
    await executeLocalStabilization(ctx.analysis.id, ctx.workflow, ctx.persistence, ctx.artifacts, { resolveVideoPath: async () => '/fixture', providerFactory: options => ({ stabilize: async () => { expect(options.startFrame).toBe(0); return fixture(1); } }) });
    expect((await ctx.persistence.getRun(ctx.analysis.id))?.id).toBe(run?.id);
    expect((await ctx.artifacts.readPublished(ctx.analysis.id))?.transforms.map(item => item.frame)).toEqual([0, 1]);
  });
  it('cancels cooperatively and preserves the prior successful checkpoint', async () => {
    const ctx = await setup(); const controller = new AbortController();
    await executeLocalStabilization(ctx.analysis.id, ctx.workflow, ctx.persistence, ctx.artifacts, { signal: controller.signal, resolveVideoPath: async () => '/fixture', providerFactory: options => ({ stabilize: async () => { await options.onFrame?.(fixture(0)); controller.abort(); options.signal?.throwIfAborted(); return fixture(1); } }) });
    expect(await ctx.workflow.get(ctx.analysis.id)).toMatchObject({ state: 'cancelled', checkpoint: 'stabilization-frame-0' });
    expect(await ctx.persistence.getRun(ctx.analysis.id)).toMatchObject({ status: 'cancelled', frame: 0 });
    expect(await ctx.persistence.listArtifacts(ctx.analysis.id)).toHaveLength(0);
  });
  it('retains unusable regions for review and starts a fresh run after corrections', async () => {
    const ctx = await setup();
    await executeLocalStabilization(ctx.analysis.id, ctx.workflow, ctx.persistence, ctx.artifacts, { resolveVideoPath: async () => '/fixture', providerFactory: () => ({ stabilize: async () => fixture(0, false) }) });
    expect(await ctx.workflow.get(ctx.analysis.id)).toMatchObject({ state: 'needs_correction' });
    const priorRun = await ctx.persistence.getRun(ctx.analysis.id);
    await ctx.workflow.startCalibration(ctx.analysis.id);
    const correction = await ctx.workflow.createAndAcceptCorrectionSet(ctx.analysis.id, { ...ctx.correction, markers: [{ id: 'b', position: { x: .3, y: .3 }, source: 'manual' }] });
    await ctx.workflow.queue(ctx.analysis.id); await ctx.workflow.start(ctx.analysis.id);
    await executeLocalStabilization(ctx.analysis.id, ctx.workflow, ctx.persistence, ctx.artifacts, { resolveVideoPath: async () => '/fixture', providerFactory: options => ({ stabilize: async () => { expect(options.startFrame).toBe(0); return fixture(0); } }) });
    expect(await ctx.persistence.getRun(ctx.analysis.id)).toMatchObject({ correctionSetId: correction.id });
    expect((await ctx.persistence.getRun(ctx.analysis.id))?.id).not.toBe(priorRun?.id);
    expect(await ctx.workflow.listCorrectionSets(ctx.analysis.id)).toHaveLength(2);
  });
});
