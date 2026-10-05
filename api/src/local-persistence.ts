import type { TrackingRecovery } from '../../shared/tracking-contract';
import Database from "better-sqlite3";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CorrectionSet } from "../../shared/calibration-contract";
import { analyses, correctionSets, localArtifacts, processingRuns, trackingRecoveries } from "./db/schema";
import type { Analysis, AnalysisStore, CreateAnalysisInput } from "./domain";

export type ProcessingRun = typeof processingRuns.$inferSelect & { status: "running" | "cancelled" | "failed" | "completed" | "needs_correction" };
export type LocalArtifact = typeof localArtifacts.$inferSelect;
type CorrectionPayload = Omit<CorrectionSet, "id" | "analysisId" | "version" | "accepted" | "createdAt">;

/** Stores local metadata in SQLite while keeping source videos and artifacts on disk. */
export class LocalPersistence implements AnalysisStore {
  readonly db: BetterSQLite3Database;
  private readonly sqlite: Database.Database;

  /** Opens a local database and applies only generated Drizzle migrations. */
  constructor(path: string, migrationsFolder: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new Database(path);
    this.sqlite.pragma("foreign_keys = ON");
    this.db = drizzle(this.sqlite);
    migrate(this.db, { migrationsFolder });
  }

  /** Releases the database handle. */
  close(): void { this.sqlite.close(); }

  /** Persists a draft before calibration or queueing. */
  async createDraft(input: CreateAnalysisInput): Promise<Analysis> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db.insert(analyses).values({ id, videoPath: input.videoPath, videoName: input.videoName, carDescription: input.carDescription ?? null, state: "draft", phase: "created", progress: 0, createdAt: now, updatedAt: now, videoStorage: input.videoStorage ?? "browser-sqlite", localVideoRef: JSON.stringify(input.localVideoRef ?? {}), acceptedCorrectionSetId: null }).run();
    const created = await this.get(id);
    if (!created) throw new Error("analysis was not persisted");
    return created;
  }

  /** Reads one analysis without accessing its source video. */
  async get(id: string): Promise<Analysis | undefined> {
    const row = this.db.select().from(analyses).where(eq(analyses.id, id)).get();
    return row ? { ...row, state: row.state as Analysis["state"], phase: row.phase as Analysis["phase"], videoStorage: row.videoStorage as Analysis["videoStorage"], localVideoRef: JSON.parse(row.localVideoRef) } : undefined;
  }

  /** Returns saved metadata without reading source videos or large observation files. */
  async listAnalyses(): Promise<Analysis[]> {
    const rows = this.db.select().from(analyses).orderBy(desc(analyses.updatedAt), analyses.id).all();
    return rows.map(row => ({ ...row, state: row.state as Analysis['state'], phase: row.phase as Analysis['phase'], videoStorage: row.videoStorage as Analysis['videoStorage'], localVideoRef: JSON.parse(row.localVideoRef) }));
  }

  /** Atomically changes only acceptance and lifecycle metadata; prior correction payloads stay immutable. */
  async selectCorrectionSet(analysisId: string, correctionSetId: string, expected: { updatedAt: string; acceptedCorrectionSetId: string | null }): Promise<Analysis> {
    this.db.transaction(tx => {
      const analysis = tx.select().from(analyses).where(eq(analyses.id, analysisId)).get();
      if (!analysis) throw new Error('Analysis not found; reload saved analyses');
      if (analysis.updatedAt !== expected.updatedAt || analysis.acceptedCorrectionSetId !== expected.acceptedCorrectionSetId) throw new Error('Analysis authority changed; reopen before selecting corrections');
      if (!['ready', 'awaiting_calibration', 'completed', 'needs_correction', 'failed', 'cancelled'].includes(analysis.state)) throw new Error('Stop processing before selecting corrections');
      const correction = tx.select().from(correctionSets).where(and(eq(correctionSets.id, correctionSetId), eq(correctionSets.analysisId, analysisId))).get();
      if (!correction) throw new Error('Correction version not found for this analysis');
      tx.update(correctionSets).set({ accepted: false }).where(eq(correctionSets.analysisId, analysisId)).run();
      tx.update(correctionSets).set({ accepted: true }).where(eq(correctionSets.id, correctionSetId)).run();
      const updatedAt = new Date(Math.max(Date.now(), Date.parse(analysis.updatedAt) + 1)).toISOString();
      tx.update(analyses).set({ acceptedCorrectionSetId: correctionSetId, state: 'ready', phase: 'calibrating', progress: 0, checkpoint: 'correction-selected', error: null, updatedAt }).where(eq(analyses.id, analysisId)).run();
    });
    const result = await this.get(analysisId);
    if (!result) throw new Error('Analysis not found');
    return result;
  }

  /** Persists workflow progress only against its current snapshot; acceptance belongs to correction transactions. */
  async save(analysis: Analysis): Promise<void> {
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(analysis.updatedAt) + 1)).toISOString();
    const result = this.db.update(analyses).set({ state: analysis.state, phase: analysis.phase, progress: analysis.progress, checkpoint: analysis.checkpoint, error: analysis.error, updatedAt }).where(and(eq(analyses.id, analysis.id), eq(analyses.updatedAt, analysis.updatedAt), analysis.acceptedCorrectionSetId ? eq(analyses.acceptedCorrectionSetId, analysis.acceptedCorrectionSetId) : isNull(analyses.acceptedCorrectionSetId))).run();
    if (result.changes !== 1) throw new Error('Analysis authority changed; reopen before changing lifecycle');
  }

  /** Appends and accepts one new immutable version under atomic lifecycle and optimistic authority checks. */
  async appendAcceptedCorrectionSet(analysisId: string, payload: CorrectionPayload, expected: { updatedAt: string; acceptedCorrectionSetId: string | null }): Promise<CorrectionSet> {
    return this.db.transaction(tx => {
      const analysis = tx.select().from(analyses).where(eq(analyses.id, analysisId)).get();
      if (analysis?.state !== 'awaiting_calibration' || analysis.updatedAt !== expected.updatedAt || analysis.acceptedCorrectionSetId !== expected.acceptedCorrectionSetId) throw new Error('Analysis authority changed; reopen before saving corrections');
      const latest = tx.select().from(correctionSets).where(eq(correctionSets.analysisId, analysisId)).orderBy(desc(correctionSets.version)).get();
      const now = new Date(Math.max(Date.now(), Date.parse(analysis.updatedAt) + 1)).toISOString();
      const set: CorrectionSet = { ...payload, id: crypto.randomUUID(), analysisId, version: (latest?.version ?? 0) + 1, accepted: true, createdAt: now };
      tx.update(correctionSets).set({ accepted: false }).where(eq(correctionSets.analysisId, analysisId)).run();
      tx.insert(correctionSets).values({ id: set.id, analysisId, version: set.version, payload: JSON.stringify(payload), accepted: true, createdAt: now }).run();
      tx.update(analyses).set({ state: 'ready', phase: 'calibrating', acceptedCorrectionSetId: set.id, updatedAt: now }).where(eq(analyses.id, analysisId)).run();
      return set;
    });
  }

  /** Appends a correction version; accepted payloads are never modified. */
  async createCorrectionSet(analysisId: string, payload: CorrectionPayload): Promise<CorrectionSet> {
    const last = this.db.select().from(correctionSets).where(eq(correctionSets.analysisId, analysisId)).orderBy(desc(correctionSets.version)).get();
    const set = { ...payload, id: crypto.randomUUID(), analysisId, version: (last?.version ?? 0) + 1, accepted: false, createdAt: new Date().toISOString() };
    this.db.insert(correctionSets).values({ ...set, payload: JSON.stringify(payload) }).run();
    return set;
  }

  /** Lists immutable correction payloads with their current acceptance flags. */
  async listCorrectionSets(analysisId: string): Promise<CorrectionSet[]> {
    return this.db.select().from(correctionSets).where(eq(correctionSets.analysisId, analysisId)).orderBy(desc(correctionSets.version)).all().map((row) => ({ ...JSON.parse(row.payload), id: row.id, analysisId, version: row.version, accepted: row.accepted, createdAt: row.createdAt }));
  }

  /** Atomically selects the correction authority and makes the draft ready. */
  async acceptCorrectionSet(analysisId: string, correctionSetId: string): Promise<CorrectionSet> {
    const set = (await this.listCorrectionSets(analysisId)).find((item) => item.id === correctionSetId);
    if (!set) throw new Error("correction set not found");
    this.db.transaction((tx) => {
      tx.update(correctionSets).set({ accepted: false }).where(eq(correctionSets.analysisId, analysisId)).run();
      tx.update(correctionSets).set({ accepted: true }).where(and(eq(correctionSets.id, correctionSetId), eq(correctionSets.analysisId, analysisId))).run();
      tx.update(analyses).set({ state: "ready", acceptedCorrectionSetId: correctionSetId, updatedAt: new Date().toISOString() }).where(eq(analyses.id, analysisId)).run();
    });
    return { ...set, accepted: true };
  }

  /** Gets the latest run for diagnostics and restart decisions. */
  async getRun(analysisId: string): Promise<ProcessingRun | undefined> {
    return this.db.select().from(processingRuns).where(eq(processingRuns.analysisId, analysisId)).orderBy(desc(processingRuns.createdAt)).get() as ProcessingRun | undefined;
  }

  /** Resumes a matching interrupted run or appends a new reproducible execution. */
  async startRun(analysisId: string, correctionSetId: string, providerVersion: string, fresh = false): Promise<ProcessingRun> {
    const prior = await this.getRun(analysisId);
    if (!fresh && prior && prior.correctionSetId === correctionSetId && prior.providerVersion === providerVersion && ["running", "cancelled", "failed", "needs_correction"].includes(prior.status)) {
      await this.updateRun(prior.id, { status: "running", error: null });
      return { ...prior, status: "running", error: null };
    }
    const now = new Date(Math.max(Date.now(), prior ? Date.parse(prior.createdAt) + 1 : 0)).toISOString();
    const run: ProcessingRun = { id: crypto.randomUUID(), analysisId, correctionSetId, providerVersion, status: "running", frame: -1, trackingFrame: -1, error: null, createdAt: now, updatedAt: now };
    this.db.insert(processingRuns).values(run).run();
    return run;
  }

  /** Records durable checkpoint or terminal state without discarding prior frame progress. */
  async updateRun(id: string, fields: Partial<Pick<ProcessingRun, "status" | "frame" | "trackingFrame" | "error">>): Promise<void> {
    this.db.update(processingRuns).set({ ...fields, updatedAt: new Date().toISOString() }).where(eq(processingRuns.id, id)).run();
  }

  /** Returns artifact references for the accepted analysis history. */
  async listArtifacts(analysisId: string): Promise<LocalArtifact[]> {
    return this.db.select().from(localArtifacts).where(eq(localArtifacts.analysisId, analysisId)).all();
  }

  /** Publishes a set of completed disk references atomically. */
  async replaceArtifacts(run: ProcessingRun, values: Array<{ kind: string; path: string }>): Promise<void> {
    this.db.transaction((tx) => {
      tx.delete(localArtifacts).where(eq(localArtifacts.runId, run.id)).run();
      for (const value of values) tx.insert(localArtifacts).values({ ...value, id: crypto.randomUUID(), analysisId: run.analysisId, runId: run.id, correctionSetId: run.correctionSetId, createdAt: new Date().toISOString() }).run();
    });
  }
  /** Lists append-only identity confirmations under one calibration authority. */
  async listTrackingRecoveries(analysisId: string, correctionSetId: string): Promise<TrackingRecovery[]> {
    return this.db.select().from(trackingRecoveries).where(and(eq(trackingRecoveries.analysisId, analysisId), eq(trackingRecoveries.correctionSetId, correctionSetId))).all().map(row => ({ ...row, box: JSON.parse(row.box) }));
  }

  /** Appends a manual identity confirmation without changing accepted calibration. */
  async addTrackingRecovery(input: Omit<TrackingRecovery, "id" | "createdAt">): Promise<TrackingRecovery> {
    const recovery = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    this.db.insert(trackingRecoveries).values({ ...recovery, box: JSON.stringify(recovery.box) }).run();
    return recovery;
  }

}
