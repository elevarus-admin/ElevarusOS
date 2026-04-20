'use client';
import { useState, useEffect, useCallback } from 'react';
import { getSchedule, getBots, type ApiScheduleEntry, type ApiBot } from '@/lib/api';
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
import { AlertCircle } from 'lucide-react';

interface ScheduleRow {
  instanceId:     string;
  name:           string;
  cron:           string | null;
  description:    string | null;
  timezone:       string;
  nextFire:       Date | null;
  nextFireLabel:  string;
  lastJobStatus?: string;
  lastJobAt?:     string;
}

function computeNextFire(cron: string | null, timezone: string): Date | null {
  if (!cron) return null;
  try {
    // Dynamic import-style: use the global require since cron-parser is a CommonJS module
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parseExpression } = require('cron-parser') as typeof import('cron-parser');
    const interval = parseExpression(cron, { tz: timezone || 'UTC' });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

function formatNextFire(date: Date | null): string {
  if (!date) return '—';
  const now = Date.now();
  const diff = date.getTime() - now;
  if (diff < 0) return 'overdue';

  const secs  = Math.floor(diff / 1000);
  const mins  = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);

  let relative: string;
  if (days > 0)       relative = `in ${days}d ${hours % 24}h`;
  else if (hours > 0) relative = `in ${hours}h ${mins % 60}m`;
  else if (mins > 0)  relative = `in ${mins}m`;
  else                relative = `in ${secs}s`;

  const dateLabel = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const timeLabel = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  return `${dateLabel} at ${timeLabel} — ${relative}`;
}

export default function ScheduledPage() {
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const [schedule, bots] = await Promise.all([getSchedule(), getBots()]);

      const botMap = new Map<string, ApiBot>();
      bots.forEach((b) => botMap.set(b.instanceId, b));

      const computed: ScheduleRow[] = schedule.map((entry: ApiScheduleEntry) => {
        const bot = botMap.get(entry.instanceId);
        const nextFire = computeNextFire(entry.cron, entry.timezone);
        return {
          instanceId:    entry.instanceId,
          name:          entry.name,
          cron:          entry.cron,
          description:   entry.description,
          timezone:      entry.timezone,
          nextFire,
          nextFireLabel: formatNextFire(nextFire),
          lastJobStatus: bot?.stats.lastJobStatus,
          lastJobAt:     bot?.stats.lastJobAt,
        };
      });

      // Sort by next fire time ascending; null entries go last
      computed.sort((a, b) => {
        if (!a.nextFire && !b.nextFire) return 0;
        if (!a.nextFire) return 1;
        if (!b.nextFire) return -1;
        return a.nextFire.getTime() - b.nextFire.getTime();
      });

      setRows(computed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load schedule');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy">Scheduled Jobs</h1>
          <p className="text-sm text-brand-muted mt-0.5">
            Cron schedules and next fire times for all configured instances
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData}>
          Refresh
        </Button>
      </div>

      {/* Error state */}
      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error loading schedule</AlertTitle>
          <AlertDescription className="flex items-center justify-between mt-1">
            <span>{error}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchData}
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
                <TableHead>Description</TableHead>
                <TableHead>Cron</TableHead>
                <TableHead>Next Fire</TableHead>
                <TableHead>Last Status</TableHead>
                <TableHead>Last Run</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[1, 2, 3].map((i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-5 w-28" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-40" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-48" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && rows.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="text-base font-medium text-brand-muted">No scheduled instances configured.</p>
        </div>
      )}

      {/* Schedule table */}
      {!loading && rows.length > 0 && (
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50">
                <TableHead className="font-semibold">Instance</TableHead>
                <TableHead className="font-semibold">Description</TableHead>
                <TableHead className="font-semibold">Cron</TableHead>
                <TableHead className="font-semibold">Next Fire</TableHead>
                <TableHead className="font-semibold">Last Status</TableHead>
                <TableHead className="font-semibold">Last Run</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.instanceId}>
                  <TableCell className="font-mono text-xs text-brand-muted">
                    {row.instanceId}
                  </TableCell>
                  <TableCell className="text-sm text-brand-navy">
                    {row.description ?? row.name}
                  </TableCell>
                  <TableCell>
                    {row.cron ? (
                      <Badge variant="outline" className="font-mono text-xs">
                        {row.cron}
                      </Badge>
                    ) : (
                      <span className="text-brand-muted text-sm">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-brand-muted">
                    {row.nextFireLabel}
                  </TableCell>
                  <TableCell>
                    {row.lastJobStatus ? (
                      <StatusBadge status={row.lastJobStatus} />
                    ) : (
                      <span className="text-brand-muted text-sm">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-brand-muted">
                    {row.lastJobAt ? (
                      <RelativeTime dateStr={row.lastJobAt} />
                    ) : (
                      '—'
                    )}
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
