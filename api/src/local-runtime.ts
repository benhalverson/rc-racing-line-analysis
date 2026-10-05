import { Hono } from "hono";
import type { AnalysisRuntime, WorkflowInstanceHandle, TimingRuntime } from "./app";
import { createApp } from "./app";
import { errorMessage } from "./errors";
import type { LocalArtifactStore } from "./local-artifacts";
import type { LocalPersistence } from "./local-persistence";
import type { LocalVideoStore } from "./local-video-store";
import type { AnalysisWorkflow } from "./workflow";

type Execution = { controller: AbortController; promise: Promise<void> };

/** Composes the existing workflow routes with local video/artifact transport and execution. */
export function createLocalApp(workflow: AnalysisWorkflow, persistence: LocalPersistence, artifacts: LocalArtifactStore, videos: LocalVideoStore, execute: (id: string, signal: AbortSignal) => Promise<void>, timing?: TimingRuntime) {
  const executions = new Map<string, Execution>();
  /** Starts at most one local worker and waits for an interrupted predecessor to exit. */
  async function launch(id: string): Promise<void> {
    const active = executions.get(id);
    if (active && !active.controller.signal.aborted) return;
    if (active) await active.promise;
    const replacement = executions.get(id);
    if (replacement && !replacement.controller.signal.aborted) return;
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => execute(id, controller.signal)).catch(() => undefined).finally(() => {
      if (executions.get(id)?.controller === controller) executions.delete(id);
    });
    executions.set(id, { controller, promise });
  }
  /** Presents local execution through the existing AnalysisWorkflow runtime port. */
  function handle(id: string): WorkflowInstanceHandle {
    return {
      pause: async () => { const active = executions.get(id); active?.controller.abort(); await active?.promise; },
      resume: async () => { await launch(id); },
      restart: async () => { await launch(id); },
      status: async () => {
        const execution = executions.get(id);
        if (execution) return { status: execution.controller.signal.aborted ? "waitingForPause" : "running" };
        const run = await persistence.getRun(id);
        return { status: run?.status === "completed" || run?.status === "needs_correction" ? "complete" : run?.status === "failed" ? "errored" : run?.status === "cancelled" ? "paused" : "terminated" };
      },
    };
  }
  const runtime = { workflow: {
    create: async ({ id }: { id: string }) => { await launch(id); return handle(id); },
    get: async (id: string) => {
      if (!executions.has(id) && !(await persistence.getRun(id))) throw new Error("local processing run not found");
      return handle(id);
    },
  } } as unknown as AnalysisRuntime;
  const app = new Hono();
  app.use("*", async (c, next) => {
    const host = new URL(c.req.url).hostname;
    const origin = c.req.header("origin");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host) || (origin && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname))) return c.json({ error: "local runtime accepts loopback requests only" }, 403);
    await next();
  });
  app.get("/runtime", (c) => c.json({ mode: "local-node", videoImportPath: "/local-videos" }));
  app.post("/local-videos", async (c) => {
    try {
      if (!c.req.raw.body) return c.json({ error: "video stream is required" }, 400);
      return c.json(await videos.importStream(c.req.raw.body, { name: decodeURIComponent(c.req.header("x-video-name") ?? ""), mimeType: c.req.header("content-type") ?? "video/mp4", lastModified: Number(c.req.header("x-video-last-modified") ?? "0") }, c.req.header("x-video-id")), 201);
    } catch (error) { return c.json({ error: errorMessage(error) }, 400); }
  });
  app.get("/analyses/:id/artifacts", async (c) => {
    const id = c.req.param("id");
    try {
      await workflow.get(id);
      const output = await artifacts.readPublished(id);
      const transforms = output?.transforms ?? [];
      const unusableRegions: Array<{ startFrame: number; endFrame: number; reason: string }> = [];
      for (const transform of transforms) {
        if (transform.quality.usable) continue;
        const prior = unusableRegions.at(-1);
        if (prior && prior.endFrame + 1 === transform.frame) prior.endFrame = transform.frame;
        else unusableRegions.push({ startFrame: transform.frame, endFrame: transform.frame, reason: "stabilization quality rejected" });
      }
      return c.json({ run: await persistence.getRun(id), artifacts: await persistence.listArtifacts(id), stabilization: output ? { totalFrames: transforms.length, usableFrames: transforms.filter((item) => item.quality.usable).length, unusableRegions } : undefined });
    } catch (error) { return c.json({ error: errorMessage(error) }, 404); }
  });
  app.post("/analyses", async (c, next) => {
    try {
      const input = await c.req.json();
      if (input.videoStorage === "local-disk") await videos.assertExists(input.videoPath);
      await next();
    } catch (error) { return c.json({ error: errorMessage(error) }, 400); }
  });
  app.route("/", createApp(workflow, runtime, timing, { localVideo: true }));
  return app;
}
