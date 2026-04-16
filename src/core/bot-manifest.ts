import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

// ─── Manifest types ───────────────────────────────────────────────────────────

/** Describes one stage as declared in a bot.md manifest. */
export interface StageManifest {
  /** Machine-readable stage name — must match IStage.stageName */
  name: string;
  /** Human-readable label shown in logs and UIs */
  label: string;
  /** One-line description of what this stage does */
  description: string;
  /** True if this stage makes Claude API calls */
  aiPowered: boolean;
  /** Path to the prompt template, relative to the workflow's prompts/ directory */
  promptFile?: string;
}

/** Bot-level orchestration settings from bot.md. */
export interface BotConfig {
  /**
   * If true, the orchestrator flips the job to "awaiting_approval" after the
   * stage named by approvalStage completes.
   */
  requiresApproval: boolean;
  /** Stage name that triggers the awaiting_approval status transition. */
  approvalStage?: string;
  /** Override the global MAX_STAGE_RETRIES for this workflow. */
  maxRetries?: number;
}

/**
 * The full parsed contents of a bot.md YAML frontmatter block.
 *
 * This is the single source of truth for:
 * - What this bot is and what it produces
 * - Which stages it has, in what order, and which are AI-powered
 * - Bot-level orchestration config
 *
 * The body of bot.md (after the frontmatter) is free-form Markdown
 * documentation and is not parsed at runtime.
 */
export interface BotManifest {
  /** Unique identifier — stored on every Job as job.workflowType */
  type: string;
  /** Human-readable bot name */
  name: string;
  /** Semantic version of this bot definition */
  version: string;
  /** One-sentence description of what this bot produces */
  description: string;
  /** Author / team that owns this bot */
  author?: string;
  /** Ordered stage definitions */
  stages: StageManifest[];
  /** Orchestration config */
  config: BotConfig;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Reads a bot.md file, parses the YAML frontmatter, validates required fields,
 * and returns a typed BotManifest.
 *
 * @param botMdPath  Absolute path to the bot.md file.
 */
export function loadBotManifest(botMdPath: string): BotManifest {
  const resolved = path.resolve(botMdPath);

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    throw new Error(`bot-manifest: cannot read "${resolved}": ${String(err)}`);
  }

  const { data } = matter(raw);

  // ── Validate required top-level fields ──────────────────────────────────

  const required = ["type", "name", "version", "description", "stages", "config"] as const;
  for (const field of required) {
    if (!data[field]) {
      throw new Error(
        `bot-manifest: "${resolved}" is missing required frontmatter field: "${field}"`
      );
    }
  }

  if (!Array.isArray(data.stages) || data.stages.length === 0) {
    throw new Error(`bot-manifest: "${resolved}" must declare at least one stage`);
  }

  // ── Validate each stage ─────────────────────────────────────────────────

  const stages: StageManifest[] = (data.stages as any[]).map((s, i) => {
    if (!s.name) {
      throw new Error(
        `bot-manifest: stage[${i}] in "${resolved}" is missing required field "name"`
      );
    }
    return {
      name: String(s.name),
      label: String(s.label ?? s.name),
      description: String(s.description ?? ""),
      aiPowered: Boolean(s.aiPowered ?? false),
      promptFile: s.promptFile ? String(s.promptFile) : undefined,
    };
  });

  const cfg = data.config as any ?? {};

  return {
    type: String(data.type),
    name: String(data.name),
    version: String(data.version),
    description: String(data.description),
    author: data.author ? String(data.author) : undefined,
    stages,
    config: {
      requiresApproval: Boolean(cfg.requiresApproval ?? false),
      approvalStage: cfg.approvalStage ? String(cfg.approvalStage) : undefined,
      maxRetries: cfg.maxRetries !== undefined ? Number(cfg.maxRetries) : undefined,
    },
  };
}

/**
 * Returns the ordered stage names from a manifest.
 * Useful when building a WorkflowDefinition from a bot.md.
 */
export function stageNamesFromManifest(manifest: BotManifest): string[] {
  return manifest.stages.map((s) => s.name);
}
