const API_URL = process.env.NEXT_PUBLIC_ELEVARUS_API_URL ?? 'http://localhost:3001';

// ── Types matching ElevarusOS API responses ───────────────────────────────────

export interface ApiJob {
  jobId:           string;
  workflowType:    string;
  status:          string;
  title:           string;
  createdAt:       string;
  updatedAt:       string;
  completedAt:     string | null;
  currentStage:    string | null;
  completedStages: number;
  totalStages:     number;
  approvalPending: boolean;
  error:           string | null;
}

export interface ApiJobDetail extends ApiJob {
  request:       Record<string, unknown>;
  approval:      { required: boolean; approved: boolean; approvedBy?: string; approvedAt?: string; notes?: string };
  publishRecord: unknown | null;
  stages:        ApiStage[];
}

export interface ApiStage {
  name:        string;
  status:      string;
  attempts:    number;
  startedAt:   string | null;
  completedAt: string | null;
  error:       string | null;
  hasOutput:   boolean;
}

export interface ApiJobOutput {
  jobId:        string;
  workflowType: string;
  status:       string;
  title:        string;
  completedAt:  string | null;
  report:       string | null;
  slackMessage: string | null;
  alertLevel:   string | null;
  oneLiner:     string | null;
  finalDraft:   string | null;
  initialDraft: string | null;
  stages:       Record<string, unknown>;
}

export interface ApiBot {
  instanceId:   string;
  name:         string;
  baseWorkflow: string;
  enabled:      boolean;
  schedule:     { enabled: boolean; cron?: string; description?: string };
  notify:       { approver?: string };
  stats: {
    total:          number;
    running:        number;
    lastJobId?:     string;
    lastJobStatus?: string;
    lastJobAt?:     string;
    lastJobTitle?:  string;
  };
}

export interface ApiInstance {
  id:           string;
  name:         string;
  baseWorkflow: string;
  enabled:      boolean;
  brand:        { voice: string; audience: string; tone: string; industry?: string };
  notify:       { approver?: string; slackChannel?: string };
  schedule:     { enabled: boolean; cron?: string; description?: string };
}

export interface ApiScheduleEntry {
  instanceId:  string;
  name:        string;
  cron:        string | null;
  description: string | null;
  timezone:    string;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`ElevarusOS API ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function getActiveJobs(): Promise<ApiJob[]> {
  const [running, awaiting] = await Promise.all([
    apiFetch<{ jobs: ApiJob[] }>('/api/jobs?status=running'),
    apiFetch<{ jobs: ApiJob[] }>('/api/jobs?status=awaiting_approval'),
  ]);
  const combined = [...running.jobs, ...awaiting.jobs];
  return combined.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSchedule(): Promise<ApiScheduleEntry[]> {
  const data = await apiFetch<{ schedule: ApiScheduleEntry[] }>('/api/schedule');
  return data.schedule;
}

export async function getBots(): Promise<ApiBot[]> {
  const data = await apiFetch<{ bots: ApiBot[] }>('/api/bots');
  return data.bots;
}

export async function getInstances(): Promise<ApiInstance[]> {
  const data = await apiFetch<{ instances: ApiInstance[] }>('/api/instances');
  return data.instances;
}

export async function getJob(jobId: string): Promise<ApiJobDetail> {
  return apiFetch<ApiJobDetail>(`/api/jobs/${jobId}`);
}

export async function getJobOutput(jobId: string): Promise<ApiJobOutput> {
  return apiFetch<ApiJobOutput>(`/api/jobs/${jobId}/output`);
}

export async function listJobs(params: {
  status?: string;
  instanceId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ jobs: ApiJob[]; total: number; limit: number; offset: number }> {
  const qs = new URLSearchParams();
  if (params.status)     qs.set('status', params.status);
  if (params.instanceId) qs.set('instanceId', params.instanceId);
  qs.set('limit',  String(params.limit  ?? 25));
  qs.set('offset', String(params.offset ?? 0));
  return apiFetch(`/api/jobs?${qs.toString()}`);
}

// ── Token analytics ───────────────────────────────────────────────────────────

export interface TokenDay {
  day: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  jobCount: number;
}
export interface TokenWorkflow {
  workflowType: string;
  totalTokens: number;
  costUsd: number;
  jobCount: number;
}
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}
export interface TokenAnalytics {
  days: number;
  totals: TokenTotals;
  byDay: TokenDay[];
  byWorkflow: TokenWorkflow[];
}
export async function getTokenAnalytics(days = 30, instanceId?: string): Promise<TokenAnalytics> {
  const params = new URLSearchParams({ days: String(days) });
  if (instanceId) params.set('instanceId', instanceId);
  return apiFetch(`/api/analytics/tokens?${params}`);
}

// ── Integrations ──────────────────────────────────────────────────────────────

export interface IntegrationColumn { name: string; type: string; description: string; }
export interface IntegrationTable { name: string; description: string; columns: IntegrationColumn[]; }
export interface Integration {
  id: string; name: string; description: string; enabled: boolean;
  tables: IntegrationTable[]; liveTools: string[]; features: string[];
}
export async function getIntegrations(): Promise<{ integrations: Integration[] }> {
  return apiFetch('/api/integrations');
}

// ── Workflows ─────────────────────────────────────────────────────────────────

export interface LinkedAgent {
  id: string;
  name: string;
  enabled: boolean;
}

export interface ApiWorkflow {
  type:         string;
  registered:   boolean;   // true if in WorkflowRegistry (server running)
  stages:       string[];  // ordered stage names
  prompts:      string[];  // .md prompt file names
  linkedAgents: LinkedAgent[];
  promptPath:   string;    // e.g. src/workflows/final-expense-reporting/prompts
}

export async function getWorkflows(): Promise<ApiWorkflow[]> {
  const data = await apiFetch<{ workflows: ApiWorkflow[] }>('/api/workflows');
  return data.workflows;
}

// ── File editor ───────────────────────────────────────────────────────────────

export async function getFile(path: string): Promise<{ path: string; content: string; lastModified: string }> {
  return apiFetch(`/api/files?path=${encodeURIComponent(path)}`);
}
export async function putFile(path: string, content: string): Promise<{ success: boolean; savedAt: string }> {
  return apiFetch('/api/files?path=' + encodeURIComponent(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

// ── Cancel job ────────────────────────────────────────────────────────────────

export async function cancelJob(jobId: string): Promise<{ cancelled: boolean }> {
  return apiFetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
}

// ── Settings ──────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<{ settings: Record<string, unknown> }> {
  return apiFetch('/api/settings');
}
export async function updateSetting(key: string, value: unknown): Promise<void> {
  return apiFetch(`/api/settings/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
}

// ── Agent Builder ─────────────────────────────────────────────────────────────

export interface AgentBuilderStartResponse {
  sessionId:      string;
  questionIndex:  number;
  nextQuestion:   string;
  totalQuestions: number;
  intro:          string | null;
}

export interface AgentBuilderTurnResponse {
  sessionId:       string;
  nextQuestion:    string | null;
  nextIndex:       number | null;
  readyToFinalize: boolean;
}

export interface AgentBuilderTurnError {
  error:    string;          // e.g. "out_of_order"
  message:  string;
  expected?: number;
  got?:      number;
}

export interface AgentBuilderTicketResponse {
  sessionId:      string;
  clickupTaskId:  string;
  clickupTaskUrl: string;
  title:          string;
  tags:           string[];
}

export async function startAgentBuilderSession(createdBy?: string): Promise<AgentBuilderStartResponse> {
  return apiFetch('/api/agent-builder', {
    method: 'POST',
    body:   JSON.stringify({ createdBy }),
  });
}

export async function submitAgentBuilderTurn(
  sessionId:     string,
  questionIndex: number,
  answer:        string,
): Promise<AgentBuilderTurnResponse> {
  return apiFetch(`/api/agent-builder/${sessionId}/turn`, {
    method: 'POST',
    body:   JSON.stringify({ questionIndex, answer }),
  });
}

export async function finalizeAgentBuilder(
  sessionId: string,
  meta: {
    proposedName?:  string;
    proposedSlug?:  string;
    verticalTag?:   string;
    capabilityTag?: string;
  } = {},
): Promise<AgentBuilderTicketResponse> {
  return apiFetch(`/api/agent-builder/${sessionId}/ticket`, {
    method: 'POST',
    body:   JSON.stringify(meta),
  });
}

export async function abandonAgentBuilderSession(sessionId: string): Promise<{ ok: true }> {
  return apiFetch(`/api/agent-builder/${sessionId}/abandon`, { method: 'POST' });
}
