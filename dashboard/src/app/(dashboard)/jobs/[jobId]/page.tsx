'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getJob, getJobOutput, cancelJob, type ApiJobDetail, type ApiJobOutput } from '@/lib/api';
import { StatusBadge } from '@/components/jobs/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { formatRelativeTime, formatDuration, cn } from '@/lib/utils';
import {
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  ArrowLeft,
  Copy,
  Check,
  AlertCircle,
  Ban,
} from 'lucide-react';

const POLL_INTERVAL = 10_000;

// ── Stage Timeline ────────────────────────────────────────────────────────────

interface StageTimelineProps {
  stages: ApiJobDetail['stages'];
}

function toTitleCase(str: string) {
  return str.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function StageTimeline({ stages }: StageTimelineProps) {
  const [expandedErrors, setExpandedErrors] = useState<Set<number>>(new Set());

  function toggleError(idx: number) {
    setExpandedErrors((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      {stages.map((stage, idx) => {
        const isExpanded = expandedErrors.has(idx);
        const truncatedError =
          stage.error && stage.error.length > 200
            ? stage.error.slice(0, 200) + '…'
            : stage.error;

        return (
          <div key={idx} className="flex items-start gap-3">
            {/* Icon */}
            <div className="mt-0.5 shrink-0">
              {stage.status === 'completed' && (
                <CheckCircle2 className="h-5 w-5 text-green-500" />
              )}
              {stage.status === 'running' && (
                <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />
              )}
              {stage.status === 'failed' && (
                <XCircle className="h-5 w-5 text-red-500" />
              )}
              {(stage.status === 'pending' || stage.status === 'queued') && (
                <Circle className="h-5 w-5 text-gray-300" />
              )}
              {!['completed', 'running', 'failed', 'pending', 'queued'].includes(stage.status) && (
                <Circle className="h-5 w-5 text-gray-300" />
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-brand-navy">
                  {toTitleCase(stage.name)}
                </span>
                {stage.startedAt && (
                  <span className="text-xs text-brand-muted tabular-nums">
                    {formatDuration(stage.startedAt, stage.completedAt)}
                  </span>
                )}
                {stage.attempts > 1 && (
                  <Badge
                    variant="secondary"
                    className="text-xs bg-amber-100 text-amber-700 hover:bg-amber-100"
                  >
                    Attempts: {stage.attempts}
                  </Badge>
                )}
              </div>
              {stage.error && (
                <div className="mt-1">
                  <p className="text-xs text-red-600 break-words">
                    {isExpanded ? stage.error : truncatedError}
                  </p>
                  {stage.error.length > 200 && (
                    <button
                      onClick={() => toggleError(idx)}
                      className="text-xs text-red-500 underline mt-0.5 hover:text-red-700"
                    >
                      {isExpanded ? 'Show less' : 'Show more'}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Output Panel ──────────────────────────────────────────────────────────────

interface OutputPanelProps {
  job: ApiJobDetail;
  output: ApiJobOutput;
}

const ALERT_LEVEL_CONFIG: Record<string, { label: string; className: string }> = {
  good:     { label: 'Good',     className: 'bg-green-100 text-green-700' },
  warning:  { label: 'Warning',  className: 'bg-yellow-100 text-yellow-700' },
  alert:    { label: 'Alert',    className: 'bg-red-100 text-red-700' },
  critical: { label: 'Critical', className: 'bg-red-100 text-red-700' },
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleCopy} className="gap-1.5">
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5" />
          Copied!
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" />
          Copy
        </>
      )}
    </Button>
  );
}

function OutputPanel({ job, output }: OutputPanelProps) {
  const isReporting = job.workflowType.includes('reporting');

  if (isReporting) {
    const alertCfg =
      output.alertLevel
        ? (ALERT_LEVEL_CONFIG[output.alertLevel] ?? { label: output.alertLevel, className: 'bg-gray-100 text-gray-700' })
        : null;

    return (
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-brand-navy">Report Output</h2>
            {alertCfg && (
              <Badge
                variant="secondary"
                className={cn('text-xs font-medium', alertCfg.className)}
              >
                {alertCfg.label}
              </Badge>
            )}
          </div>
          {output.report && <CopyButton text={output.report} />}
        </div>
        {output.report ? (
          <div className="prose prose-sm max-w-none rounded-lg border p-5 bg-white overflow-auto">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {output.report}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="text-sm text-brand-muted">Report not yet available.</p>
        )}
      </div>
    );
  }

  // Blog workflow
  return (
    <div>
      <h2 className="text-lg font-semibold text-brand-navy mb-4">Draft Output</h2>
      <Tabs defaultValue="final">
        <TabsList>
          <TabsTrigger value="final">Final Draft</TabsTrigger>
          <TabsTrigger value="initial">Initial Draft</TabsTrigger>
        </TabsList>

        <TabsContent value="final">
          <div className="flex justify-end mb-2">
            {output.finalDraft && <CopyButton text={output.finalDraft} />}
          </div>
          {output.finalDraft ? (
            <div className="prose prose-sm max-w-none rounded-lg border p-5 bg-white overflow-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {output.finalDraft}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-brand-muted py-4">Draft not available.</p>
          )}
        </TabsContent>

        <TabsContent value="initial">
          <div className="flex justify-end mb-2">
            {output.initialDraft && <CopyButton text={output.initialDraft} />}
          </div>
          {output.initialDraft ? (
            <div className="prose prose-sm max-w-none rounded-lg border p-5 bg-white overflow-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {output.initialDraft}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-brand-muted py-4">Draft not available.</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Approval Panel ────────────────────────────────────────────────────────────

interface ApprovalPanelProps {
  job: ApiJobDetail;
  onRefresh: () => void;
}

function ApprovalPanel({ job, onRefresh }: ApprovalPanelProps) {
  const [confirmAction, setConfirmAction] = useState<'approve' | 'reject' | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleAction(action: 'approve' | 'reject') {
    try {
      setActionLoading(true);
      setActionError(null);
      const res = await fetch(`/api/jobs/${job.jobId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`${action} failed: ${text}`);
      }
      setConfirmAction(null);
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionLoading(false);
    }
  }

  if (job.approval.approved) {
    return (
      <Alert className="border-green-200 bg-green-50">
        <CheckCircle2 className="h-4 w-4 text-green-600" />
        <AlertTitle className="text-green-800">Approved</AlertTitle>
        <AlertDescription className="text-green-700">
          Approved by {job.approval.approvedBy ?? 'unknown'}{' '}
          {job.approval.approvedAt ? `at ${new Date(job.approval.approvedAt).toLocaleString()}` : ''}
        </AlertDescription>
      </Alert>
    );
  }

  if (job.status !== 'awaiting_approval') {
    return (
      <p className="text-sm text-brand-muted">Waiting for approval gate to be reached.</p>
    );
  }

  // Awaiting approval — show buttons
  return (
    <div className="space-y-4">
      {actionError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      {confirmAction === null ? (
        <div className="flex items-center gap-3">
          <p className="text-sm text-brand-muted flex-1">
            This job is waiting for your approval before proceeding.
          </p>
          <Button
            size="sm"
            className="bg-green-600 hover:bg-green-700 text-white"
            onClick={() => setConfirmAction('approve')}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setConfirmAction('reject')}
          >
            Reject
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 border">
          <p className="text-sm text-brand-navy flex-1">
            Are you sure you want to{' '}
            <strong>{confirmAction}</strong> this job?
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={actionLoading}
            onClick={() => setConfirmAction(null)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={actionLoading}
            className={cn(
              confirmAction === 'approve'
                ? 'bg-green-600 hover:bg-green-700 text-white'
                : 'bg-destructive hover:bg-destructive/90 text-destructive-foreground'
            )}
            onClick={() => handleAction(confirmAction)}
          >
            {actionLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              confirmAction === 'approve' ? 'Confirm Approve' : 'Confirm Reject'
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Cancel Button ─────────────────────────────────────────────────────────────

interface CancelJobButtonProps {
  jobId: string;
  onRefresh: () => void;
}

function CancelJobButton({ jobId, onRefresh }: CancelJobButtonProps) {
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCancel() {
    try {
      setLoading(true);
      setError(null);
      await cancelJob(jobId);
      setConfirm(false);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setLoading(false);
    }
  }

  if (!confirm) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300"
        onClick={() => setConfirm(true)}
      >
        <Ban className="h-3.5 w-3.5" />
        Cancel Job
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <Button
        variant="outline"
        size="sm"
        disabled={loading}
        onClick={() => setConfirm(false)}
      >
        Keep
      </Button>
      <Button
        variant="destructive"
        size="sm"
        disabled={loading}
        onClick={handleCancel}
        className="gap-1.5"
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
        Confirm Cancel
      </Button>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set(['running', 'awaiting_approval']);
const CANCELLABLE_STATUSES = new Set(['running', 'awaiting_approval']);

export default function JobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const router = useRouter();

  const [job, setJob] = useState<ApiJobDetail | null>(null);
  const [output, setOutput] = useState<ApiJobOutput | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchJob = useCallback(async () => {
    try {
      const data = await getJob(jobId);
      setJob(data);
      setError(null);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job');
      return null;
    }
  }, [jobId]);

  const fetchAll = useCallback(async () => {
    try {
      setError(null);
      const [jobData, outputData] = await Promise.all([
        getJob(jobId),
        getJobOutput(jobId).catch(() => null),
      ]);
      setJob(jobData);
      setOutput(outputData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job details');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Poll if job is in an active state
  useEffect(() => {
    if (!job) return;
    if (ACTIVE_STATUSES.has(job.status)) {
      intervalRef.current = setInterval(fetchJob, POLL_INTERVAL);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [job, fetchJob]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-5 w-96" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error && !job) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error loading job</AlertTitle>
        <AlertDescription className="flex items-center justify-between mt-1">
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchAll}
            className="ml-4 border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground"
          >
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!job) return null;

  const hasOutput = output && (
    output.report || output.finalDraft || output.initialDraft
  );

  return (
    <div className="space-y-8">
      {/* Back + title row */}
      <div>
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1.5 text-sm text-brand-muted hover:text-brand-navy mb-3 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <h1 className="text-2xl font-bold text-brand-navy leading-tight">
            {job.title}
          </h1>
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <StatusBadge status={job.status} />
            <Badge variant="outline" className="font-mono text-xs">
              {job.workflowType}
            </Badge>
            {CANCELLABLE_STATUSES.has(job.status) && (
              <CancelJobButton jobId={job.jobId} onRefresh={fetchJob} />
            )}
          </div>
        </div>

        {/* Meta row */}
        <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-sm text-brand-muted">
          <span>
            Created{' '}
            <span className="text-brand-navy">{formatRelativeTime(job.createdAt)}</span>
          </span>
          <span>|</span>
          <span>
            Duration{' '}
            <span className="text-brand-navy">
              {formatDuration(job.createdAt, job.completedAt)}
            </span>
          </span>
          {job.approval.approvedBy && (
            <>
              <span>|</span>
              <span>
                Approver{' '}
                <span className="text-brand-navy">{job.approval.approvedBy}</span>
              </span>
            </>
          )}
          <span>|</span>
          <span>
            Job ID{' '}
            <span className="font-mono text-xs bg-gray-100 rounded px-1 py-0.5">
              {job.jobId}
            </span>
          </span>
        </div>
      </div>

      <hr className="border-gray-100" />

      {/* Stage Timeline */}
      {job.stages && job.stages.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-brand-navy mb-4">Stage Timeline</h2>
          <StageTimeline stages={job.stages} />
        </section>
      )}

      {/* Output Panel */}
      {hasOutput && output && (
        <section>
          <OutputPanel job={job} output={output} />
        </section>
      )}

      {/* Approval Panel */}
      {job.approval.required && (
        <section>
          <h2 className="text-lg font-semibold text-brand-navy mb-4">Approval</h2>
          <ApprovalPanel job={job} onRefresh={fetchJob} />
        </section>
      )}
    </div>
  );
}
