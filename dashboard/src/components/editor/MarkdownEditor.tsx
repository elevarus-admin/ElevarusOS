'use client';
import dynamic from 'next/dynamic';
import { useState, useEffect } from 'react';

const CodeMirror = dynamic(() => import('@uiw/react-codemirror'), { ssr: false });

interface Props {
  value: string;
  onChange: (val: string) => void;
  height?: string;
}

// Use `unknown[]` for extensions to avoid the @codemirror/state peer-dep import
export function MarkdownEditor({ value, onChange, height = '500px' }: Props) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [extensions, setExtensions] = useState<any[]>([]);

  useEffect(() => {
    Promise.all([
      import('@codemirror/lang-markdown').then((m) => m.markdown()),
      import('@codemirror/theme-one-dark').then((m) => m.oneDark),
    ]).then(([md, theme]) => setExtensions([md, theme]));
  }, []);

  return (
    <CodeMirror
      value={value}
      height={height}
      extensions={extensions}
      onChange={onChange}
      className="border rounded-md overflow-hidden text-sm"
    />
  );
}
