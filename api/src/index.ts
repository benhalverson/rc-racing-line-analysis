import { createApp } from "./app.js";
import { InMemoryAnalysisStore } from "./store.js";
import { AnalysisWorkflow } from "./workflow.js";

const workflow = new AnalysisWorkflow(new InMemoryAnalysisStore());

export default createApp(workflow);
