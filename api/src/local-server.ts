import { serve } from "@hono/node-server";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalArtifactStore } from "./local-artifacts";
import { LocalPersistence } from "./local-persistence";
import { createLocalApp } from "./local-runtime";
import { LocalTimingStore } from "./local-timing-store";
import { LocalVideoStore } from "./local-video-store";
import { executeLocalStabilization } from "./processing-local";
import { AnalysisWorkflow } from "./workflow";

/** Starts a loopback-only Node runtime with local source/artifact files and SQLite metadata. */
export function startLocalServer(dataDirectory = resolve(process.env.RC_ANALYSIS_DATA ?? ".local-data"), port = Number(process.env.PORT ?? "8787")) {
  const persistence = new LocalPersistence(join(dataDirectory, "metadata.sqlite"), fileURLToPath(new URL("../drizzle/local-migrations", import.meta.url)));
  const artifacts = new LocalArtifactStore(join(dataDirectory, "artifacts"), persistence);
  const videos = new LocalVideoStore(join(dataDirectory, "videos"));
  const workflow = new AnalysisWorkflow(persistence);
  const app = createLocalApp(workflow, persistence, artifacts, videos, (id, signal) => executeLocalStabilization(id, workflow, persistence, artifacts, { signal, resolveVideoPath: async (reference) => videos.resolvePath(reference) }), {
    store: new LocalTimingStore(persistence.db),
    fetch: async (url) => { const response = await fetch(url, { headers: { "user-agent": "rc-racing-line-analysis/1.0" } }); return { url: response.url, status: response.status, html: await response.text() }; },
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
  return { app, server, persistence };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startLocalServer();
