import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { InMemoryAnalysisStore } from "../src/store.js";
import { AnalysisWorkflow } from "../src/workflow.js";

function testApp() {
  return createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()));
}
describe("AnalysisWorkflow", () => {
  it("creates a local draft and carries it through a resumable batch lifecycle", () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = workflow.createDraft({
      videoPath: "/races/heat-1.mp4",
      videoName: "heat-1.mp4",
      carDescription: "blue buggy",
    });
    expect(draft.state).toBe("draft");
    workflow.queue(draft.id);
    workflow.start(draft.id);
    expect(
      workflow.report(draft.id, {
        phase: "tracking",
        progress: 0.4,
        checkpoint: "frame-240",
      }).checkpoint,
    ).toBe("frame-240");
    workflow.cancel(draft.id);
    expect(workflow.resume(draft.id).state).toBe("queued");
  });
  it("rejects invalid transitions and progress", () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = workflow.createDraft({
      videoPath: "/race.mp4",
      videoName: "race.mp4",
    });
    expect(() => workflow.cancel(draft.id)).toThrow(
      "cannot transition draft to cancelled",
    );
    workflow.queue(draft.id);
    workflow.start(draft.id);
    expect(() =>
      workflow.report(draft.id, { phase: "tracking", progress: 2 }),
    ).toThrow("progress must be between 0 and 1");
  });
});
describe("analysis API", () => {
  it("exposes health, draft creation, and lifecycle actions", async () => {
    const app = testApp();
    expect((await app.request("/health")).status).toBe(200);
    const created = await app.request("/analyses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoPath: "/race.mp4", videoName: "race.mp4" }),
    });
    expect(created.status).toBe(201);
    const analysis = (await created.json()) as { id: string };
    const queued = await app.request(`/analyses/${analysis.id}/queue`, {
      method: "POST",
    });
    expect((await queued.json()).state).toBe("queued");
  });
});
