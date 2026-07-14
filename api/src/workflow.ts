import type { Analysis, AnalysisStore, BoundingBox, CreateAnalysisInput, CreateFrameObservationInput, FrameObservation, TrackSegment } from "./domain";

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
    if (input.initialBox) validateBox(input.initialBox);
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

  async recordFrameObservation(id: string, input: Omit<CreateFrameObservationInput, "analysisId">): Promise<FrameObservation> {
    await this.get(id);
    const segment = (await this.store.listTrackSegments(id)).find(({ id: segmentId }) => segmentId === input.segmentId);
    if (!segment) throw new Error("track segment not found");
    validateObservation(input);
    const observation = await this.store.createFrameObservation({ ...input, analysisId: id });
    await this.saveCheckpoint(id, `tracking-frame-${input.frameNumber}`);
    return observation;
  }

  async rebox(id: string, input: Omit<CreateFrameObservationInput, "analysisId" | "segmentId" | "quality" | "box"> & { box: BoundingBox }): Promise<{ segment: TrackSegment; observation: FrameObservation }> {
    await this.get(id);
    const observations = await this.store.listFrameObservations(id);
    if (observations.at(-1)?.quality !== "lost") throw new Error("re-boxing requires a lost observation");
    validateObservation({ ...input, segmentId: "", quality: "reacquired" });
    const segment = await this.store.createTrackSegment({ analysisId: id, startFrame: input.frameNumber, initialBox: input.box });
    const observation = await this.store.createFrameObservation({ ...input, analysisId: id, segmentId: segment.id, quality: "reacquired" });
    await this.saveCheckpoint(id, `tracking-frame-${input.frameNumber}`);
    return { segment, observation };
  }

  async tracking(id: string): Promise<{ segments: TrackSegment[]; observations: FrameObservation[] }> {
    await this.get(id);
    return { segments: await this.store.listTrackSegments(id), observations: await this.store.listFrameObservations(id) };
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

  private async saveCheckpoint(id: string, checkpoint: string): Promise<void> {
    const analysis = await this.get(id);
    await this.store.save({ ...analysis, phase: "tracking", checkpoint });
    await this.onChange?.(await this.get(id));
  }
}

function validateBox(box: BoundingBox) {
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) {
    throw new Error("box must have finite coordinates and positive dimensions");
  }
}

function validateObservation(input: Omit<CreateFrameObservationInput, "analysisId">) {
  if (!Number.isInteger(input.frameNumber) || input.frameNumber < 0 || !Number.isInteger(input.timestampMs) || input.timestampMs < 0) {
    throw new Error("frameNumber and timestampMs must be non-negative integers");
  }
  if (input.quality === "lost") {
    if (input.box) throw new Error("lost observations cannot include a box");
  } else if (!input.box) {
    throw new Error(`${input.quality} observations require a box`);
  } else {
    validateBox(input.box);
  }
  validateArtifactPaths(input);
}

function validateArtifactPaths(input: Pick<CreateFrameObservationInput, "observationFilePath" | "qualityArtifactPath">) {
  for (const path of [input.observationFilePath, input.qualityArtifactPath]) {
    try {
      const url = new URL(path);
      if (
        !["file:", "local:"].includes(url.protocol) ||
        !url.pathname ||
        /(?:^|[/\\])(?:\.\.|%2e%2e)(?:[/\\]|$)/i.test(path)
      ) {
        throw new Error();
      }
    } catch {
      throw new Error("artifact paths must reference local files");
    }
  }
}
