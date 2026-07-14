import { Hono } from "hono";
import { z } from "zod";
import { errorMessage } from "./errors.js";
import type { AnalysisProgressRoom } from "./progress-room.js";
import type { AnalysisWorkflow } from "./workflow.js";

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
export function createApp(workflow: AnalysisWorkflow, runtime?: AnalysisRuntime) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
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
