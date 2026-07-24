/** Duration as a compact `12ms` / `1.4s`. */
export const formatMs = (ms: number): string => (ms < 1000 ? `${String(Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`);
