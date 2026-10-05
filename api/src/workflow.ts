import type { Analysis, AnalysisStore, CreateAnalysisInput } from "./domain";
import { isNormalizedBox, isNormalizedPoint, type CorrectionSet } from "../../shared/calibration-contract";

const transitions: Record<Analysis["state"], Analysis["state"][]> = {
  draft: ["awaiting_calibration"],
  awaiting_calibration: ["ready"],
  ready: ["queued"],
  queued: ["running", "cancelled"],
  running: ["completed", "needs_correction", "failed", "cancelled"],
  needs_correction: ["awaiting_calibration", "queued", "running"],
  completed: ["awaiting_calibration", "queued"],
  failed: ["awaiting_calibration", "queued", "running"],
  cancelled: ["awaiting_calibration", "queued", "running"],
};

type ProgressUpdate = {
  phase: Analysis["phase"];
  progress: number;
  checkpoint?: string;
};

export class AnalysisWorkflow {
  /** Construct the lifecycle service over its persistence and progress ports. */
  constructor(
    private readonly store: AnalysisStore,
    private readonly onChange?: (analysis: Analysis) => Promise<void> | void,
  ) {}

  /** Create metadata for a local video before calibration. */
  async createDraft(input: CreateAnalysisInput): Promise<Analysis> {
    if (!input.videoPath.trim() || !input.videoName.trim()) {
      throw new Error("videoPath and videoName are required");
    }
    const analysis = await this.store.createDraft(input);
    await this.onChange?.(analysis);
    return analysis;
  }

  /** Lists saved workspaces through the supported local persistence port. */
  async listAnalyses(): Promise<Analysis[]> {
    if (!this.store.listAnalyses) throw new Error('Saved analyses require the local runtime');
    return this.store.listAnalyses();
  }

  /** Selects existing immutable correction authority using an atomic optimistic store operation. */
  async selectCorrectionSet(id: string, correctionSetId: string, expected: { updatedAt: string; acceptedCorrectionSetId: string | null }): Promise<Analysis> {
    if (!this.store.selectCorrectionSet) throw new Error('Correction selection requires the local runtime');
    const analysis = await this.store.selectCorrectionSet(id, correctionSetId, expected);
    await this.onChange?.(analysis);
    return analysis;
  }

  /** Retrieve an analysis or reject an unknown identifier. */
  async get(id: string): Promise<Analysis> {
    const analysis = await this.store.get(id);
    if (!analysis) throw new Error("analysis not found");
    return analysis;
  }

  /** Begin a fresh run using the accepted correction version. */
  async queue(id: string): Promise<Analysis> {
    const analysis = await this.get(id);
    if (!transitions[analysis.state].includes("queued")) throw new Error(`cannot transition ${analysis.state} to queued`);
    if (!analysis.acceptedCorrectionSetId) throw new Error("accepted calibration is required before queueing");
    const correction = (await this.listCorrectionSets(id)).find((set) => set.id === analysis.acceptedCorrectionSetId && set.accepted);
    if (!correction) throw new Error("accepted correction set not found");
    return this.transition(id, "queued", { phase: "calibrating", progress: 0, checkpoint: "queued", error: null });
  }

  /** Open operator calibration while preserving correction history. */
  async startCalibration(id: string): Promise<Analysis> {
    const analysis = await this.get(id);
    if (analysis.state === "awaiting_calibration") return analysis;
    return this.transition(id, "awaiting_calibration", { phase: "calibrating", checkpoint: "calibration-started", error: null });
  }
  /** Append and accept valid operator decisions only during calibration. */
  async createAndAcceptCorrectionSet(id: string, payload: Omit<CorrectionSet, "id" | "analysisId" | "version" | "accepted" | "createdAt">, expected?: { updatedAt: string; acceptedCorrectionSetId: string | null }) {
    const analysis = await this.get(id);
    if (expected && (analysis.updatedAt !== expected.updatedAt || analysis.acceptedCorrectionSetId !== expected.acceptedCorrectionSetId)) throw new Error('Analysis authority changed; reopen before saving corrections');
    if (analysis.state !== "awaiting_calibration") {
      throw new Error(`correction sets can only be accepted while awaiting calibration, not ${analysis.state}`);
    }
    if (![payload.raceStartSeconds, payload.markerReferenceSeconds, payload.carSelectionSeconds].every((value) => Number.isFinite(value) && value >= 0) || !isNormalizedBox(payload.selectedCarBox)) throw new Error("invalid calibration geometry or time");
    if (payload.markers.length === 0 || new Set(payload.markers.map((marker) => marker.id)).size !== payload.markers.length || payload.markers.some((marker) => !marker.id.trim() || !isNormalizedPoint(marker.position))) throw new Error("invalid marker identities or reference positions");
    if (this.store.appendAcceptedCorrectionSet) return this.store.appendAcceptedCorrectionSet(id, payload, { updatedAt: analysis.updatedAt, acceptedCorrectionSetId: analysis.acceptedCorrectionSetId ?? null });
    const set = await this.store.createCorrectionSet(id, payload);
    return this.store.acceptCorrectionSet(id, set.id);
  }
  /** Return correction history belonging to this analysis. */
  async listCorrectionSets(id: string) { await this.get(id); return this.store.listCorrectionSets(id); }

  /** Start a queued run or retain a resumable checkpoint. */
  async start(id: string): Promise<Analysis> {
    const analysis = await this.get(id);
    if (analysis.state === "running") return analysis;
    const hasCheckpoint = Boolean(analysis.checkpoint && analysis.checkpoint !== "queued");
    return this.transition(
      id,
      "running",
      hasCheckpoint
        ? { error: null }
        : { phase: "calibrating", progress: 0, checkpoint: "queued", error: null },
    );
  }

  /** Persist finite progress and the last successful checkpoint. */
  async report(id: string, update: ProgressUpdate): Promise<Analysis> {
    const analysis = await this.get(id);
    if (analysis.state !== "running") {
      throw new Error("only running analyses can report progress");
    }
    if (!Number.isFinite(update.progress) || update.progress < 0 || update.progress > 1) {
      throw new Error("progress must be between 0 and 1");
    }
    const next = {
      ...analysis,
      phase: update.phase,
      progress: update.progress,
      checkpoint: update.checkpoint ?? analysis.checkpoint,
    };
    await this.store.save(next);
    const persisted = await this.get(id);
    await this.onChange?.(persisted);
    return persisted;
  }

  /** Mark the current processing stage complete for review. */
  async complete(id: string): Promise<Analysis> {
    return this.transition(id, "completed", {
      phase: "review",
      progress: 1,
      checkpoint: "completed",
    });
  }

  /** Retain diagnostics and request an accepted calibration correction after unusable stabilization. */
  async needsCorrection(id: string, error: string): Promise<Analysis> {
    return this.transition(id, "needs_correction", { phase: "review", error });
  }

  /** Record failure without discarding the last successful checkpoint. */
  async fail(id: string, error: string): Promise<Analysis> {
    return this.transition(id, "failed", { error });
  }

  /** Cancel a queued or running job while retaining its checkpoint. */
  async cancel(id: string): Promise<Analysis> {
    const analysis = await this.get(id);
    if (analysis.state === "cancelled") return analysis;
    return this.transition(id, "cancelled");
  }

  /** Continue an interrupted run from its persisted checkpoint. */
  async resume(id: string): Promise<Analysis> {
    const analysis = await this.get(id);
    if (analysis.state === "running") return analysis;
    return this.transition(id, "running", { error: null });
  }

  /** Enforce lifecycle transitions and publish persisted state. */
  private async transition(
    id: string,
    state: Analysis["state"],
    fields: Partial<Analysis> = {},
  ): Promise<Analysis> {
    const analysis = await this.get(id);
    if (!transitions[analysis.state].includes(state)) {
      throw new Error(`cannot transition ${analysis.state} to ${state}`);
    }
    const next = { ...analysis, ...fields, state };
    await this.store.save(next);
    const persisted = await this.get(id);
    await this.onChange?.(persisted);
    return persisted;
  }
}
