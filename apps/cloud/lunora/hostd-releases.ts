import { LunoraError } from "@lunora/server";

import { internalMutation, internalQuery, v } from "./_generated/server.js";
import { boundedString, LIMITS } from "./validators";

/**
 * The control plane's store of signed `lunora-hostd` releases (plan 458 G17).
 * Written only by the admin-token route `POST /v1/hostd/releases`, which
 * verifies each envelope before it gets here (`src/boxes/hostd-releases.ts`);
 * read by boxes through the box-signed manifest route and by the rollout.
 */

/** A verified envelope is at most a few KiB; this bounds a row, not a release. */
const MAX_ENVELOPE = 65_536;

interface ReleaseRow {
    _id: string;
    channel?: "canary" | "stable" | null;
    createdAt: number;
    envelope: string;
    keyId: string;
    releaseId: string;
    versions: { caddy: string; celld: string; hostd: string };
}

/** A stored release, without its envelope. */
export interface HostdReleaseView {
    channel: "canary" | "stable";
    createdAt: number;
    keyId: string;
    releaseId: string;
    versions: { caddy: string; celld: string; hostd: string };
}

const toView = (row: ReleaseRow): HostdReleaseView => {
    return { channel: row.channel ?? "stable", createdAt: row.createdAt, keyId: row.keyId, releaseId: row.releaseId, versions: row.versions };
};

/**
 * Store a VERIFIED release (SYSTEM). Idempotent for the same envelope; a
 * different envelope under a release id already stored is refused — a release
 * id names one set of bytes forever.
 */
export const store = internalMutation
    .input({
        channel: v.optional(v.union(v.literal("stable"), v.literal("canary"))),
        envelope: boundedString(MAX_ENVELOPE),
        keyId: boundedString(LIMITS.id),
        releaseId: boundedString(LIMITS.name),
        versions: v.object({ caddy: boundedString(LIMITS.id), celld: boundedString(LIMITS.id), hostd: boundedString(LIMITS.id) }),
    })
    .mutation(async ({ ctx: context, args }): Promise<{ created: boolean }> => {
        const { page } = await context.db.hostdReleases.findMany({ where: { releaseId: args.releaseId } });
        const existing = page[0] as ReleaseRow | undefined;

        if (existing) {
            if (existing.envelope !== args.envelope) {
                throw new LunoraError("CONFLICT", `release ${args.releaseId} is already stored with a different envelope`);
            }

            return { created: false };
        }

        await context.db.insert("hostdReleases", { ...args, createdAt: context.now });

        return { created: true };
    });

/** One release's signed envelope, as a box fetches it (SYSTEM — the box-signed manifest route). */
export const envelope = internalQuery
    .input({ releaseId: boundedString(LIMITS.name) })
    .query(async ({ ctx: context, args: { releaseId } }): Promise<null | string> => {
        const { page } = await context.db.hostdReleases.findMany({ where: { releaseId } });

        return (page[0] as ReleaseRow | undefined)?.envelope ?? null;
    });

/** One release, without its envelope (SYSTEM — the rollout). */
export const get = internalQuery
    .input({ releaseId: boundedString(LIMITS.name) })
    .query(async ({ ctx: context, args: { releaseId } }): Promise<HostdReleaseView | null> => {
        const { page } = await context.db.hostdReleases.findMany({ where: { releaseId } });
        const row = page[0] as ReleaseRow | undefined;

        return row ? toView(row) : null;
    });
