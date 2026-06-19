import { internalMutation } from "./_generated/server.js";

/**
 * Tenant cron fan-out heartbeat (CLOUD-PLAN.md §2.4). This no-op exists so the
 * code-first cron registry emits an every-minute trigger into `wrangler.jsonc`
 * (codegen owns `triggers.crons`). The real fan-out work runs
 * at the Worker edge in `src/server.ts`'s `scheduled()` on that same tick —
 * it needs `env.DISPATCHER`, which a mutation context doesn't have, so it can't
 * live in this job. SYSTEM only (cron dispatch).
 */
export const tick = internalMutation.mutation(
    // eslint-disable-next-line @typescript-eslint/require-await -- intentional no-op; only exists to register the every-minute cron trigger
    async (): Promise<{ ok: true }> => {
        return { ok: true };
    },
);
