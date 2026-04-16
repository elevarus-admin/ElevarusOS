/**
 * Blog workflow stage interface.
 *
 * This module re-exports the generic IStage interface from core under the
 * IBlogStage alias so existing stage files don't need to be updated.
 * All stage helpers (requireStageOutput, getStageOutput) are also re-exported.
 *
 * New workflows should import directly from src/core/stage.interface.ts.
 */
export type { IStage as IBlogStage } from "../../../core/stage.interface";
export { requireStageOutput, getStageOutput } from "../../../core/stage.interface";
