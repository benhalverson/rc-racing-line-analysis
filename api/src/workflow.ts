import type { Analysis, AnalysisStore, CreateAnalysisInput } from "./domain";

const transitions: Record<Analysis["state"], Analysis["state"][]> = {
  draft: ["queued"],
  queued: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: ["queued"],
  failed: ["queued"],
  cancelled: ["queued", "running"],
};

type ProgressUpdate = {
  phase: Analysis["phase"];
  progress: number;
  checkpoint?: string;
};

export class AnalysisWorkflow {
  constructor(
    private readonly store: AnalysisStore,
    private readonly onChange?: (analysis: Analysis) => Promise<void> | void,
  ) {}

  async createDraft(input: CreateAnalysisInput): Promise<Analysis> {
    if (!input.videoPath.trim() || !input.videoName.trim()) {
      throw new Error("videoPath and videoName are required");
    }
    const analysis = await this.store.createDraft(input);
    await this.onChange?.(analysis);
    return analysis;
  }

  async get(id: string): Promise<Analysis> {
    const analysis = await this.store.get(id);
    if (!analysis) throw new Error("analysis not found");
    return analysis;
  }

  async queue(id: string): Promise<Analysis> {
    return this.transition(id, "queued", { error: null });
  }

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

  async report(id: string, update: ProgressUpdate): Promise<Analysis> {
    const analysis = await this.get(id);
    if (analysis.state !== "running") {
      throw new Error("only running analyses can report progress");
    }
    if (update.progress < 0 || update.progress > 1) {
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

  async complete(id: string): Promise<Analysis> {
    return this.transition(id, "completed", {
      phase: "review",
      progress: 1,
      checkpoint: "completed",
    });
  }

  async fail(id: string, error: string): Promise<Analysis> {
    return this.transition(id, "failed", { error });
  }

  async cancel(id: string): Promise<Analysis> {
    const analysis = await this.get(id);
    if (analysis.state === "cancelled") return analysis;
    return this.transition(id, "cancelled");
  }

  async resume(id: string): Promise<Analysis> {
    const analysis = await this.get(id);
    if (analysis.state === "running") return analysis;
    return this.transition(id, "running", { error: null });
  }

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
