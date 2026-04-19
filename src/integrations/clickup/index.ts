/**
 * ClickUp Integration — Phase 1 (read-only).
 *
 * The Slack bot picks up the read tools automatically via the manifest
 * (registered in src/core/integration-registry.ts). Workflows that need raw
 * REST access can import `ClickUpHttpClient` directly.
 *
 * Phase 2 will add write methods to the client and corresponding live tools.
 * Phase 3 will add the `clickup-sync` workflow stage. Phase 4 adds the
 * inbound webhook handler.
 */
export { ClickUpHttpClient } from "./client";
export type {
  ClickUpListTasksOptions,
  ClickUpFindTasksOptions,
} from "./client";
export type {
  ClickUpCatalog,
  ClickUpCatalogSpace,
  ClickUpCatalogList,
  ClickUpCatalogMember,
  ClickUpTask,
  ClickUpComment,
  ClickUpStatus,
  ClickUpTag,
  ClickUpUser,
  ClickUpCustomField,
  ClickUpWebhookEvent,
  ClickUpWebhookEventType,
} from "./types";
