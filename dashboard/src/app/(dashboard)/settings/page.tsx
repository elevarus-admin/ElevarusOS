'use client';
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

const STORAGE_KEY = 'elevarus-dashboard-prefs';

interface Prefs {
  showCostEstimates: boolean;
  historyPageSize: 25 | 50 | 100;
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultPrefs(), ...JSON.parse(raw) };
  } catch {}
  return defaultPrefs();
}

function defaultPrefs(): Prefs {
  return { showCostEstimates: true, historyPageSize: 25 };
}

function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {}
}

export default function SettingsPage() {
  const [prefs, setPrefs] = useState<Prefs>(defaultPrefs());
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setPrefs(loadPrefs());
  }, []);

  function update<K extends keyof Prefs>(key: K, value: Prefs[K]) {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    savePrefs(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  const apiUrl = process.env.NEXT_PUBLIC_ELEVARUS_API_URL ?? 'http://localhost:3001';

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-brand-navy">Settings</h1>
        <p className="text-sm text-brand-muted mt-0.5">Dashboard preferences and configuration</p>
      </div>

      {saved && (
        <div className="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-4 py-2">
          Preferences saved.
        </div>
      )}

      <div className="space-y-6 max-w-xl">
        {/* Display section */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Display</CardTitle>
            <CardDescription>Control how the dashboard presents information.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Show cost estimates */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-brand-navy">Show cost estimates</p>
                <p className="text-xs text-brand-muted mt-0.5">
                  Display estimated token cost on the Token Usage page.
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={prefs.showCostEstimates}
                  onChange={(e) => update('showCostEstimates', e.target.checked)}
                />
                <div className="w-10 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:bg-brand-primary transition-colors" />
                <div className="absolute left-1 top-1 bg-white h-4 w-4 rounded-full transition-transform peer-checked:translate-x-4 shadow-sm" />
              </label>
            </div>

            {/* History page size */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-brand-navy">History page size</p>
                <p className="text-xs text-brand-muted mt-0.5">
                  Number of jobs to show per page in Job History.
                </p>
              </div>
              <select
                value={prefs.historyPageSize}
                onChange={(e) => update('historyPageSize', Number(e.target.value) as Prefs['historyPageSize'])}
                className="text-sm rounded-md border border-gray-200 bg-white px-3 py-1.5 text-brand-navy focus:outline-none focus:ring-2 focus:ring-brand-primary"
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </div>
          </CardContent>
        </Card>

        {/* About section */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">About</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <div className="flex gap-3">
                <dt className="w-36 text-brand-muted shrink-0">Dashboard version</dt>
                <dd className="text-brand-navy font-mono">0.2.0</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-36 text-brand-muted shrink-0">API URL</dt>
                <dd className="text-brand-navy font-mono break-all">{apiUrl}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-36 text-brand-muted shrink-0">Platform</dt>
                <dd className="text-brand-navy">ElevarusOS</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
