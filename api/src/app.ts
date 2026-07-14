import { Hono } from "hono";
import { z } from "zod";
import { errorMessage } from "./errors.js";
import type { AnalysisProgressRoom } from "./progress-room.js";
import type { AnalysisWorkflow } from "./workflow.js";
import { importTiming, parseDrivers, parseEvents, parseRaces, parseTrackList, type TimingFetcher, type TimingStore } from "./timing";

export interface AnalysisRuntime {
  workflow: {
    create(options: { id: string; params: { analysisId: string } }): Promise<WorkflowInstanceHandle>;
    get(id: string): Promise<WorkflowInstanceHandle>;
  };
  room: DurableObjectNamespace<AnalysisProgressRoom>;
}

export interface WorkflowInstanceHandle {
  pause(): Promise<void>;
  resume(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<{ status: string }>;
}

type WorkflowStatus =
  | "queued"
  | "running"
  | "paused"
  | "waiting"
  | "waitingForPause"
  | "complete"
  | "errored"
  | "terminated"
  | "unknown";

function isWorkflowStatus(status: string): status is WorkflowStatus {
  switch (status) {
    case "queued":
    case "running":
    case "paused":
    case "waiting":
    case "waitingForPause":
    case "complete":
    case "errored":
    case "terminated":
    case "unknown":
      return true;
    default:
      return false;
  }
}

async function workflowStatus(instance: WorkflowInstanceHandle): Promise<WorkflowStatus> {
  const status = (await instance.status()).status;
  if (!isWorkflowStatus(status)) throw new Error(`unknown workflow instance status: ${status}`);
  return status;
}

const createAnalysis = z.object({
  videoPath: z.string().trim().min(1),
  videoName: z.string().trim().min(1),
  carDescription: z.string().trim().optional(),
});
export type TimingRuntime = { fetch: TimingFetcher; store: TimingStore };

export function createApp(workflow: AnalysisWorkflow, runtime?: AnalysisRuntime, timing?: TimingRuntime) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/timing/tracks", async (c) => {
    if (!timing) return c.json({ error: "timing import is unavailable" }, 503);
    const page = await timing.fetch("https://live.liverc.com/");
    if (page.status < 200 || page.status >= 300) return c.json({ error: `LiveRC returned HTTP ${page.status}` }, 502);
    const query = c.req.query("query")?.trim().toLowerCase();
    const tracks = parseTrackList(page.html, page.url).filter((track) => !query || `${track.name} ${track.host}`.toLowerCase().includes(query));
    return c.json({ tracks });
  });
  app.get("/timing/events", async (c) => {
    if (!timing) return c.json({ error: "timing import is unavailable" }, 503);
    try {
      const page = await timing.fetch(requiredQuery(c, "trackUrl"));
      if (page.status < 200 || page.status >= 300) return c.json({ error: `LiveRC returned HTTP ${page.status}` }, 502);
      return c.json({ events: parseEvents(page.html, page.url) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "unable to read LiveRC events" }, 400);
    }
  });
  app.get("/timing/races", async (c) => {
    if (!timing) return c.json({ error: "timing import is unavailable" }, 503);
    try {
      const page = await timing.fetch(requiredQuery(c, "eventUrl"));
      if (page.status < 200 || page.status >= 300) return c.json({ error: `LiveRC returned HTTP ${page.status}` }, 502);
      return c.json({ races: parseRaces(page.html, page.url) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "unable to read LiveRC races" }, 400);
    }
  });
  app.get("/timing/drivers", async (c) => {
    if (!timing) return c.json({ error: "timing import is unavailable" }, 503);
    try {
      const page = await timing.fetch(requiredQuery(c, "raceUrl"));
      if (page.status < 200 || page.status >= 300) return c.json({ error: `LiveRC returned HTTP ${page.status}` }, 502);
      return c.json({ drivers: parseDrivers(page.html) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "unable to read LiveRC drivers" }, 400);
    }
  });
  app.post("/timing/imports", async (c) => {
    if (!timing) return c.json({ error: "timing import is unavailable" }, 503);
    try {
      const body = await c.req.json();
      const required = ["trackHost", "trackName", "trackUrl", "eventName", "eventUrl", "raceLabel", "roundLabel", "classLabel", "raceUrl", "driverName"];
      if (required.some((key) => typeof body[key] !== "string" || !body[key].trim())) return c.json({ error: "all selected track, event, race, and driver fields are required" }, 400);
      const value = await importTiming(body, timing.fetch, timing.store);
      return c.json(value, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "unable to import LiveRC timing" }, 400);
    }
  });
  app.get("/timing/imports/:id", async (c) => {
    if (!timing) return c.json({ error: "timing import is unavailable" }, 503);
    const value = await timing.store.getTimingImport(c.req.param("id"));
    return value ? c.json(value) : c.json({ error: "timing import not found" }, 404);
  });
  app.post("/analyses", async (c) => {
    const parsed = createAnalysis.safeParse(await c.req.json());
    if (!parsed.success)
      return c.json({ error: "videoPath and videoName are required" }, 400);
    return c.json(await workflow.createDraft(parsed.data), 201);
  });
  app.get("/analyses/:id", (c) =>
    result(c, () => workflow.get(c.req.param("id")), 404),
  );
  app.post("/analyses/:id/queue", (c) =>
    result(c, () => workflow.queue(c.req.param("id"))),
  );
  app.post("/analyses/:id/start", async (c) => {
    try {
      const id = c.req.param("id");
      await workflow.start(id);
      try {
        const instance = await getOrCreateInstance(runtime, id);
        if (instance) {
          const status = await workflowStatus(instance);
          if (status === "paused") {
            await instance.resume();
          } else if (status === "complete" || status === "errored" || status === "terminated") {
            await instance.restart();
          } else if (status === "unknown" || status === "waitingForPause") {
            throw new Error(`workflow instance cannot start from ${status}`);
          }
        }
      } catch (error) {
        await workflow.fail(id, `unable to start processing: ${errorMessage(error)}`);
        throw error;
      }
      return c.json(await workflow.get(id));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });
  app.post("/analyses/:id/cancel", async (c) => {
    try {
      const id = c.req.param("id");
      if (runtime) {
        const instance = await getExistingInstance(runtime, id);
        if (instance) {
          const status = await workflowStatus(instance);
          if (status === "running" || status === "waiting") await instance.pause();
        }
      }
      return c.json(await workflow.cancel(id));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });
  app.post("/analyses/:id/resume", async (c) => {
    try {
      const id = c.req.param("id");
      let instance: WorkflowInstanceHandle | undefined;
      let status: WorkflowStatus | undefined;
      if (runtime) {
        instance = await getExistingInstance(runtime, id);
        status = instance ? await workflowStatus(instance) : undefined;
        if (["unknown", "waitingForPause"].includes(status ?? "")) {
          throw new Error(`workflow instance cannot resume from ${status}`);
        }
      }
      const analysis = await workflow.resume(id);
      if (instance && status === "paused") {
        await instance.resume();
      } else if (instance && ["complete", "errored", "terminated"].includes(status ?? "")) {
        await instance.restart();
      } else if (!instance) {
        await getOrCreateInstance(runtime, id);
      }
      return c.json(analysis);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });
  app.get("/analyses/:id/ws", async (c) => {
    if (!runtime) return c.json({ error: "live analysis updates are unavailable" }, 503);
    try {
      const id = c.req.param("id");
      const room = runtime.room.getByName(id);
      await room.seed(await workflow.get(id));
      return room.fetch(c.req.raw);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 404);
    }
  });
  return app;
}

function requiredQuery(c: { req: { query: (name: string) => string | undefined } }, name: string) {
  const value = c.req.query(name);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

async function getOrCreateInstance(runtime: AnalysisRuntime | undefined, id: string) {
  if (!runtime) return undefined;
  try {
    return await runtime.workflow.get(id);
  } catch {
    try {
      return await runtime.workflow.create({ id, params: { analysisId: id } });
    } catch (createError) {
      try {
        return await runtime.workflow.get(id);
      } catch {
        throw createError;
      }
    }
  }
}

async function getExistingInstance(runtime: AnalysisRuntime, id: string) {
  try {
    return await runtime.workflow.get(id);
  } catch {
    return undefined;
  }
}

async function result(
  c: { json: (value: unknown, status?: 200 | 400 | 404) => Response },
  action: () => unknown | Promise<unknown>,
  errorStatus: 400 | 404 = 400,
) {
  try {
    return c.json(await action(), 200);
  } catch (error) {
    return c.json({ error: errorMessage(error) }, errorStatus);
  }
}
