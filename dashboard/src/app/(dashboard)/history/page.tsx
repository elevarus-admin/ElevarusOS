'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { listJobs, getInstances, type ApiJob, type ApiInstance } from '@/lib/api';
import { StatusBadge } from '@/components/jobs/status-badge';
import { RelativeTime } from '@/components/ui/relative-time';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDuration } from '@/lib/utils';
import { AlertCircle } from 'lucide-react';

const PAGE_SIZE = 25;

const STATUS_OPTIONS = [
  { value: 'all',               label: 'All statuses' },
  { value: 'queued',            label: 'Queued' },
  { value: 'running',           label: 'Running' },
  { value: 'awaiting_approval', label: 'Awaiting Approval' },
  { value: 'approved',          label: 'Approved' },
  { value: 'rejected',          label: 'Rejected' },
  { value: 'failed',            label: 'Failed' },
  { value: 'completed',         label: 'Completed' },
];

function truncate(str: string, max: number) {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

export default function HistoryPage() {
  const router = useRouter();

  // Filter state
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [instanceFilter, setInstanceFilter] = useState<string>('all');

  // Applied filters (committed on "Apply")
  const [appliedStatus, setAppliedStatus] = useState<string>('all');
  const [appliedInstance, setAppliedInstance] = useState<string>('all');

  // Data
  const [jobs, setJobs] = useState<ApiJob[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Instances for dropdown
  const [instances, setInstances] = useState<ApiInstance[]>([]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fetchJobs = useCallback(async (currentPage: number, status: string, instanceId: string) => {
    try {
      setLoading(true);
      setError(null);
      const result = await listJobs({
        status:     status !== 'all' ? status : undefined,
        instanceId: instanceId !== 'all' ? instanceId : undefined,
        limit:      PAGE_SIZE,
        offset:     currentPage * PAGE_SIZE,
      });
      setJobs(result.jobs);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job history');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch instances for the dropdown once on mount
  useEffect(() => {
    getInstances()
      .then(setInstances)
      .catch(() => {/* non-fatal */});
  }, []);

  // Fetch jobs whenever page or applied filters change
  useEffect(() => {
    fetchJobs(page, appliedStatus, appliedInstance);
  }, [page, appliedStatus, appliedInstance, fetchJobs]);

  function handleApply() {
    setPage(0);
    setAppliedStatus(statusFilter);
    setAppliedInstance(instanceFilter);
  }

  function handleRetry() {
    fetchJobs(page, appliedStatus, appliedInstance);
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy">Job History</h1>
          <p className="text-sm text-brand-muted mt-0.5">
            Browse and filter all past agent jobs
          </p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-5">
        <Select value={instanceFilter} onValueChange={setInstanceFilter}>
          <SelectTrigger className="w-52">
            <SelectValue placeholder="All instances" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All instances</SelectItem>
            {instances.map((inst) => (
              <SelectItem key={inst.id} value={inst.id}>
                {inst.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button onClick={handleApply} size="sm">
          Apply
        </Button>
      </div>

      {/* Error state */}
      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error loading history</AlertTitle>
          <AlertDescription className="flex items-center justify-between mt-1">
            <span>{error}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRetry}
              className="ml-4 border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground"
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job ID</TableHead>
                <TableHead>Instance</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead>Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[1, 2, 3, 4, 5].map((i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-5 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-28" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-48" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-12" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && jobs.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="text-base font-medium text-brand-muted">No jobs found</p>
          <p className="text-sm text-brand-muted mt-1">
            Try changing the filters or check back later.
          </p>
        </div>
      )}

      {/* Table */}
      {!loading && jobs.length > 0 && (
        <>
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50">
                  <TableHead className="font-semibold">Job ID</TableHead>
                  <TableHead className="font-semibold">Instance</TableHead>
                  <TableHead className="font-semibold">Title</TableHead>
                  <TableHead className="font-semibold">Status</TableHead>
                  <TableHead className="font-semibold">Created</TableHead>
                  <TableHead className="font-semibold">Completed</TableHead>
                  <TableHead className="font-semibold">Duration</TableHead>
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
                      <span className="font-mono text-xs text-brand-muted">
                        {job.jobId.slice(0, 8)}
                      </span>
                    </TableCell>
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
                      <RelativeTime dateStr={job.createdAt} />
                    </TableCell>
                    <TableCell className="text-sm text-brand-muted">
                      {job.completedAt ? (
                        <RelativeTime dateStr={job.completedAt} />
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-brand-muted tabular-nums">
                      {formatDuration(job.createdAt, job.completedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4">
            <p className="text-sm text-brand-muted">
              Page {page + 1} of {totalPages}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
