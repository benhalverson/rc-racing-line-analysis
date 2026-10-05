import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Analysis } from "./domain";
import { D1AnalysisStore } from "./d1-store";

import { AnalysisWorkflow } from "./workflow";

export class AnalysisProcessingWorkflow extends WorkflowEntrypoint<Env, { analysisId: string }> {
  /** Reject disk processing on the incompatible Workers runtime with a durable explanation. */
  async run(event: WorkflowEvent<{ analysisId: string }>, step: WorkflowStep): Promise<void> {
    const id = event.payload.analysisId;
    const processing = new AnalysisWorkflow(new D1AnalysisStore(this.env.DB));
    // Workers cannot read an operator's OPFS video or write local artifacts.
    // Fail explicitly rather than advancing placeholder checkpoints without CV output.
    await step.do("local processing runtime required", async () => {
      const analysis = await processing.get(id);
      if (analysis.state !== "running") return;
      const failed = await processing.fail(id, "Use the local Node runtime to process video and disk artifacts");
      await this.publish(failed);
    });
  }

  /** Publish the durable failure through the existing progress transport. */
  private publish(analysis: Analysis): Promise<void> {
    return this.env.ANALYSIS_PROGRESS_ROOMS.getByName(analysis.id).publish(analysis);
  }
}
