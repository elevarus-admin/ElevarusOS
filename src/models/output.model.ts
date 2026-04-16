/**
 * Typed outputs produced by each blog workflow stage.
 * Later stages receive the accumulated outputs of all previous stages.
 */

export interface IntakeOutput {
  sourceId?: string;
  rawText: string;
}

export interface NormalizationOutput {
  /** True when all required fields were present in the source */
  isComplete: boolean;
  filledFields: string[];
  missingFields: string[];
}

export interface ResearchOutput {
  topicFraming: string;
  subtopics: string[];
  questionsToAnswer: string[];
  sourceSuggestions: string[];
  keywordNotes: string;
}

export interface OutlineOutput {
  sections: OutlineSection[];
  estimatedWordCount: number;
}

export interface OutlineSection {
  heading: string;
  notes: string;
  subheadings?: string[];
}

export interface DraftOutput {
  title: string;
  body: string;
  wordCount: number;
}

export interface EditorialOutput {
  title: string;
  body: string;
  wordCount: number;
  editSummary: string;
}

export interface ApprovalNotifyOutput {
  slackMessageTs?: string;
  emailMessageId?: string;
  notifiedAt: string;
}

export interface PublishPlaceholderOutput {
  handoffStatus: "pending";
  note: string;
  createdAt: string;
}

export interface CompletionOutput {
  summary: string;
  completedAt: string;
}

/** Union of all stage outputs — used for type-safe stage result retrieval */
export type StageOutput =
  | IntakeOutput
  | NormalizationOutput
  | ResearchOutput
  | OutlineOutput
  | DraftOutput
  | EditorialOutput
  | ApprovalNotifyOutput
  | PublishPlaceholderOutput
  | CompletionOutput;
