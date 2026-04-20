'use client';

/**
 * The Scalar API reference is served as a plain HTML page from the Express
 * API server (/api-reference) so it is completely isolated from Tailwind's
 * CSS preflight reset. This page embeds it in a full-height iframe.
 */
export default function ApiReferencePage() {
  const apiUrl = process.env.NEXT_PUBLIC_ELEVARUS_API_URL ?? 'http://localhost:3001';

  return (
    <div className="-mx-6 -my-6 h-[calc(100vh-3.5rem)]">
      <iframe
        src={`${apiUrl}/api-reference`}
        title="ElevarusOS API Reference"
        className="w-full h-full border-0"
        loading="lazy"
      />
    </div>
  );
}
