import { IStage } from "./stage.interface";

/**
 * Describes a complete bot workflow.
 *
 * `type`   — unique string key stored on every Job as `job.workflowType`
 * `stages` — ordered IStage instances; the orchestrator runs them left to right
 *
 * Stage names are derived at runtime from `stages.map(s => s.stageName)` so
 * there is no list to keep in sync.
 *
 * To add a new bot:
 *   1. Create src/workflows/<name>/ — bot.md manifest + prompts/ + stages/
 *   2. Implement IStage for each step
 *   3. Export buildXxxWorkflowDefinition() from <name>.workflow.ts
 *   4. Call registry.register(buildXxxWorkflowDefinition(...)) in src/index.ts
 */
export interface WorkflowDefinition {
  /** Unique identifier — stored on every Job as job.workflowType */
  readonly type: string;
  /** Ordered, instantiated stages */
  readonly stages: IStage[];
}

/**
 * Central registry that maps workflowType strings to their definitions.
 *
 * The orchestrator uses this at job-creation time (to initialise StageRecord[])
 * and at job-run time (to look up the ordered stage list).
 */
export class WorkflowRegistry {
  private readonly workflows = new Map<string, WorkflowDefinition>();

  /** Register a workflow. Throws if type is already registered. */
  register(workflow: WorkflowDefinition): void {
    if (this.workflows.has(workflow.type)) {
      throw new Error(
        `WorkflowRegistry: a workflow with type "${workflow.type}" is already registered`
      );
    }
    this.workflows.set(workflow.type, workflow);
  }

  /** Look up a workflow definition by type string. */
  get(type: string): WorkflowDefinition | undefined {
    return this.workflows.get(type);
  }

  /** Returns true if a workflow with the given type is registered. */
  has(type: string): boolean {
    return this.workflows.has(type);
  }

  /** All registered workflow type strings. */
  get registeredTypes(): string[] {
    return [...this.workflows.keys()];
  }
}
