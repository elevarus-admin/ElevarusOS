'use client';
import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { getFile, putFile } from '@/lib/api';
import { MarkdownEditor } from '@/components/editor/MarkdownEditor';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ArrowLeft, Save, AlertCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

// Known prompt files per workflow type.
// Keys are the actual directory names under src/workflows/ — NOT baseWorkflow
// values from instance.md. Reporting agents all share the ppc-campaign-report
// logic but each has its OWN workflow directory (e.g. final-expense-reporting).
const WORKFLOW_PROMPTS: Record<string, readonly string[]> = {
  // Blog workflow
  blog: ['research.md', 'outline.md', 'draft.md', 'editorial.md'],
  // Reporting workflows — each agent has its own directory + shared prompt files
  'final-expense-reporting': ['analysis.md', 'summary.md'],
  'u65-reporting':           ['analysis.md', 'summary.md'],
  'hvac-reporting':          ['analysis.md', 'summary.md'],
};
const FALLBACK_PROMPTS = ['prompt.md'];

interface FileState {
  content: string;
  lastModified: string;
  dirty: boolean;
}

export default function WorkflowEditPage() {
  const { workflowType } = useParams<{ workflowType: string }>();
  const [files, setFiles] = useState<Partial<Record<string, FileState>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('');

  const promptFiles = WORKFLOW_PROMPTS[workflowType] ?? FALLBACK_PROMPTS;

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    const loaded: Partial<Record<string, FileState>> = {};

    await Promise.all(
      promptFiles.map(async (filename) => {
        const path = `src/workflows/${workflowType}/prompts/${filename}`;
        try {
          const result = await getFile(path);
          loaded[filename] = { content: result.content, lastModified: result.lastModified, dirty: false };
        } catch {
          // File not found — skip
        }
      })
    );

    if (Object.keys(loaded).length === 0) {
      setError(`No prompt files found for workflow "${workflowType}".`);
    } else {
      setActiveTab(Object.keys(loaded)[0]);
    }

    setFiles(loaded);
    setLoading(false);
  }, [workflowType, promptFiles]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  function handleChange(filename: string, value: string) {
    setFiles((prev) => ({
      ...prev,
      [filename]: { ...prev[filename]!, content: value, dirty: true },
    }));
  }

  async function handleSave(filename: string) {
    const fileState = files[filename];
    if (!fileState) return;
    const path = `src/workflows/${workflowType}/prompts/${filename}`;
    try {
      setSaving(filename);
      await putFile(path, fileState.content);
      setFiles((prev) => ({
        ...prev,
        [filename]: { ...prev[filename]!, dirty: false },
      }));
      toast.success(`${filename} saved successfully`);
    } catch (err) {
      toast.error(`Failed to save ${filename}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(null);
    }
  }

  const availableFiles = Object.keys(files);

  return (
    <div>
      {/* Breadcrumb + back */}
      <div className="mb-6">
        <Link
          href="/agents"
          className="inline-flex items-center gap-1.5 text-sm text-brand-muted hover:text-brand-navy mb-3 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Agents
        </Link>
        <h1 className="text-2xl font-bold text-brand-navy">
          Edit Workflow
          <span className="ml-2 font-mono text-base font-normal text-brand-muted">{workflowType}</span>
        </h1>
        <p className="text-sm text-brand-muted mt-0.5">
          Edit workflow prompt files
        </p>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error loading files</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && (
        <div className="space-y-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-96 w-full" />
        </div>
      )}

      {!loading && availableFiles.length > 0 && (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-4 bg-gray-100 p-1">
            {availableFiles.map((filename) => (
              <TabsTrigger
                key={filename}
                value={filename}
                className="gap-1.5 data-[state=active]:bg-brand-navy data-[state=active]:text-white data-[state=inactive]:text-brand-navy/70 data-[state=inactive]:hover:text-brand-navy"
              >
                {filename}
                {files[filename]?.dirty && (
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 inline-block" />
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          {availableFiles.map((filename) => (
            <TabsContent key={filename} value={filename}>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-brand-muted">
                    Path:{' '}
                    <code className="font-mono bg-gray-100 px-1 rounded">
                      src/workflows/{workflowType}/prompts/{filename}
                    </code>
                    {files[filename]?.lastModified && (
                      <> &nbsp;&middot;&nbsp; Last modified: {new Date(files[filename]!.lastModified).toLocaleString()}</>
                    )}
                  </p>
                  <Button
                    size="sm"
                    disabled={!files[filename]?.dirty || saving === filename}
                    className="gap-1.5 bg-brand-primary hover:bg-brand-primary/90 text-white"
                    onClick={() => handleSave(filename)}
                  >
                    {saving === filename ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    Save
                  </Button>
                </div>
                <MarkdownEditor
                  value={files[filename]?.content ?? ''}
                  onChange={(val) => handleChange(filename, val)}
                  height="500px"
                />
              </div>
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
