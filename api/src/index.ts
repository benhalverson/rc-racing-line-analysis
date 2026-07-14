import { createApp } from "./app.js";
import { D1AnalysisStore } from "./d1-store.js";
import { AnalysisWorkflow } from "./workflow.js";
import { AnalysisProgressRoom } from "./progress-room.js";
import { AnalysisProcessingWorkflow } from "./processing-workflow.js";

export { AnalysisProgressRoom, AnalysisProcessingWorkflow };

export default {
  fetch(request: Request, env: Env, executionContext: ExecutionContext) {
    const publish = (analysis: import("./domain.js").Analysis) => env.ANALYSIS_PROGRESS_ROOMS.getByName(analysis.id).publish(analysis);
    return createApp(new AnalysisWorkflow(new D1AnalysisStore(env.DB), publish), {
      workflow: env.ANALYSIS_PROCESSING,
      room: env.ANALYSIS_PROGRESS_ROOMS,
    }).fetch(request, env, executionContext);
  },
};
