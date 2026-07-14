import { Hono } from "hono";
import { z } from "zod";
import type { AnalysisWorkflow } from "./workflow.js";

const createAnalysis = z.object({
  videoPath: z.string().trim().min(1),
  videoName: z.string().trim().min(1),
  carDescription: z.string().trim().optional(),
});
const progressReport = z.object({
  phase: z.enum(["created", "calibrating", "tracking", "review"]),
  progress: z.number().min(0).max(1),
  checkpoint: z.string().optional(),
});

export function createApp(workflow: AnalysisWorkflow) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.post("/analyses", async (c) => {
    const parsed = createAnalysis.safeParse(await c.req.json());
    if (!parsed.success)
      return c.json({ error: "videoPath and videoName are required" }, 400);
    return c.json(workflow.createDraft(parsed.data), 201);
  });
  app.get("/analyses/:id", (c) =>
    result(c, () => workflow.get(c.req.param("id")), 404),
  );
  app.post("/analyses/:id/queue", (c) =>
    result(c, () => workflow.queue(c.req.param("id"))),
  );
  app.post("/analyses/:id/start", (c) =>
    result(c, () => workflow.start(c.req.param("id"))),
  );
  app.post("/analyses/:id/cancel", (c) =>
    result(c, () => workflow.cancel(c.req.param("id"))),
  );
  app.post("/analyses/:id/resume", (c) =>
    result(c, () => workflow.resume(c.req.param("id"))),
  );
  app.post("/analyses/:id/report", async (c) => {
    const parsed = progressReport.safeParse(await c.req.json());
    if (!parsed.success)
      return c.json({ error: "invalid progress report" }, 400);
    return result(c, () => workflow.report(c.req.param("id"), parsed.data));
  });
  return app;
}

function result(
  c: { json: (value: unknown, status?: 200 | 400 | 404) => Response },
  action: () => unknown,
  errorStatus: 400 | 404 = 400,
) {
  try {
    return c.json(action(), 200);
  } catch (error) {
    return c.json({ error: (error as Error).message }, errorStatus);
  }
}
