import { createApp } from "./app.js";
import { D1AnalysisStore } from "./d1-store.js";
import { AnalysisWorkflow } from "./workflow.js";
import { AnalysisProgressRoom } from "./progress-room.js";
import { AnalysisProcessingWorkflow } from "./processing-workflow.js";
import { D1TimingStore } from "./timing-d1-store";

export { AnalysisProgressRoom, AnalysisProcessingWorkflow };

export default {
  fetch(request: Request, env: Env, executionContext: ExecutionContext) {
    const publish = (analysis: import("./domain.js").Analysis) => env.ANALYSIS_PROGRESS_ROOMS.getByName(analysis.id).publish(analysis);
    return createApp(new AnalysisWorkflow(new D1AnalysisStore(env.DB), publish), {
      workflow: env.ANALYSIS_PROCESSING,
      room: env.ANALYSIS_PROGRESS_ROOMS,
    }, {
      fetch: async (url) => { const response = await fetch(url, { headers: { "user-agent": "rc-racing-line-analysis/1.0" } }); return { url: response.url, status: response.status, html: await response.text() }; },
      store: new D1TimingStore(env.DB),
    }).fetch(request, env, executionContext);
  },
};
