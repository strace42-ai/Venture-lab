import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';

/** Safe external link: only http(s), opened without referrer/opener. Anything else renders as text. */
export function SourceLink({ url, children }: { url: string; children: ReactNode }) {
  let safe: string | null = null;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') safe = u.toString();
  } catch {
    safe = null;
  }
  if (!safe) return <span className="muted">{children}</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer nofollow" className="src-link">
      {children}
      <ExternalLink size={12} aria-hidden />
      <span className="sr-only"> (откроется в новой вкладке)</span>
    </a>
  );
}
