import { useEffect, useRef, useState } from 'react';

/**
 * Tells a table which rows arrived since the last poll, so only those flash.
 * The first render is not "new" — otherwise the whole log would light up on load.
 */
export function useNewRows(keys: string[]): (key: string) => boolean {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(keys);
      return;
    }
    const added = keys.filter(key => !seen.current!.has(key));
    if (added.length === 0) return;
    added.forEach(key => seen.current!.add(key));
    setFresh(new Set(added));
    // Clear after the animation so a later re-render does not replay it.
    const timer = window.setTimeout(() => setFresh(new Set()), 700);
    return () => window.clearTimeout(timer);
  }, [keys.join('|')]);

  return (key: string) => fresh.has(key);
}
