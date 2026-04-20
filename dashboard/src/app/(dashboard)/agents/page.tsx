'use client';
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { getInstances, type ApiInstance } from '@/lib/api';
import { agentAvatarUrl } from '@/lib/avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Circle, AlertCircle, Pencil, Sparkles, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

const WORKFLOW_BADGE: Record<string, string> = {
  blog:                 'bg-blue-100 text-blue-700 hover:bg-blue-100',
  'ppc-campaign-report':'bg-teal-100 text-teal-700 hover:bg-teal-100',
};

function WorkflowBadge({ workflow }: { workflow: string }) {
  const cls = WORKFLOW_BADGE[workflow] ?? 'bg-gray-100 text-gray-600 hover:bg-gray-100';
  return (
    <Badge variant="secondary" className={cn('text-xs font-medium', cls)}>
      {workflow}
    </Badge>
  );
}

function AgentCard({ instance }: { instance: ApiInstance }) {
  const scheduleLabel = instance.schedule.enabled && instance.schedule.cron
    ? instance.schedule.cron
    : 'On-demand';
  const scheduleDescription = instance.schedule.description ?? null;
  const avatarSrc = agentAvatarUrl(instance.id, 80);

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          {/* Avatar */}
          <div className="shrink-0 rounded-xl overflow-hidden border border-gray-100 bg-gray-50" style={{ width: 56, height: 56 }}>
            <Image
              src={avatarSrc}
              alt={`${instance.name} avatar`}
              width={56}
              height={56}
              className="object-cover"
              // DiceBear returns an SVG — unoptimized to allow external URL
              unoptimized
            />
          </div>

          {/* Name + ID + actions */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold text-brand-navy truncate">{instance.name}</p>
                <p className="font-mono text-xs text-brand-muted mt-0.5 truncate">{instance.id}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <WorkflowBadge workflow={instance.baseWorkflow} />
                <Button asChild variant="ghost" size="sm" className="h-7 w-7 p-0 text-brand-muted hover:text-brand-navy">
                  <Link href={`/agents/${instance.id}/edit`} title="Edit agent files">
                    <Pencil className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0 flex-1">
        <dl className="space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="text-brand-muted w-20 shrink-0">Schedule:</dt>
            <dd className="text-brand-navy">
              <span className="font-mono text-xs">{scheduleLabel}</span>
              {scheduleDescription && (
                <span className="block text-brand-muted text-xs mt-0.5">{scheduleDescription}</span>
              )}
            </dd>
          </div>

          <div className="flex gap-2">
            <dt className="text-brand-muted w-20 shrink-0">Approver:</dt>
            <dd className="text-brand-navy truncate">{instance.notify.approver ?? 'None'}</dd>
          </div>

          <div className="flex gap-2">
            <dt className="text-brand-muted w-20 shrink-0">Slack:</dt>
            <dd className="text-brand-navy truncate">{instance.notify.slackChannel ?? 'None'}</dd>
          </div>

          <div className="flex gap-2 items-center">
            <dt className="text-brand-muted w-20 shrink-0">Status:</dt>
            <dd className="flex items-center gap-1.5">
              <Circle
                className={cn(
                  'h-3.5 w-3.5 fill-current',
                  instance.enabled ? 'text-green-500' : 'text-gray-300'
                )}
              />
              <span className={cn('text-sm font-medium', instance.enabled ? 'text-green-700' : 'text-gray-400')}>
                {instance.enabled ? 'Active' : 'Disabled'}
              </span>
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

/**
 * Pinned-first pseudo-agent card that opens the Agent Builder wizard.
 * Implementation lives in src/core/agent-builder/ on the backend; this card
 * is the dashboard entry point. See docs/prd-agent-builder.md.
 */
function NewAgentCard() {
  return (
    <Card className="flex flex-col border-dashed border-2 border-brand-primary/30 bg-gradient-to-br from-brand-primary/5 to-transparent hover:border-brand-primary/60 hover:shadow-md transition-all">
      <Link href="/agents/new" className="flex flex-col h-full">
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <div className="shrink-0 rounded-xl border border-brand-primary/20 bg-white flex items-center justify-center" style={{ width: 56, height: 56 }}>
              <Sparkles className="h-7 w-7 text-brand-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-brand-navy">Agent Builder</p>
              <p className="font-mono text-xs text-brand-muted mt-0.5 truncate">build a new agent</p>
            </div>
            <Badge variant="secondary" className="bg-brand-primary/10 text-brand-primary text-xs font-medium">
              <Plus className="h-3 w-3 mr-1" />
              New
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="pt-0 flex-1 flex flex-col justify-between">
          <p className="text-sm text-brand-muted">
            Six probing questions, one ClickUp PRD, and a build-ready spec for engineering.
            Use this when you can&apos;t find an agent that does what you need.
          </p>
          <div className="mt-4 flex items-center text-sm font-medium text-brand-primary">
            Start scoping →
          </div>
        </CardContent>
      </Link>
    </Card>
  );
}

function SkeletonCard() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <Skeleton className="h-14 w-14 rounded-xl shrink-0" />
          <div className="flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <Skeleton className="h-5 w-32 mb-1.5" />
                <Skeleton className="h-3.5 w-48" />
              </div>
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-24" />
      </CardContent>
    </Card>
  );
}

export default function AgentsPage() {
  const [instances, setInstances] = useState<ApiInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchInstances = useCallback(async () => {
    try {
      setError(null);
      const data = await getInstances();
      setInstances(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load instances');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInstances();
  }, [fetchInstances]);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy">Agents</h1>
          <p className="text-sm text-brand-muted mt-0.5">
            Registered agent instances and their configuration
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchInstances}>
          Refresh
        </Button>
      </div>

      {/* Error state */}
      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error loading agents</AlertTitle>
          <AlertDescription className="flex items-center justify-between mt-1">
            <span>{error}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchInstances}
              className="ml-4 border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground"
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Loading state */}
      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2].map((i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {/* Empty state — still show the New Agent card so users can start scoping */}
      {!loading && !error && instances.length === 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <NewAgentCard />
          <div className="flex flex-col items-center justify-center text-center py-12 rounded-lg border border-dashed border-gray-200">
            <p className="text-base font-medium text-brand-muted">No agent instances registered yet.</p>
            <p className="text-sm text-brand-muted mt-1">
              Click &ldquo;Agent Builder&rdquo; to scope your first one.
            </p>
          </div>
        </div>
      )}

      {/* Card grid — Agent Builder pinned first */}
      {!loading && instances.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <NewAgentCard />
          {instances.map((instance) => (
            <AgentCard key={instance.id} instance={instance} />
          ))}
        </div>
      )}
    </div>
  );
}
