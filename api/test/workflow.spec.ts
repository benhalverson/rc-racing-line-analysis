import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { InMemoryAnalysisStore } from "../src/store";
import { AnalysisWorkflow } from "../src/workflow";

function testApp() { return createApp(new AnalysisWorkflow(new InMemoryAnalysisStore())); }

const correctionPayload = {
  raceStartSeconds: 1,
  markerReferenceSeconds: 2,
  carSelectionSeconds: 3,
  markers: [{ id: "m1", position: { x: 0.2, y: 0.3 }, source: "detected" as const }],
  selectedCarBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
};

async function prepareQueued(workflow: AnalysisWorkflow, draft: { id: string }) {
  await workflow.startCalibration(draft.id);
  await workflow.createAndAcceptCorrectionSet(draft.id, correctionPayload);
  await workflow.queue(draft.id);
}

describe("AnalysisWorkflow", () => {
  it("creates a local draft and carries it through a resumable batch lifecycle", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/races/heat-1.mp4", videoName: "heat-1.mp4", carDescription: "blue buggy" });
    expect(draft.state).toBe("draft");
    await prepareQueued(workflow, draft);
    await workflow.start(draft.id);
    expect((await workflow.report(draft.id, { phase: "tracking", progress: 0.4, checkpoint: "frame-240" })).checkpoint).toBe("frame-240");
    await workflow.cancel(draft.id);
    expect((await workflow.resume(draft.id)).state).toBe("running");
  });

  it("advances a started batch through checkpoints to completed", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/race.mp4", videoName: "race.mp4" });
    await prepareQueued(workflow, draft);
    await workflow.start(draft.id);
    await workflow.report(draft.id, { phase: "calibrating", progress: 0.25, checkpoint: "calibration-complete" });
    await workflow.report(draft.id, { phase: "tracking", progress: 0.5, checkpoint: "tracking-halfway" });
    await workflow.report(draft.id, { phase: "review", progress: 0.75, checkpoint: "review-ready" });
    await workflow.complete(draft.id);
    const completed = await workflow.get(draft.id);
    expect(completed).toMatchObject({ state: "completed", phase: "review", progress: 1, checkpoint: "completed" });
  });

  it("rejects invalid transitions and progress", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/race.mp4", videoName: "race.mp4" });
    await expect(workflow.cancel(draft.id)).rejects.toThrow("cannot transition draft to cancelled");
    await expect(workflow.queue(draft.id)).rejects.toThrow("cannot transition draft to queued");
    await prepareQueued(workflow, draft);
    await workflow.start(draft.id);
    await expect(workflow.report(draft.id, { phase: "tracking", progress: 2 })).rejects.toThrow("progress must be between 0 and 1");
  });
});

describe("analysis API", () => {
  it("starts calibration and accepts a versioned correction set without video bytes", async () => {
    const app = testApp();
    const created = await app.request("/analyses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoPath: "browser-sqlite://video-1", videoName: "race.mp4", videoStorage: "browser-sqlite", localVideoRef: { id: "video-1", name: "race.mp4", mimeType: "video/mp4", size: 10, lastModified: 1 } }) });
    const analysis = (await created.json()) as { id: string };
    const started = await app.request(`/analyses/${analysis.id}/calibration/start`, { method: "POST" });
    expect((await started.json() as { state: string }).state).toBe("awaiting_calibration");
    const startedAgain = await app.request(`/analyses/${analysis.id}/calibration/start`, { method: "POST" });
    expect(startedAgain.status).toBe(200);
    expect((await startedAgain.json() as { state: string }).state).toBe("awaiting_calibration");
    const response = await app.request(`/analyses/${analysis.id}/correction-sets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raceStartSeconds: 1, markerReferenceSeconds: 2, carSelectionSeconds: 3, markers: [{ id: "m1", position: { x: 0.2, y: 0.3 }, source: "detected" }], selectedCarBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }) });
    expect(response.status).toBe(201);
    expect((await response.json() as { version: number }).version).toBe(1);
    expect((await (await app.request(`/analyses/${analysis.id}`)).json() as { state: string }).state).toBe("ready");
  });

  it("rejects correction sets after calibration has been accepted", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "browser-sqlite://video-1", videoName: "race.mp4" });
    await workflow.startCalibration(draft.id);
    await workflow.createAndAcceptCorrectionSet(draft.id, correctionPayload);
    await expect(workflow.createAndAcceptCorrectionSet(draft.id, correctionPayload)).rejects.toThrow(
      "correction sets can only be accepted while awaiting calibration, not ready",
    );
  });

  it("rejects correction boxes outside normalized frame coordinates", async () => {
    const app = testApp();
    const created = await app.request("/analyses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoPath: "browser-sqlite://video-1", videoName: "race.mp4" }) });
    const analysis = (await created.json()) as { id: string };
    const response = await app.request(`/analyses/${analysis.id}/correction-sets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raceStartSeconds: 1, markerReferenceSeconds: 2, carSelectionSeconds: 3, markers: [{ id: "m1", position: { x: 2, y: 0.3 }, source: "manual" }], selectedCarBox: { x: 0, y: 0, width: 2, height: 1 } }) });
    expect(response.status).toBe(400);
  });

  it("exposes health, draft creation, and lifecycle actions", async () => {
    const app = testApp();
    expect((await app.request("/health")).status).toBe(200);
    const created = await app.request("/analyses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoPath: "/race.mp4", videoName: "race.mp4" }) });
    expect(created.status).toBe(201);
    const analysis = (await created.json()) as { id: string };
    const queued = await app.request(`/analyses/${analysis.id}/queue`, { method: "POST" });
    expect(queued.status).toBe(400);
  });

  it("cancels when the Workflow is still queued", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/race.mp4", videoName: "race.mp4" });
    await prepareQueued(workflow, draft);
    await workflow.start(draft.id);
    let pauseCalls = 0;
    const runtime = {
      workflow: {
        get: async () => ({
          status: async () => ({ status: "queued" }),
          pause: async () => { pauseCalls += 1; throw new Error("queued instances cannot be paused"); },
          resume: async () => undefined,
          restart: async () => undefined,
        }),
        create: async () => ({
          status: async () => ({ status: "queued" }),
          pause: async () => undefined,
          resume: async () => undefined,
          restart: async () => undefined,
        }),
      },
      room: {} as never,
    };
    const response = await createApp(workflow, runtime).request(`/analyses/${draft.id}/cancel`, { method: "POST" });
    expect(response.status).toBe(200);
    expect((await response.json() as { state: string }).state).toBe("cancelled");
    expect(pauseCalls).toBe(0);
  });

  it("persists running state before creating a Workflow instance", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/race.mp4", videoName: "race.mp4" });
    await prepareQueued(workflow, draft);
    let stateWhenCreated: string | undefined;
    let createCalls = 0;
    const runtime = {
      workflow: {
        get: async () => { throw new Error("missing instance"); },
        create: async () => {
          createCalls += 1;
          stateWhenCreated = (await workflow.get(draft.id)).state;
          return { status: async () => ({ status: "running" }), pause: async () => undefined, resume: async () => undefined, restart: async () => undefined };
        },
      },
      room: {} as never,
    };

    const response = await createApp(workflow, runtime).request(`/analyses/${draft.id}/start`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(createCalls).toBe(1);
    expect(stateWhenCreated).toBe("running");
  });

  it("resumes a paused Workflow when starting a queued analysis", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/race.mp4", videoName: "race.mp4" });
    await prepareQueued(workflow, draft);
    await workflow.start(draft.id);
    await workflow.cancel(draft.id);
    await workflow.queue(draft.id);
    let stateWhenResumed: string | undefined;
    const runtime = {
      workflow: {
        get: async () => ({
          status: async () => ({ status: "paused" }),
          pause: async () => undefined,
          resume: async () => { stateWhenResumed = (await workflow.get(draft.id)).state; },
          restart: async () => undefined,
        }),
        create: async () => { throw new Error("not expected"); },
      },
      room: {} as never,
    };

    const response = await createApp(workflow, runtime).request(`/analyses/${draft.id}/start`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(stateWhenResumed).toBe("running");
  });

  it("restarts a terminal Workflow when starting a queued analysis", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/race.mp4", videoName: "race.mp4" });
    await prepareQueued(workflow, draft);
    await workflow.start(draft.id);
    await workflow.cancel(draft.id);
    await workflow.queue(draft.id);
    let stateWhenRestarted: string | undefined;
    const runtime = {
      workflow: {
        get: async () => ({
          status: async () => ({ status: "complete" }),
          pause: async () => undefined,
          resume: async () => undefined,
          restart: async () => { stateWhenRestarted = (await workflow.get(draft.id)).state; },
        }),
        create: async () => { throw new Error("not expected"); },
      },
      room: {} as never,
    };

    const response = await createApp(workflow, runtime).request(`/analyses/${draft.id}/start`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(stateWhenRestarted).toBe("running");
  });

  it("does not create a Workflow instance for an invalid start", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    let createCalls = 0;
    const runtime = {
      workflow: {
        get: async () => { throw new Error("missing instance"); },
        create: async () => {
          createCalls += 1;
          return { status: async () => ({ status: "queued" }), pause: async () => undefined, resume: async () => undefined, restart: async () => undefined };
        },
      },
      room: {} as never,
    };

    const response = await createApp(workflow, runtime).request("/analyses/missing/start", { method: "POST" });

    expect(response.status).toBe(400);
    expect(createCalls).toBe(0);
  });

  it("pauses a running Workflow before marking the analysis cancelled", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/race.mp4", videoName: "race.mp4" });
    await prepareQueued(workflow, draft);
    await workflow.start(draft.id);
    let stateWhenPaused: string | undefined;
    const runtime = {
      workflow: {
        get: async () => ({
          status: async () => ({ status: "running" }),
          pause: async () => { stateWhenPaused = (await workflow.get(draft.id)).state; },
          resume: async () => undefined,
          restart: async () => undefined,
        }),
        create: async () => { throw new Error("not expected"); },
      },
      room: {} as never,
    };

    const response = await createApp(workflow, runtime).request(`/analyses/${draft.id}/cancel`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(stateWhenPaused).toBe("running");
    expect((await response.json() as { state: string }).state).toBe("cancelled");
  });

  it("marks the analysis running before resuming a paused Workflow", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/race.mp4", videoName: "race.mp4" });
    await prepareQueued(workflow, draft);
    await workflow.start(draft.id);
    await workflow.cancel(draft.id);
    let stateWhenResumed: string | undefined;
    const runtime = {
      workflow: {
        get: async () => ({
          status: async () => ({ status: "paused" }),
          pause: async () => undefined,
          resume: async () => { stateWhenResumed = (await workflow.get(draft.id)).state; },
          restart: async () => undefined,
        }),
        create: async () => { throw new Error("not expected"); },
      },
      room: {} as never,
    };

    const response = await createApp(workflow, runtime).request(`/analyses/${draft.id}/resume`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(stateWhenResumed).toBe("running");
    expect((await response.json() as { state: string }).state).toBe("running");
  });

  it("pauses a Workflow that is waiting between durable steps", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/race.mp4", videoName: "race.mp4" });
    await prepareQueued(workflow, draft);
    await workflow.start(draft.id);
    let pauseCalls = 0;
    const runtime = {
      workflow: {
        get: async () => ({
          status: async () => ({ status: "waiting" }),
          pause: async () => { pauseCalls += 1; },
          resume: async () => undefined,
          restart: async () => undefined,
        }),
        create: async () => { throw new Error("not expected"); },
      },
      room: {} as never,
    };

    const response = await createApp(workflow, runtime).request(`/analyses/${draft.id}/cancel`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(pauseCalls).toBe(1);
  });

  it("does not issue a second pause while a Workflow is waiting for pause", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/race.mp4", videoName: "race.mp4" });
    await prepareQueued(workflow, draft);
    await workflow.start(draft.id);
    let pauseCalls = 0;
    const runtime = {
      workflow: {
        get: async () => ({
          status: async () => ({ status: "waitingForPause" }),
          pause: async () => { pauseCalls += 1; throw new Error("pause already requested"); },
          resume: async () => undefined,
          restart: async () => undefined,
        }),
        create: async () => { throw new Error("not expected"); },
      },
      room: {} as never,
    };

    const response = await createApp(workflow, runtime).request(`/analyses/${draft.id}/cancel`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(pauseCalls).toBe(0);
    expect((await response.json() as { state: string }).state).toBe("cancelled");
  });

  it("restarts a terminal Workflow instance when resuming a cancelled analysis", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/race.mp4", videoName: "race.mp4" });
    await prepareQueued(workflow, draft);
    await workflow.start(draft.id);
    await workflow.cancel(draft.id);
    let stateWhenRestarted: string | undefined;
    const runtime = {
      workflow: {
        get: async () => ({
          status: async () => ({ status: "complete" }),
          pause: async () => undefined,
          resume: async () => undefined,
          restart: async () => { stateWhenRestarted = (await workflow.get(draft.id)).state; },
        }),
        create: async () => { throw new Error("not expected"); },
      },
      room: {} as never,
    };

    const response = await createApp(workflow, runtime).request(`/analyses/${draft.id}/resume`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(stateWhenRestarted).toBe("running");
    expect((await response.json() as { state: string }).state).toBe("running");
  });

  it("creates a Workflow when resuming a cancelled analysis that was never started", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/race.mp4", videoName: "race.mp4" });
    await prepareQueued(workflow, draft);
    await workflow.cancel(draft.id);
    let stateWhenCreated: string | undefined;
    const runtime = {
      workflow: {
        get: async () => { throw new Error("missing instance"); },
        create: async () => {
          stateWhenCreated = (await workflow.get(draft.id)).state;
          return { status: async () => ({ status: "queued" }), pause: async () => undefined, resume: async () => undefined, restart: async () => undefined };
        },
      },
      room: {} as never,
    };

    const response = await createApp(workflow, runtime).request(`/analyses/${draft.id}/resume`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(stateWhenCreated).toBe("running");
  });

  it("publishes a snapshot before upgrading the analysis WebSocket", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/race.mp4", videoName: "race.mp4" });
    const calls: string[] = [];
    const room = {
      seed: async (_analysis: unknown) => { calls.push("seed"); },
      fetch: async (_request: Request) => { calls.push("fetch"); return new Response(null, { status: 200 }); },
    };
    const runtime = {
      workflow: {
        get: async () => { throw new Error("not expected"); },
        create: async () => { throw new Error("not expected"); },
      },
      room: { getByName: () => room } as never,
    };

    const response = await createApp(workflow, runtime).request(`/analyses/${draft.id}/ws`, {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["seed", "fetch"]);
  });
});
