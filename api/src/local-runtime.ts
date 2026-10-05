import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { AlternativeWorkflow } from './alternative-workflow';
import { ReviewWorkflow } from './review-workflow';
import { TrackingWorkflow } from "./tracking-workflow";
import { z } from "zod";
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
  const tracking = new TrackingWorkflow(workflow, persistence, artifacts);
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
      restart: async () => { const active = executions.get(id); active?.controller.abort(); await active?.promise; await launch(id); },
      status: async () => {
        const analysis = await workflow.get(id);
        if (analysis.state === "completed" || analysis.state === "needs_correction") return { status: "complete" };
        if (analysis.state === "failed") return { status: "errored" };
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
  app.get('/analyses', async c => {
    try { return c.json({ analyses: await workflow.listAnalyses() }); }
    catch (error) { return c.json({ error: errorMessage(error) }, 400); }
  });
  app.post('/analyses/:id/correction-sets/:versionId/accept', async c => {
    try {
      const id = c.req.param('id');
      if (executions.has(id)) throw new Error('Wait for the processing worker to stop before selecting corrections');
      const input = z.object({ updatedAt: z.string().datetime(), acceptedCorrectionSetId: z.string().min(1).nullable() }).strict().parse(await c.req.json());
      return c.json(await workflow.selectCorrectionSet(id, c.req.param('versionId'), input));
    } catch (error) { return c.json({ error: errorMessage(error) }, 400); }
  });
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


  for (const action of ["start", "resume"] as const) {
    app.post(`/analyses/:id/${action}`, async c => {
      const id = c.req.param("id");
      try {
        const prior = await workflow.get(id);
        if (executions.get(id)?.controller.signal.aborted) throw new Error("workflow instance cannot resume from waitingForPause");
        if (prior.state !== "running") {
          const active = executions.get(id); active?.controller.abort(); await active?.promise;
        }
        if (action === "start") await workflow.start(id); else await workflow.resume(id);
        await launch(id);
        return c.json(await workflow.get(id));
      } catch (error) { return c.json({ error: errorMessage(error) }, 400); }
    });
  }
  const review = new ReviewWorkflow(persistence, artifacts);
  app.get('/analyses/:id/review', async c => {
    try { return c.json(await review.get(c.req.param('id'))); }
    catch (error) { return c.json({ error: errorMessage(error) }, 404); }
  });
  app.post('/analyses/:id/review', async c => {
    try {
      const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
      const base = { version: z.number().int().nonnegative(), evidenceId: z.string().min(1), runId: z.string().min(1) };
      const input = z.discriminatedUnion('action', [
        z.object({ ...base, action: z.literal('gate'), line: z.object({ a: point, b: point }).strict() }).strict(),
        z.object({ ...base, action: z.literal('timing'), timingImportId: z.string().min(1) }).strict(),
        z.object({ ...base, action: z.literal('add'), seconds: z.number().finite() }).strict(),
        z.object({ ...base, action: z.literal('correct'), id: z.string().min(1), seconds: z.number().finite() }).strict(),
        z.object({ ...base, action: z.literal('remove'), id: z.string().min(1) }).strict(),
        z.object({ ...base, action: z.literal('assign'), id: z.string().min(1), lapNumber: z.number().int().positive().nullable() }).strict(),
      ]).parse(await c.req.json());
      return c.json(await review.edit(c.req.param('id'), input), 201);
    } catch (error) { return c.json({ error: errorMessage(error) }, 400); }
  });
  const alternatives = new AlternativeWorkflow(persistence, artifacts);
  app.get('/analyses/:id/alternatives', async c => {
    try { return c.json(await alternatives.get(c.req.param('id'))); }
    catch (error) { return c.json({ error: errorMessage(error) }, 404); }
  });
  app.post('/analyses/:id/alternatives', async c => {
    try {
      const input = z.object({
        runId: z.string().min(1), correctionSetId: z.string().min(1), evidenceId: z.string().min(1), trackReferenceId: z.string().min(1), reviewVersion: z.number().int().nonnegative(),
        alternativeId: z.string().uuid().nullable(), baseVersion: z.number().int().nonnegative(), name: z.string().max(100),
        points: z.array(z.object({ x: z.number().finite(), y: z.number().finite() }).strict()).min(2).max(10000),
      }).strict().parse(await c.req.json());
      return c.json(await alternatives.save(c.req.param('id'), input), 201);
    } catch (error) { return c.json({ error: errorMessage(error) }, 400); }
  });
  app.get('/analyses/:id/video', async c => {
    try {
      const analysis = await workflow.get(c.req.param('id'));
      if (analysis.videoStorage !== 'local-disk') throw new Error('Original local video is unavailable');
      const path = videos.resolvePath(analysis.videoPath); const info = await stat(path);
      const range = c.req.header('range');
      let start = 0; let end = info.size - 1;
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!match) return c.body(null, 416, { 'Content-Range': `bytes */${info.size}` });
        start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) return c.body(null, 416, { 'Content-Range': `bytes */${info.size}` });
      }
      const headers: Record<string, string> = { 'Content-Type': analysis.localVideoRef?.mimeType || 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Cache-Control': 'no-store' };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, { status: range ? 206 : 200, headers });
    } catch (error) { return c.json({ error: errorMessage(error) }, 404); }
  });
  app.get("/analyses/:id/tracking", async c => {
    try { return c.json({ tracking: await tracking.get(c.req.param("id")) }); }
    catch (error) { return c.json({ error: errorMessage(error) }, 404); }
  });
  app.post("/analyses/:id/tracking/rebox", async c => {
    try {
      const input = z.object({ frame: z.number().int().nonnegative(), box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).strict() }).strict().parse(await c.req.json());
      return c.json(await tracking.rebox(c.req.param("id"), input.frame, input.box), 201);
    } catch (error) { return c.json({ error: errorMessage(error) }, 400); }
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
