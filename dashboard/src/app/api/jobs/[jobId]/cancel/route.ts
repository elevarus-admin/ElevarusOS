import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { jobId } = await params;
  const apiUrl = process.env.NEXT_PUBLIC_ELEVARUS_API_URL ?? 'http://localhost:3001';
  const apiSecret = process.env.ELEVARUS_API_SECRET;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiSecret) headers['x-api-key'] = apiSecret;

  const resp = await fetch(`${apiUrl}/api/jobs/${jobId}/cancel`, { method: 'POST', headers });
  const data = await resp.json();
  return NextResponse.json(data, { status: resp.status });
}
