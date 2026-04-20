import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type JobStatus =
  | 'queued' | 'running' | 'awaiting_approval'
  | 'approved' | 'rejected' | 'failed' | 'completed';

const STATUS_CONFIG: Record<JobStatus, { label: string; className: string }> = {
  queued:            { label: 'Queued',            className: 'bg-gray-100 text-gray-600 hover:bg-gray-100' },
  running:           { label: 'Running',           className: 'bg-blue-100 text-blue-700 hover:bg-blue-100' },
  awaiting_approval: { label: 'Awaiting Approval', className: 'bg-amber-100 text-amber-700 hover:bg-amber-100' },
  approved:          { label: 'Approved',          className: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' },
  rejected:          { label: 'Rejected',          className: 'bg-orange-100 text-orange-700 hover:bg-orange-100' },
  failed:            { label: 'Failed',            className: 'bg-red-100 text-red-700 hover:bg-red-100' },
  completed:         { label: 'Completed',         className: 'bg-green-100 text-green-700 hover:bg-green-100' },
};

export function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status as JobStatus] ?? { label: status, className: 'bg-gray-100 text-gray-600' };
  return (
    <Badge variant="secondary" className={cn('font-medium text-xs', cfg.className)}>
      {cfg.label}
    </Badge>
  );
}
