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
  const body = await req.json().catch(() => ({}));
  const apiUrl = process.env.NEXT_PUBLIC_ELEVARUS_API_URL ?? 'http://localhost:3001';
  const apiSecret = process.env.ELEVARUS_API_SECRET;

  const res = await fetch(`${apiUrl}/api/jobs/${jobId}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiSecret ? { 'x-api-key': apiSecret } : {}),
    },
    body: JSON.stringify({ ...body, approvedBy: user.email }),
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
