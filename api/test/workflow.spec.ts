import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { InMemoryAnalysisStore } from "../src/store";
import { AnalysisWorkflow } from "../src/workflow";

function testApp() { return createApp(new AnalysisWorkflow(new InMemoryAnalysisStore())); }

describe("AnalysisWorkflow", () => {
  it("creates a local draft and carries it through a resumable batch lifecycle", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/races/heat-1.mp4", videoName: "heat-1.mp4", carDescription: "blue buggy" });
    expect(draft.state).toBe("draft");
    await workflow.queue(draft.id);
    await workflow.start(draft.id);
    expect((await workflow.report(draft.id, { phase: "tracking", progress: 0.4, checkpoint: "frame-240" })).checkpoint).toBe("frame-240");
    await workflow.cancel(draft.id);
    expect((await workflow.resume(draft.id)).state).toBe("running");
  });

  it("advances a started batch through checkpoints to completed", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/race.mp4", videoName: "race.mp4" });
    await workflow.queue(draft.id);
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
    await workflow.queue(draft.id);
    await workflow.start(draft.id);
    await expect(workflow.report(draft.id, { phase: "tracking", progress: 2 })).rejects.toThrow("progress must be between 0 and 1");
  });
});

describe("analysis API", () => {
  it("exposes health, draft creation, and lifecycle actions", async () => {
    const app = testApp();
    expect((await app.request("/health")).status).toBe(200);
    const created = await app.request("/analyses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoPath: "/race.mp4", videoName: "race.mp4", initialBox: { x: 1, y: 2, width: 3, height: 4 } }) });
    expect(created.status).toBe(201);
    const analysis = (await created.json()) as { id: string };
    const queued = await app.request(`/analyses/${analysis.id}/queue`, { method: "POST" });
    expect(((await queued.json()) as { state: string }).state).toBe("queued");
  });

  it("cancels when the Workflow is still queued", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({ videoPath: "/race.mp4", videoName: "race.mp4" });
    await workflow.queue(draft.id);
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
    await workflow.queue(draft.id);
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
    await workflow.queue(draft.id);
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
    await workflow.queue(draft.id);
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
    await workflow.queue(draft.id);
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
    await workflow.queue(draft.id);
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
    await workflow.queue(draft.id);
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
    await workflow.queue(draft.id);
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
    await workflow.queue(draft.id);
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
    await workflow.queue(draft.id);
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

  it("preserves lost observations and creates a new segment when the user re-boxes", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({
      videoPath: "/race.mp4",
      videoName: "race.mp4",
      initialBox: { x: 10, y: 20, width: 30, height: 40 },
    });
    const [initialSegment] = (await workflow.tracking(draft.id)).segments;
    await workflow.recordFrameObservation(draft.id, {
      segmentId: initialSegment.id,
      frameNumber: 10,
      timestampMs: 400,
      quality: "tracked",
      box: { x: 11, y: 20, width: 30, height: 40 },
      observationFilePath: "local://race/frames/10.json",
      qualityArtifactPath: "local://race/quality/10.json",
    });
    await workflow.recordFrameObservation(draft.id, {
      segmentId: initialSegment.id,
      frameNumber: 11,
      timestampMs: 440,
      quality: "lost",
      observationFilePath: "local://race/frames/11.json",
      qualityArtifactPath: "local://race/quality/11.json",
    });

    const recovered = await workflow.rebox(draft.id, {
      frameNumber: 12,
      timestampMs: 480,
      box: { x: 100, y: 200, width: 30, height: 40 },
      observationFilePath: "local://race/frames/12.json",
      qualityArtifactPath: "local://race/quality/12.json",
    });
    const tracking = await workflow.tracking(draft.id);

    expect(recovered.observation.quality).toBe("reacquired");
    expect(tracking.segments).toHaveLength(2);
    expect(tracking.observations.map(({ quality }) => quality)).toEqual(["tracked", "lost", "reacquired"]);
    expect(tracking.observations[1].box).toBeNull();
    expect((await workflow.get(draft.id)).checkpoint).toBe("tracking-frame-12");
  });

  it("requires local quality artifacts and a lost observation before re-boxing", async () => {
    const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());
    const draft = await workflow.createDraft({
      videoPath: "/race.mp4",
      videoName: "race.mp4",
      initialBox: { x: 10, y: 20, width: 30, height: 40 },
    });
    const [segment] = (await workflow.tracking(draft.id)).segments;

    await expect(workflow.recordFrameObservation(draft.id, {
      segmentId: segment.id,
      frameNumber: 1,
      timestampMs: 40,
      quality: "tracked",
      box: { x: 10, y: 20, width: 30, height: 40 },
      observationFilePath: "https://example.test/frame.json",
      qualityArtifactPath: "local://race/quality/1.json",
    })).rejects.toThrow("artifact paths must reference local files");
    await expect(workflow.recordFrameObservation(draft.id, {
      segmentId: segment.id,
      frameNumber: 1,
      timestampMs: 40,
      quality: "tracked",
      box: { x: 10, y: 20, width: 30, height: 40 },
      observationFilePath: "local://race/frames/../outside.json",
      qualityArtifactPath: "local://race/quality/1.json",
    })).rejects.toThrow("artifact paths must reference local files");
    await expect(workflow.rebox(draft.id, {
      frameNumber: 2,
      timestampMs: 80,
      box: { x: 10, y: 20, width: 30, height: 40 },
      observationFilePath: "local://race/frames/2.json",
      qualityArtifactPath: "local://race/quality/2.json",
    })).rejects.toThrow("re-boxing requires a lost observation");
  });

  it("exposes tracking observations and rejects boxes with remote artifacts", async () => {
    const app = testApp();
    const created = await app.request("/analyses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoPath: "/race.mp4", videoName: "race.mp4", initialBox: { x: 1, y: 2, width: 3, height: 4 } }),
    });
    const analysis = await created.json() as { id: string };
    const tracking = await app.request(`/analyses/${analysis.id}/tracking`);
    const [{ id: segmentId }] = (await tracking.json() as { segments: { id: string }[] }).segments;
    const rejected = await app.request(`/analyses/${analysis.id}/tracking/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        segmentId,
        frameNumber: 1,
        timestampMs: 40,
        quality: "tracked",
        box: { x: 1, y: 2, width: 3, height: 4 },
        observationFilePath: "https://example.test/frame.json",
        qualityArtifactPath: "local://race/quality/1.json",
      }),
    });

    expect(tracking.status).toBe(200);
    expect(rejected.status).toBe(400);
  });
});
