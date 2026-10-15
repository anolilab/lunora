/**
 * Deletion grace window (GAPS.md D3): 30 days to change your mind before the
 * purge. Here rather than in `lunora/organizations.ts` because the scheduled
 * box sweep (`src/boxes/reconcile.ts`) retires an organization's boxes at the
 * same cutoff, just before the purge erases them.
 */
export const DELETION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
