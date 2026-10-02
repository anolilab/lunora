/**
 * The box sweep (plan 458 G13): keeps the platform's box zone and the boxes'
 * sessions in step with the `boxes` table, whatever path changed the table.
 *
 * Two passes, both idempotent:
 *
 * 1. **Retire the boxes of organizations due for erasure.** `purgeDeleted` (a
 *    Lunora cron, inside a mutation) hard-deletes an organization's `boxes`
 *    rows, but a mutation reaches neither a box's session nor Cloudflare's API.
 *    So, at the same cutoff, this marks those boxes `revoked` and closes their
 *    sessions first; pass 2 then removes their records. The Worker runs this
 *    sweep right before its own crons on the six-hourly tick the purge rides,
 *    so the rows are retired before they are erased.
 * 2. **Reconcile the zone** (`reconcileBoxDns`): the zone is listed, THEN the
 *    boxes are read again (so a box enrolled mid-sweep is live, not an orphan),
 *    and every box record whose slug has no box that is not revoked is deleted — a revoke made through any
 *    path, a purge, a record a failed revoke left behind — and every live box's
 *    records are (re)written, with the outcome recorded on its `dnsError`.
 *
 * Without the box zone configured, pass 2 is skipped with a log line; pass 1
 * still runs, because a deleted organization's boxes must be cut off either way.
 */
import { DELETION_RETENTION_MS } from "../lib/deletion-retention";
import type { ControlPlaneDatabase } from "../store";
import { drainTable } from "../store";
import type { BoxDnsReconcileResult, BoxDnsZone } from "../targets/celld-vps/dns";
import { reconcileBoxDns } from "../targets/celld-vps/dns";

/**
 * Whether an hourly tick at `scheduledTime` is one the six-hourly trigger
 * (`0 *\/6 * * *`) also fires on. Cloudflare delivers the two expressions as
 * separate, concurrent `scheduled()` invocations, and the six-hourly one runs
 * this sweep ahead of the org purge — so the hourly one stands down on those
 * hours rather than run a second, overlapping pass against the same zone.
 */
export const sixHourlyTickRunsBoxSweep = (scheduledTime: number): boolean => new Date(scheduledTime).getUTCHours() % 6 === 0;

/** Creates and deletes one pass may issue against the zone — well inside Cloudflare's API rate limit. */
export const MAX_DNS_WRITES_PER_SWEEP = 200;

/** The `boxes` columns the sweep reads. `.global()` rows answer SQL NULL for an unset column. */
interface SweepBoxRow {
    _id: string;
    dnsError?: null | string;
    ipv4?: null | string;
    ipv6?: null | string;
    organizationId: string;
    slug: string;
    status: string;
}

export interface BoxSweepPorts {
    database: ControlPlaneDatabase;
    /** The box zone, or why this control plane cannot write it (`boxDnsFromEnv`). */
    dns: BoxDnsZone;
    log: (line: string) => void;
    now: number;
    /** Close a revoked box's session (`retireBox`): `null` once closed, else why not. */
    retire: (boxId: string) => Promise<null | string>;
}

export interface BoxSweepResult {
    /** What the zone pass did; `undefined` when the zone is not configured or could not be listed. */
    dns?: Omit<BoxDnsReconcileResult, "outcomes">;
    /** Boxes revoked because their organization is due for erasure. */
    retired: number;
}

/**
 * Pass 1: revoke and disconnect every live box of an organization whose
 * deletion passed the retention window. Answers the ids it revoked.
 */
const retireBoxesOfErasedOrganizations = async (ports: BoxSweepPorts, boxes: SweepBoxRow[]): Promise<Set<string>> => {
    const due = await drainTable<{ _id: string }>(ports.database, "organizations", {
        where: { deletionRequestedAt: { lt: ports.now - DELETION_RETENTION_MS } },
    });
    const erased = new Set(due.map((organization) => organization._id));
    const retired = new Set<string>();

    for (const box of boxes) {
        if (box.status === "revoked" || !erased.has(box.organizationId)) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- one patch per box of an erased org; small
        await ports.database.patch(box._id, { revokedAt: ports.now, status: "revoked" }, "boxes");
        retired.add(box._id);

        // eslint-disable-next-line no-await-in-loop -- see above
        const failure = await ports.retire(box._id);

        // The session also re-reads the row every liveness tick and closes on a revoked or missing one.
        if (failure !== null) {
            ports.log(`[boxes] could not close the session of box ${box._id}: ${failure}`);
        }
    }

    return retired;
};

export const runBoxSweep = async (ports: BoxSweepPorts): Promise<BoxSweepResult> => {
    const retiredIds = await retireBoxesOfErasedOrganizations(ports, await drainTable<SweepBoxRow>(ports.database, "boxes"));
    const retired = retiredIds.size;

    if ("unavailable" in ports.dns) {
        ports.log(`[boxes] box DNS reconcile skipped: ${ports.dns.unavailable}`);

        return { retired };
    }

    // Read again, AFTER the zone listing (`reconcileBoxDns` calls this once it has
    // listed): a box enrolled since pass 1 must be in the live set, or its fresh
    // records read as an orphan's. Pass 1's revokes count whatever the re-read says.
    let boxes: SweepBoxRow[] = [];
    const readLive = async () => {
        boxes = await drainTable<SweepBoxRow>(ports.database, "boxes");

        return boxes
            .filter((box) => box.status !== "revoked" && !retiredIds.has(box._id))
            .map((box) => {
                return { boxId: box._id, slug: box.slug, ...(box.ipv4 == null ? {} : { ipv4: box.ipv4 }), ...(box.ipv6 == null ? {} : { ipv6: box.ipv6 }) };
            });
    };

    let reconciled: BoxDnsReconcileResult;

    try {
        reconciled = await reconcileBoxDns(ports.dns.api, {
            domain: ports.dns.domain,
            live: readLive,
            maxWrites: MAX_DNS_WRITES_PER_SWEEP,
            zoneId: ports.dns.zoneId,
        });
    } catch (error) {
        // The listing itself failed: nothing was changed, and the next tick tries again.
        ports.log(`[boxes] box DNS reconcile failed: ${error instanceof Error ? error.message : String(error)}`);

        return { retired };
    }

    const current = new Map(boxes.map((box) => [box._id, box.dnsError ?? null]));

    for (const [boxId, dnsError] of reconciled.outcomes) {
        if (current.get(boxId) !== dnsError) {
            // eslint-disable-next-line no-await-in-loop -- only boxes whose outcome changed are written
            await ports.database.patch(boxId, { dnsError }, "boxes");
        }
    }

    for (const failure of reconciled.orphanFailures) {
        ports.log(`[boxes] ${failure}`);
    }

    return {
        dns: {
            created: reconciled.created,
            deleted: reconciled.deleted,
            orphanFailures: reconciled.orphanFailures,
            writesCapped: reconciled.writesCapped,
            zoneTruncated: reconciled.zoneTruncated,
        },
        retired,
    };
};
