'use client';
import { useState, useEffect, useCallback } from 'react';
import { getIntegrations, type Integration } from '@/lib/api';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';

function TableSchema({ columns }: { columns: Integration['tables'][number]['columns'] }) {
  return (
    <div className="mt-2 rounded-md border overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-brand-muted">Column</th>
            <th className="px-3 py-2 text-left font-medium text-brand-muted">Type</th>
            <th className="px-3 py-2 text-left font-medium text-brand-muted">Description</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {columns.map((col) => (
            <tr key={col.name}>
              <td className="px-3 py-1.5 font-mono text-brand-navy">{col.name}</td>
              <td className="px-3 py-1.5 text-brand-muted">{col.type}</td>
              <td className="px-3 py-1.5 text-brand-muted">{col.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableRow({ table }: { table: Integration['tables'][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border">
      <button
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm text-left hover:bg-gray-50 transition-colors"
      >
        <span className="font-medium text-brand-navy">{table.name}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-brand-muted hidden sm:inline">{table.description}</span>
          {open ? <ChevronDown className="h-3.5 w-3.5 text-brand-muted" /> : <ChevronRight className="h-3.5 w-3.5 text-brand-muted" />}
        </div>
      </button>
      {open && table.columns.length > 0 && (
        <div className="px-3 pb-3">
          <TableSchema columns={table.columns} />
        </div>
      )}
    </div>
  );
}

function IntegrationCard({ integration }: { integration: Integration }) {
  const [tablesOpen, setTablesOpen] = useState(false);
  const isDisabled = !integration.enabled;

  return (
    <Card className={cn('flex flex-col transition-opacity', isDisabled && 'opacity-60')}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <p className="font-semibold text-brand-navy">{integration.name}</p>
          <Badge
            variant="secondary"
            className={cn(
              'text-xs font-medium shrink-0',
              integration.enabled
                ? 'bg-green-100 text-green-700 hover:bg-green-100'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-100'
            )}
          >
            {integration.enabled ? 'Enabled' : 'Disabled'}
          </Badge>
        </div>
        <p className="text-sm text-brand-muted mt-1">{integration.description}</p>

        {isDisabled && (
          <p className="text-xs text-amber-600 mt-1">
            Configure environment variables in <code className="font-mono bg-amber-50 px-1 rounded">.env</code> to enable.
          </p>
        )}
      </CardHeader>

      <CardContent className="pt-0 flex-1 space-y-4">
        {/* Feature badges */}
        {integration.features.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {integration.features.map((f) => (
              <Badge key={f} variant="outline" className="text-xs">
                {f}
              </Badge>
            ))}
          </div>
        )}

        {/* Live tools */}
        {integration.liveTools.length > 0 && (
          <div className="flex items-center gap-1.5 text-sm text-brand-muted">
            <Wrench className="h-3.5 w-3.5 shrink-0" />
            <span>
              {integration.liveTools.length} live tool{integration.liveTools.length !== 1 ? 's' : ''}
            </span>
          </div>
        )}

        {/* Tables exposed */}
        {integration.tables.length > 0 && (
          <div>
            <button
              onClick={() => setTablesOpen((p) => !p)}
              className="flex items-center gap-1.5 text-sm font-medium text-brand-navy hover:text-brand-primary transition-colors mb-2"
            >
              {tablesOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              Tables exposed ({integration.tables.length})
            </button>
            {tablesOpen && (
              <div className="space-y-2">
                {integration.tables.map((table) => (
                  <TableRow key={table.name} table={table} />
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SkeletonCard() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className="h-4 w-full mt-2" />
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-32" />
      </CardContent>
    </Card>
  );
}

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchIntegrations = useCallback(async () => {
    try {
      setError(null);
      const data = await getIntegrations();
      setIntegrations(data.integrations);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load integrations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchIntegrations();
  }, [fetchIntegrations]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy">Integrations</h1>
          <p className="text-sm text-brand-muted mt-0.5">
            Connected services and data sources
          </p>
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to load integrations</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {!loading && !error && integrations.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center rounded-lg border border-dashed">
          <p className="text-base font-medium text-brand-muted">No integrations configured.</p>
          <p className="text-sm text-brand-muted mt-1">
            Add integrations to the ElevarusOS API server.
          </p>
        </div>
      )}

      {!loading && integrations.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {integrations.map((integration) => (
            <IntegrationCard key={integration.id} integration={integration} />
          ))}
        </div>
      )}
    </div>
  );
}
