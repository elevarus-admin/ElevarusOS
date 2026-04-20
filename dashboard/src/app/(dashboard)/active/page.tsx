'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getActiveJobs, cancelJob, type ApiJob } from '@/lib/api';
import { StatusBadge } from '@/components/jobs/status-badge';
import { RelativeTime } from '@/components/ui/relative-time';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, RefreshCw, Ban, Loader2 } from 'lucide-react';

const POLL_INTERVAL = 15_000;

function CancelIconButton({ jobId, onRefresh }: { jobId: string; onRefresh: () => void }) {
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState(false);

  async function handleCancel(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm) { setConfirm(true); return; }
    try {
      setLoading(true);
      await cancelJob(jobId);
      onRefresh();
    } catch {
      // silently reset
    } finally {
      setLoading(false);
      setConfirm(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      title={confirm ? 'Click again to confirm cancel' : 'Cancel job'}
      onClick={handleCancel}
      className={confirm
        ? 'text-red-600 hover:text-red-700 hover:bg-red-50 h-7 w-7 p-0'
        : 'text-gray-400 hover:text-red-500 hover:bg-red-50 h-7 w-7 p-0'}
    >
      {loading
        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
        : <Ban className="h-3.5 w-3.5" />
      }
    </Button>
  );
}

export default function ActiveJobsPage() {
  const [jobs, setJobs] = useState<ApiJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [secondsSince, setSecondsSince] = useState(0);
  const router = useRouter();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      setError(null);
      const data = await getActiveJobs();
      setJobs(data);
      setLastUpdated(new Date());
      setSecondsSince(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load active jobs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
    intervalRef.current = setInterval(fetchJobs, POLL_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchJobs]);

  // Tick the "last updated X seconds ago" counter
  useEffect(() => {
    const id = setInterval(() => {
      setSecondsSince((s) => s + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  function truncate(str: string, max: number) {
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy">Active Jobs</h1>
          <p className="text-sm text-brand-muted mt-0.5">
            Running and awaiting-approval agent jobs
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-brand-muted">
              Updated {secondsSince}s ago
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={fetchJobs}
            className="gap-1.5"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error loading jobs</AlertTitle>
          <AlertDescription className="flex items-center justify-between mt-1">
            <span>{error}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchJobs}
              className="ml-4 border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground"
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Loading state */}
      {loading && (
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Instance</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Current Stage</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[1, 2, 3].map((i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-48" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-28" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-10" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                  <TableCell></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && jobs.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="text-4xl mb-4">-</div>
          <p className="text-base font-medium text-brand-muted">No active jobs</p>
          <p className="text-sm text-brand-muted mt-1">All agents are idle.</p>
        </div>
      )}

      {/* Jobs table */}
      {!loading && jobs.length > 0 && (
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50">
                <TableHead className="font-semibold">Instance</TableHead>
                <TableHead className="font-semibold">Title</TableHead>
                <TableHead className="font-semibold">Status</TableHead>
                <TableHead className="font-semibold">Current Stage</TableHead>
                <TableHead className="font-semibold">Progress</TableHead>
                <TableHead className="font-semibold">Started</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job) => (
                <TableRow
                  key={job.jobId}
                  className="cursor-pointer hover:bg-gray-50 transition-colors"
                  onClick={() => router.push(`/jobs/${job.jobId}`)}
                >
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-xs">
                      {job.workflowType}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className="max-w-xs font-medium text-brand-navy"
                    title={job.title}
                  >
                    {truncate(job.title, 60)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={job.status} />
                  </TableCell>
                  <TableCell className="text-sm text-brand-muted">
                    {job.currentStage ?? '—'}
                  </TableCell>
                  <TableCell className="text-sm text-brand-muted tabular-nums">
                    {job.completedStages}/{job.totalStages}
                  </TableCell>
                  <TableCell className="text-sm text-brand-muted">
                    <RelativeTime dateStr={job.createdAt} />
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <CancelIconButton jobId={job.jobId} onRefresh={fetchJobs} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
