'use client';
import { useState, useEffect } from 'react';
import { formatRelativeTime } from '@/lib/utils';

export function RelativeTime({ dateStr, className }: { dateStr: string; className?: string }) {
  const [label, setLabel] = useState(() => formatRelativeTime(dateStr));

  useEffect(() => {
    const id = setInterval(() => setLabel(formatRelativeTime(dateStr)), 30_000);
    return () => clearInterval(id);
  }, [dateStr]);

  return (
    <span className={className} title={new Date(dateStr).toLocaleString()}>
      {label}
    </span>
  );
}
