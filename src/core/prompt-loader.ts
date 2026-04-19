import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The parsed result of loading and rendering a prompt template.
 *
 * `systemPrompt` — Claude system message. Comes from the `systemPrompt:`
 *                  frontmatter field. Falls back to a safe generic default.
 *
 * `userPrompt`   — Rendered user message with all `{{PLACEHOLDER}}` markers
 *                  replaced from the vars map.
 */
export interface PromptResult {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Options for instance-aware prompt resolution.
 */
export interface PromptOptions {
  /**
   * Bot instance ID (e.g. "elevarus-blog", "nes-blog").
   * When provided, the loader checks
   *   src/agents/{instanceId}/prompts/{filename}
   * before falling back to the base workflow template.
   *
   * This is how per-instance prompt customisation works — create a file in
   * the instance's prompts/ folder with the same name as the base template
   * and it will be used instead.
   */
  instanceId?: string;
  /**
   * Extra variables merged on top of the caller-supplied vars.
   * Instance config vars (BRAND_VOICE, INSTANCE_NAME, etc.) are automatically
   * added by the prompt builders when an instanceId is available.
   */
  extraVars?: Record<string, string>;
}

/** Absolute path to the src/agents/ directory. */
export const INSTANCES_DIR = path.resolve(__dirname, "../agents");

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Loads a Markdown prompt template and renders it with instance-aware override
 * support and `{{PLACEHOLDER}}` substitution.
 *
 * ## Override resolution (first found wins):
 *   1. `src/agents/{instanceId}/prompts/{filename}` — instance-specific
 *   2. `templatePath` — base workflow template (e.g. workflows/blog/prompts/)
 *
 * ## Variable injection (later overrides earlier):
 *   1. `vars` from the caller (request fields)
 *   2. `options.extraVars` (instance brand vars, etc.)
 *
 * ## Template file format
 *
 * ```markdown
 * ---
 * systemPrompt: "You are an expert content strategist. Return only valid JSON."
 * ---
 *
 * Your task is to create a research package for {{INSTANCE_NAME}}.
 *
 * Brand voice: {{BRAND_VOICE}}
 * Title: {{TITLE}}
 * ...
 * ```
 *
 * @param templatePath  Absolute path to the base `.md` file.
 * @param vars          Placeholder substitutions (request data).
 * @param options       Instance routing and extra var options.
 */
export function loadPrompt(
  templatePath: string,
  vars: Record<string, string> = {},
  options: PromptOptions = {}
): PromptResult {
  // ── Resolve which file to actually load ───────────────────────────────────

  let resolvedPath = path.resolve(templatePath);

  if (options.instanceId) {
    const filename = path.basename(templatePath);
    const instanceOverride = path.join(
      INSTANCES_DIR,
      options.instanceId,
      "prompts",
      filename
    );
    if (fs.existsSync(instanceOverride)) {
      resolvedPath = instanceOverride;
    }
  }

  // ── Read and parse ────────────────────────────────────────────────────────

  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, "utf8");
  } catch (err) {
    throw new Error(
      `prompt-loader: could not read "${resolvedPath}": ${String(err)}`
    );
  }

  const { data, content } = matter(raw);

  const systemPrompt: string = data.systemPrompt
    ? String(data.systemPrompt)
    : "Follow the instructions in the user message exactly. Return only valid JSON.";

  // ── Render placeholders ───────────────────────────────────────────────────

  const mergedVars: Record<string, string> = {
    ...vars,
    ...(options.extraVars ?? {}),
  };

  const userPrompt = content.replace(
    /\{\{([A-Z0-9_]+)\}\}/g,
    (match, key: string) => (key in mergedVars ? mergedVars[key] : match)
  );

  return { systemPrompt, userPrompt };
}
