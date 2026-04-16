import * as path from "path";
import { IStage } from "../../../core/stage.interface";
import { Job } from "../../../models/job.model";
import { loadPrompt } from "../../../core/prompt-loader";
import { claudeJSON } from "../../../core/claude-client";
import { logger } from "../../../core/logger";

// ── Output type ──────────────────────────────────────────────────────────────
// Define the shape of what this stage returns.
// Add this to your workflow's output.model.ts for type-safe access downstream.

interface ExampleStageOutput {
  fieldOne: string;
  fieldTwo: string;
  items: string[];
}

// ── Prompt template ───────────────────────────────────────────────────────────
// Path to the .md file that contains this stage's system prompt + user template.
// ✏️  Edit that file to tune the bot's behavior — no TypeScript changes needed.

const TEMPLATE = path.join(__dirname, "../prompts/_stage.md");

// ── Stage implementation ──────────────────────────────────────────────────────

/**
 * Stage N — Example Stage
 *
 * Replace this description with what this stage actually does.
 *
 * ✏️  Tune this stage:  src/workflows/<name>/prompts/<stage>.md
 */
export class ExampleStage implements IStage {
  // Must match the `name` field in bot.md's stages list
  readonly stageName = "stage-name";

  async run(job: Job): Promise<ExampleStageOutput> {
    logger.info(`Running ${this.stageName} stage`, { jobId: job.id });

    // ── Build the prompt ─────────────────────────────────────────────────────
    // Map job request fields to the {{PLACEHOLDER}} keys in your .md template.
    // For stages that need prior stage output, use requireStageOutput():
    //   import { requireStageOutput } from "../../../core/stage.interface";
    //   const prevOutput = requireStageOutput<PrevOutput>(job, "prev-stage-name");

    const { systemPrompt, userPrompt } = loadPrompt(TEMPLATE, {
      FIELD_ONE: job.request.title,   // replace with actual field mappings
      FIELD_TWO: job.request.brief,
    });

    // ── Call Claude ───────────────────────────────────────────────────────────
    const result = await claudeJSON<ExampleStageOutput>(
      systemPrompt,
      userPrompt,
      job.id
    );

    logger.info(`${this.stageName} stage complete`, {
      jobId: job.id,
      // log a useful summary of the result
    });

    return result;
  }
}
