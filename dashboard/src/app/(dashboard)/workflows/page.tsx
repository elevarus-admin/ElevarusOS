'use client';
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { getWorkflows, type ApiWorkflow, getInstances, type ApiInstance } from '@/lib/api';
import { agentAvatarUrl } from '@/lib/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertCircle, FileText, Layers, Pencil, ChevronDown, ChevronRight, Bot,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import Image from 'next/image';

// Pretty-print a workflow type slug
function workflowLabel(type: string): string {
  return type
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function StagePill({ name, index }: { name: string; index: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="flex items-center justify-center h-5 w-5 rounded-full bg-brand-primary/10 text-brand-primary text-[10px] font-bold shrink-0">
        {index + 1}
      </span>
      <span className="text-xs font-mono text-brand-navy/80">{name}</span>
    </div>
  );
}

function PromptFileRow({
  filename,
  workflowType,
}: {
  filename: string;
  workflowType: string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0">
      <div className="flex items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-brand-muted shrink-0" />
        <span className="text-xs font-mono text-brand-navy">{filename}</span>
      </div>
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs text-brand-muted hover:text-brand-navy gap-1"
      >
        <Link href={`/workflows/${workflowType}/edit`}>
          <Pencil className="h-3 w-3" />
          Edit
        </Link>
      </Button>
    </div>
  );
}

function LinkedAgentChip({ agent }: { agent: ApiWorkflow['linkedAgents'][number] }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-2 py-1.5">
      <div className="shrink-0 rounded-md overflow-hidden border border-gray-100 bg-white" style={{ width: 24, height: 24 }}>
        <Image
          src={agentAvatarUrl(agent.id, 24)}
          alt={agent.name}
          width={24}
          height={24}
          unoptimized
        />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-brand-navy truncate">{agent.name}</p>
        <p className="text-[10px] font-mono text-brand-muted truncate">{agent.id}</p>
      </div>
      <span
        className={cn(
          'ml-auto shrink-0 h-1.5 w-1.5 rounded-full',
          agent.enabled ? 'bg-green-500' : 'bg-gray-300'
        )}
      />
    </div>
  );
}

function WorkflowCard({ workflow }: { workflow: ApiWorkflow }) {
  const [stagesOpen, setStagesOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-semibold text-brand-navy">{workflowLabel(workflow.type)}</p>
              {workflow.registered ? (
                <Badge className="bg-green-100 text-green-700 hover:bg-green-100 text-xs">Live</Badge>
              ) : (
                <Badge variant="secondary" className="text-xs text-gray-500">Files only</Badge>
              )}
            </div>
            <p className="font-mono text-xs text-brand-muted mt-0.5">{workflow.type}</p>
          </div>

          {workflow.prompts.length > 0 && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs shrink-0"
            >
              <Link href={`/workflows/${workflow.type}/edit`}>
                <Pencil className="h-3 w-3" />
                Edit Prompts
              </Link>
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="pt-0 flex-1 space-y-3">

        {/* Linked agents */}
        {workflow.linkedAgents.length > 0 && (
          <div>
            <p className="text-xs font-medium text-brand-muted uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <Bot className="h-3.5 w-3.5" />
              Linked Agents
            </p>
            <div className="space-y-1.5">
              {workflow.linkedAgents.map((a) => (
                <LinkedAgentChip key={a.id} agent={a} />
              ))}
            </div>
          </div>
        )}

        {/* Stages collapsible */}
        {workflow.stages.length > 0 && (
          <div>
            <button
              onClick={() => setStagesOpen((o) => !o)}
              className="flex w-full items-center justify-between text-xs font-medium text-brand-muted uppercase tracking-wide hover:text-brand-navy transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5" />
                Stages ({workflow.stages.length})
              </span>
              {stagesOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
            {stagesOpen && (
              <div className="mt-2 pl-1 space-y-2">
                {workflow.stages.map((s, i) => (
                  <StagePill key={s} name={s} index={i} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Prompt files collapsible */}
        {workflow.prompts.length > 0 && (
          <div>
            <button
              onClick={() => setPromptsOpen((o) => !o)}
              className="flex w-full items-center justify-between text-xs font-medium text-brand-muted uppercase tracking-wide hover:text-brand-navy transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5" />
                Prompt Files ({workflow.prompts.length})
              </span>
              {promptsOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
            {promptsOpen && (
              <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-1">
                {workflow.prompts.map((f) => (
                  <PromptFileRow key={f} filename={f} workflowType={workflow.type} />
                ))}
              </div>
            )}
          </div>
        )}

        {workflow.stages.length === 0 && workflow.prompts.length === 0 && (
          <p className="text-xs text-brand-muted italic">No stages or prompt files found.</p>
        )}
      </CardContent>
    </Card>
  );
}

function SkeletonCard() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <Skeleton className="h-5 w-40 mb-1.5" />
            <Skeleton className="h-3.5 w-56" />
          </div>
          <Skeleton className="h-7 w-24 rounded-md" />
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-28" />
      </CardContent>
    </Card>
  );
}

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<ApiWorkflow[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await getWorkflows();
      setWorkflows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workflows');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Separate active from supporting workflows
  const active     = workflows.filter((w) => w.linkedAgents.length > 0 || w.registered);
  const supporting = workflows.filter((w) => w.linkedAgents.length === 0 && !w.registered);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy">Workflows</h1>
          <p className="text-sm text-brand-muted mt-0.5">
            Registered workflow types, their stages, prompt files, and linked agents
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error loading workflows</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {!loading && workflows.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="text-base font-medium text-brand-muted">No workflows found.</p>
        </div>
      )}

      {!loading && active.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-widest text-brand-muted mb-3">
            Active Workflows
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
            {active.map((w) => <WorkflowCard key={w.type} workflow={w} />)}
          </div>
        </>
      )}

      {!loading && supporting.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-widest text-brand-muted mb-3">
            Supporting / Template Workflows
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {supporting.map((w) => <WorkflowCard key={w.type} workflow={w} />)}
          </div>
        </>
      )}
    </div>
  );
}
