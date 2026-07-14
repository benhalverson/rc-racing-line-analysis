import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Analysis } from "./domain";
import { D1AnalysisStore } from "./d1-store";
import { executeAnalysisProcessing, type ProcessingStep } from "./processing-runner";
import { AnalysisWorkflow } from "./workflow";

export class AnalysisProcessingWorkflow extends WorkflowEntrypoint<Env, { analysisId: string }> {
  async run(event: WorkflowEvent<{ analysisId: string }>, step: WorkflowStep): Promise<void> {
    const id = event.payload.analysisId;
    const processing = new AnalysisWorkflow(new D1AnalysisStore(this.env.DB));
    const processingStep: ProcessingStep = {
      sleep: (name, duration) => step.sleep(name, duration),
      do: (name, callback) => step.do(name, () => callback(undefined)),
    };
    await executeAnalysisProcessing(id, processingStep, processing, (analysis) => this.publish(analysis));
  }

  private publish(analysis: Analysis): Promise<void> {
    return this.env.ANALYSIS_PROGRESS_ROOMS.getByName(analysis.id).publish(analysis);
  }
}
