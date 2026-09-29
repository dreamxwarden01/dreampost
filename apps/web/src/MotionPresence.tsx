import { useEffect, useState, type ReactNode } from 'react';

/** Closing surfaces become inert immediately, then leave after their brief exit motion. */
export function MotionPresence({ open, children, className = '' }: { open: boolean; children: ReactNode; className?: string }) {
  const [retained, setRetained] = useState(open);
  useEffect(() => {
    if (open) { setRetained(true); return; }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setRetained(false); return; }
    const timer = window.setTimeout(() => setRetained(false), 140);
    return () => window.clearTimeout(timer);
  }, [open]);
  if (!open && !retained) return null;
  return <div className={`motion-presence ${className}`} data-state={open ? 'open' : 'closed'} inert={!open} aria-hidden={!open || undefined}>{children}</div>;
}
