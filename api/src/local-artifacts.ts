import { TRACKING_PROVIDER_VERSION } from "./local-video-tracking";
import type { TrackingArtifacts } from '../../shared/tracking-contract';
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StabilizationArtifacts } from "./stabilization";
import type { LocalPersistence, ProcessingRun } from "./local-persistence";

/** Writes large stabilization payloads to disk and indexes only references in SQLite. */
export class LocalArtifactStore {
  /** Uses a caller-selected local artifact directory and metadata database. */
  constructor(readonly root: string, private readonly persistence: LocalPersistence) {}

  /** Resolves an internal UUID run path without accepting caller-controlled filenames. */
  private runPath(run: ProcessingRun, name: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(run.id)) throw new Error("invalid processing run identifier");
    return join(resolve(this.root), run.id, name);
  }

  /** Atomically replaces one file so interruption leaves a readable previous checkpoint. */
  private async writeAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value), { flag: "wx" });
    await rename(temp, path);
  }

  /** Persists accumulated frame outputs before advancing the SQLite checkpoint. */
  async writeCheckpoint(run: ProcessingRun, artifacts: StabilizationArtifacts): Promise<void> {
    validateArtifacts(artifacts);
    await this.writeAtomic(this.runPath(run, "checkpoint.json"), { correctionSetId: run.correctionSetId, providerVersion: run.providerVersion, artifacts });
  }

  /** Reads a matching interrupted run; stale provider or correction output is rejected. */
  async readCheckpoint(run: ProcessingRun): Promise<StabilizationArtifacts | undefined> {
    let value: string;
    try { value = await readFile(this.runPath(run, "checkpoint.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const parsed = JSON.parse(value);
    if (parsed.correctionSetId !== run.correctionSetId || parsed.providerVersion !== run.providerVersion) throw new Error("checkpoint correction or provider mismatch");
    validateArtifacts(parsed.artifacts);
    return parsed.artifacts as StabilizationArtifacts;
  }

  /** Commits separate observation, transform, and quality files before publishing references. */
  async commit(run: ProcessingRun, artifacts: StabilizationArtifacts, tracking?: TrackingArtifacts): Promise<void> {
    validateArtifacts(artifacts);
    const values: Array<{ kind: string; value: unknown }> = [{ kind: "marker-observations", value: artifacts.markerObservations }, { kind: "transforms", value: artifacts.transforms }, { kind: "stabilization", value: artifacts }];
    if (tracking) {
      validateTracking(tracking, run);
      values.push({ kind: "tracking", value: tracking });
    }
    const refs: Array<{ kind: string; path: string }> = [];
    for (const entry of values) {
      const path = this.runPath(run, `${entry.kind}.json`);
      await this.writeAtomic(path, entry.value);
      refs.push({ kind: entry.kind, path });
    }
    await this.persistence.replaceArtifacts(run, refs);
  }


  /** Writes tracking observations before the independent durable tracking frame advances. */
  async writeTrackingCheckpoint(run: ProcessingRun, output: TrackingArtifacts): Promise<void> {
    validateTracking(output, run);
    await this.writeAtomic(this.runPath(run, "tracking-checkpoint.json"), output);
  }

  /** Validates a replay checkpoint against provider and accepted correction authority. */
  async readTrackingCheckpoint(run: ProcessingRun): Promise<TrackingArtifacts | undefined> {
    let value: string;
    try { value = await readFile(this.runPath(run, "tracking-checkpoint.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const output = JSON.parse(value); validateTracking(output, run); return output;
  }

  /** Reads tracking only from the current run under the accepted correction authority. */
  async readPublishedTracking(analysisId: string): Promise<TrackingArtifacts | undefined> {
    const analysis = await this.persistence.get(analysisId); const run = await this.persistence.getRun(analysisId);
    if (!run || run.correctionSetId !== analysis?.acceptedCorrectionSetId) return undefined;
    const ref = (await this.persistence.listArtifacts(analysisId)).find(item => item.kind === "tracking" && item.runId === run.id && item.correctionSetId === run.correctionSetId);
    if (!ref) return undefined;
    const output = JSON.parse(await readFile(ref.path, "utf8")); validateTracking(output, run); return output;
  }

  /** Reads the latest published stabilization result for browser diagnostics. */
  async readPublished(analysisId: string): Promise<StabilizationArtifacts | undefined> {
    const analysis = await this.persistence.get(analysisId);
    const run = await this.persistence.getRun(analysisId);
    const ref = (await this.persistence.listArtifacts(analysisId)).find((item) => item.kind === "stabilization" && item.runId === run?.id && item.correctionSetId === analysis?.acceptedCorrectionSetId);
    if (!ref) return undefined;
    const value: unknown = JSON.parse(await readFile(ref.path, "utf8"));
    validateArtifacts(value);
    return value;
  }
}

/** Rejects corrupt or unordered checkpoint payloads before they become resume authority. */
function validateArtifacts(value: unknown): asserts value is StabilizationArtifacts {
  if (!value || typeof value !== "object") throw new Error("invalid stabilization artifacts");
  const artifacts = value as StabilizationArtifacts;
  if (!Array.isArray(artifacts.transforms) || !Array.isArray(artifacts.markerObservations)) throw new Error("invalid stabilization artifacts");
  let prior = -1;
  for (const transform of artifacts.transforms) {
    if (!Number.isInteger(transform.frame) || transform.frame <= prior || (prior >= 0 && transform.frame !== prior + 1) || !["affine", "homography"].includes(transform.model) || !Array.isArray(transform.matrix) || (transform.matrix.length !== (transform.model === "affine" ? 6 : 9) && !(transform.matrix.length === 0 && transform.quality?.usable === false)) || !transform.matrix.every(Number.isFinite) || !transform.quality || typeof transform.quality.usable !== "boolean") throw new Error("invalid stabilization transform checkpoint");
    const quality = transform.quality;
    const signals = [quality.enoughMarkers, quality.reprojectionValid, quality.inliersValid, quality.scaleValid, quality.rotationValid, quality.cropValid];
    if (signals.some((signal) => typeof signal !== "boolean") || quality.usable !== signals.every(Boolean)) throw new Error("invalid stabilization quality checkpoint");
    prior = transform.frame;
  }
  const frames = new Set(artifacts.transforms.map((item) => item.frame));
  const identities = new Set<string>();
  let priorObservationFrame = -1;
  for (const observation of artifacts.markerObservations) {
    const identity = `${observation.frame}:${observation.markerId}`;
    if (!frames.has(observation.frame) || observation.frame < priorObservationFrame || identities.has(identity)) throw new Error("invalid marker observation ordering or identity");
    identities.add(identity); priorObservationFrame = observation.frame;
    if (!Number.isInteger(observation.frame) || observation.frame < 0 || !observation.markerId || ![observation.imagePoint?.x, observation.imagePoint?.y, observation.trackPoint?.x, observation.trackPoint?.y, observation.confidence].every(Number.isFinite)) throw new Error("invalid marker observation checkpoint");
  }
}

/** Rejects fabricated geometry, invalid ordering, and stale tracking provenance on read/write. */
function validateTracking(output: TrackingArtifacts, run: ProcessingRun): void {
  if (output.correctionSetId !== run.correctionSetId || output.providerVersion !== TRACKING_PROVIDER_VERSION || !run.providerVersion.split("+").includes(TRACKING_PROVIDER_VERSION) || !Array.isArray(output.observations) || !Array.isArray(output.segments)) throw new Error("invalid tracking authority or provider");
  const size = output.referenceSize;
  if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width <= 0 || size.height <= 0) throw new Error("invalid tracking reference size");
  /** Checks decoded image boxes against the recorded reference dimensions. */
  const validBox = (box: import("../../shared/tracking-contract").PixelBox | null): boolean => !!box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= size.width && box.y + box.height <= size.height;
  const segments = new Map<string, typeof output.segments[number]>();
  let segmentFrame = -1;
  for (const segment of output.segments) {
    if (!segment.id || segments.has(segment.id) || !Number.isInteger(segment.startFrame) || segment.startFrame <= segmentFrame || !Number.isFinite(segment.seconds) || segment.seconds < 0 || !validBox(segment.box) || !["selection", "manual"].includes(segment.source)) throw new Error("invalid tracking segment");
    segments.set(segment.id, segment); segmentFrame = segment.startFrame;
  }
  let previous = -1; let seconds = -1;
  for (const item of output.observations) {
    if (!Number.isInteger(item.frame) || item.frame < 0 || item.frame <= previous || (previous >= 0 && item.frame !== previous + 1) || !Number.isFinite(item.seconds) || item.seconds < 0 || item.seconds <= seconds || !["tracked", "suspect", "lost", "reacquired"].includes(item.quality)) throw new Error("invalid tracking checkpoint ordering");
    const segment = item.segmentId === null ? undefined : segments.get(item.segmentId);
    if (item.segmentId !== null && (!segment || segment.startFrame > item.frame || segment.seconds > item.seconds)) throw new Error("invalid tracking segment authority");
    if (item.quality === "lost" ? item.box !== null || item.trackPoint !== null : !segment || !validBox(item.box)) throw new Error("invalid tracking geometry");
    if (item.trackPoint !== null && (!Number.isFinite(item.trackPoint.x) || !Number.isFinite(item.trackPoint.y))) throw new Error("invalid track-relative point");
    if (item.quality === "suspect" && item.trackPoint !== null) throw new Error("uncertain observations cannot publish track-relative output");
    if (!item.reason || [item.appearanceError, item.ambiguityMargin].some(value => value !== null && (!Number.isFinite(value) || value < 0 || value > 1))) throw new Error("invalid tracking quality metrics");
    previous = item.frame; seconds = item.seconds;
  }
}
