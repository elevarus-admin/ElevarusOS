'use client';
import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { getTokenAnalytics, type TokenAnalytics } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Info } from 'lucide-react';
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

const DAY_OPTIONS = [7, 30, 90] as const;
type DayOption = (typeof DAY_OPTIONS)[number];

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function StatCard({
  title,
  value,
  sub,
  loading,
}: {
  title: string;
  value: string;
  sub?: string;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-brand-muted">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <>
            <Skeleton className="h-8 w-28 mb-1" />
            <Skeleton className="h-4 w-20" />
          </>
        ) : (
          <>
            <p className="text-2xl font-bold text-brand-navy">{value}</p>
            {sub && <p className="text-xs text-brand-muted mt-0.5">{sub}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function WorkflowBar({ label, tokens, maxTokens, cost }: { label: string; tokens: number; maxTokens: number; cost: number }) {
  const pct = maxTokens > 0 ? (tokens / maxTokens) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-brand-navy truncate max-w-[60%]">{label}</span>
        <span className="text-brand-muted tabular-nums">{formatTokenCount(tokens)} · ${cost.toFixed(4)}</span>
      </div>
      <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
        <div
          className="h-2 rounded-full bg-brand-primary"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function TokenUsagePage() {
  const [selectedDays, setSelectedDays] = useState<DayOption>(30);
  const [data, setData] = useState<TokenAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async (days: DayOption) => {
    try {
      setLoading(true);
      setError(null);
      const result = await getTokenAnalytics(days);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load token analytics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch(selectedDays);
  }, [fetch, selectedDays]);

  const isEmpty = !loading && data && data.totals.totalTokens === 0;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy">Token Usage</h1>
          <p className="text-sm text-brand-muted mt-0.5">
            AI token consumption and cost estimates
          </p>
        </div>
        {/* Day range selector */}
        <div className="flex items-center gap-1 rounded-lg border bg-white p-1">
          {DAY_OPTIONS.map((d) => (
            <Button
              key={d}
              variant={selectedDays === d ? 'default' : 'ghost'}
              size="sm"
              className={selectedDays === d ? 'bg-brand-primary text-white hover:bg-brand-primary/90' : ''}
              onClick={() => setSelectedDays(d)}
            >
              {d}d
            </Button>
          ))}
        </div>
      </div>

      {/* Error */}
      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to load token data</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Empty state */}
      {isEmpty && (
        <div className="flex flex-col items-center justify-center py-24 text-center rounded-lg border border-dashed">
          <p className="text-base font-medium text-brand-muted">No token data yet.</p>
          <p className="text-sm text-brand-muted mt-1">
            Token tracking is captured for new jobs.
          </p>
        </div>
      )}

      {!isEmpty && (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            <StatCard
              title="Total Tokens"
              value={loading ? '—' : formatTokenCount(data?.totals.totalTokens ?? 0)}
              sub={loading ? undefined : `${formatTokenCount(data?.totals.inputTokens ?? 0)} in / ${formatTokenCount(data?.totals.outputTokens ?? 0)} out`}
              loading={loading}
            />
            <StatCard
              title="Input Tokens"
              value={loading ? '—' : formatTokenCount(data?.totals.inputTokens ?? 0)}
              loading={loading}
            />
            <StatCard
              title="Estimated Cost"
              loading={loading}
              value={loading ? '—' : `~$${(data?.totals.estimatedCostUsd ?? 0).toFixed(2)}`}
              sub="Based on Anthropic list prices"
            />
          </div>

          {/* Cost estimate disclaimer */}
          <div className="flex items-center gap-1.5 text-xs text-brand-muted mb-6">
            <TooltipProvider>
              <UITooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 cursor-help">
                    <Info className="h-3.5 w-3.5" />
                    ~${(data?.totals.estimatedCostUsd ?? 0).toFixed(2)} (estimate)
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs text-xs">
                  Based on Anthropic list prices. Actual billing may vary depending on your plan and model used.
                </TooltipContent>
              </UITooltip>
            </TooltipProvider>
          </div>

          {/* Daily token stacked bar chart */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base font-semibold text-brand-navy">Daily Token Usage</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-64 w-full" />
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={data?.byDay ?? []} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={(v) => v.slice(5)} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatTokenCount(v)} />
                    <Tooltip
                      formatter={(value: number, name: string) => [formatTokenCount(value), name === 'inputTokens' ? 'Input' : 'Output']}
                      labelFormatter={(l) => `Date: ${l}`}
                    />
                    <Legend formatter={(v) => v === 'inputTokens' ? 'Input Tokens' : 'Output Tokens'} />
                    <Bar dataKey="inputTokens" stackId="a" fill="#04BF7E" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="outputTokens" stackId="a" fill="#16163F" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Daily cost area chart */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base font-semibold text-brand-navy">Daily Cost</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-48 w-full" />
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={data?.byDay ?? []} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <defs>
                      <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#F59E0B" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#F59E0B" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={(v) => v.slice(5)} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v.toFixed(3)}`} />
                    <Tooltip formatter={(v: number) => [`$${v.toFixed(4)}`, 'Cost (USD)']} labelFormatter={(l) => `Date: ${l}`} />
                    <Area type="monotone" dataKey="costUsd" stroke="#F59E0B" strokeWidth={2} fill="url(#costGradient)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* By workflow breakdown */}
          {(data?.byWorkflow?.length ?? 0) > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base font-semibold text-brand-navy">Usage by Workflow</CardTitle>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <div className="space-y-4">
                    {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
                  </div>
                ) : (
                  <div className="space-y-4">
                    {data?.byWorkflow.map((wf) => {
                      const max = Math.max(...(data?.byWorkflow.map((w) => w.totalTokens) ?? [1]));
                      return (
                        <WorkflowBar
                          key={wf.workflowType}
                          label={wf.workflowType}
                          tokens={wf.totalTokens}
                          maxTokens={max}
                          cost={wf.costUsd}
                        />
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
