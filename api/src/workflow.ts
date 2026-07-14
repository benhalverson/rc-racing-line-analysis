import type { Analysis, AnalysisStore, CreateAnalysisInput } from "./domain.js";

const transitions: Record<Analysis["state"], Analysis["state"][]> = {
  draft: ["queued"],
  queued: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: ["queued"],
  failed: ["queued"],
  cancelled: ["queued"],
};

export class AnalysisWorkflow {
  constructor(private readonly store: AnalysisStore) {}

  createDraft(input: CreateAnalysisInput): Analysis {
    if (!input.videoPath.trim() || !input.videoName.trim())
      throw new Error("videoPath and videoName are required");
    return this.store.createDraft(input);
  }

  get(id: string): Analysis {
    const analysis = this.store.get(id);
    if (!analysis) throw new Error("analysis not found");
    return analysis;
  }

  queue(id: string): Analysis {
    return this.transition(id, "queued");
  }
  start(id: string): Analysis {
    return this.transition(id, "running", {
      phase: "calibrating",
      checkpoint: "queued",
    });
  }
  report(
    id: string,
    update: { phase: Analysis["phase"]; progress: number; checkpoint?: string },
  ): Analysis {
    const analysis = this.get(id);
    if (analysis.state !== "running")
      throw new Error("only running analyses can report progress");
    if (update.progress < 0 || update.progress > 1)
      throw new Error("progress must be between 0 and 1");
    const next = {
      ...analysis,
      phase: update.phase,
      progress: update.progress,
      checkpoint: update.checkpoint ?? analysis.checkpoint,
    };
    this.store.save(next);
    return this.get(id);
  }
  complete(id: string): Analysis {
    return this.transition(id, "completed", { phase: "review", progress: 1 });
  }
  fail(id: string, error: string): Analysis {
    return this.transition(id, "failed", { error });
  }
  cancel(id: string): Analysis {
    return this.transition(id, "cancelled");
  }
  resume(id: string): Analysis {
    return this.transition(id, "queued", { error: null });
  }

  private transition(
    id: string,
    state: Analysis["state"],
    fields: Partial<Analysis> = {},
  ): Analysis {
    const analysis = this.get(id);
    if (!transitions[analysis.state].includes(state))
      throw new Error(`cannot transition ${analysis.state} to ${state}`);
    this.store.save({ ...analysis, ...fields, state });
    return this.get(id);
  }
}
