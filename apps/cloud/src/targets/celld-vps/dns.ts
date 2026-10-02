/**
 * A box's hostnames in the platform's own zone (plan 458 D9, G13):
 *
 * - `*.{slug}.{LUNORA_BOX_DOMAIN}` — every tenant on the box,
 *   `{alias}.{slug}.{LUNORA_BOX_DOMAIN}`;
 * - `{slug}.{LUNORA_BOX_DOMAIN}` — the box itself, which a custom domain
 *   CNAMEs to.
 *
 * Each gets an A record for the box's IPv4 and an AAAA record for its IPv6,
 * DNS-only, written at enrolment and removed at revocation. Both operations
 * are idempotent — they converge the zone on what the box row says, so a
 * retried enrolment or revocation is safe.
 *
 * The zone is the platform's own, not a tenant's: that is why this file may use
 * the Cloudflare REST port at all (the boundary fence in `eslint.config.js`).
 * The cell's `CLOUDFLARE_API_TOKEN` needs Zone → DNS:Edit on it.
 */
import { BOX_SLUG_PATTERN } from "../../boxes/enrolment";
import type { CloudflareApi, DnsRecord } from "../../cloudflare/api";
import { createHttpCloudflareApi } from "../../cloudflare/api";

/** Where a box's records live, and what they point at. */
export interface BoxDnsTarget {
    /** The apex (`LUNORA_BOX_DOMAIN`). */
    domain: string;
    ipv4?: string;
    ipv6?: string;
    slug: string;
    /** The zone holding `domain` (`LUNORA_BOX_ZONE_ID`). */
    zoneId: string;
}

const namesOf = (target: Pick<BoxDnsTarget, "domain" | "slug">): string[] => [`*.${target.slug}.${target.domain}`, `${target.slug}.${target.domain}`];

/** Make the zone hold exactly the box's A/AAAA records under its two names. */
export const syncBoxDns = async (api: CloudflareApi, target: BoxDnsTarget): Promise<void> => {
    const wanted: { content: string; type: "A" | "AAAA" }[] = [
        ...(target.ipv4 === undefined ? [] : [{ content: target.ipv4, type: "A" as const }]),
        ...(target.ipv6 === undefined ? [] : [{ content: target.ipv6, type: "AAAA" as const }]),
    ];

    for (const name of namesOf(target)) {
        // eslint-disable-next-line no-await-in-loop -- two names; sequential keeps the zone's write order obvious
        const listed = await api.listDnsRecords({ name, zoneId: target.zoneId });
        const existing = listed.filter((record) => record.type === "A" || record.type === "AAAA");

        for (const record of existing) {
            if (!wanted.some((want) => want.type === record.type && want.content === record.content)) {
                // eslint-disable-next-line no-await-in-loop -- a stale record per name, at most two
                await api.deleteDnsRecord({ id: record.id, zoneId: target.zoneId });
            }
        }

        for (const want of wanted) {
            if (!existing.some((record) => record.type === want.type && record.content === want.content)) {
                // eslint-disable-next-line no-await-in-loop -- one record per address family
                await api.createDnsRecord({ content: want.content, name, type: want.type, zoneId: target.zoneId });
            }
        }
    }
};

/** Remove every A/AAAA record under the box's two names. */
export const removeBoxDns = async (api: CloudflareApi, target: Pick<BoxDnsTarget, "domain" | "slug" | "zoneId">): Promise<void> => {
    for (const name of namesOf(target)) {
        // eslint-disable-next-line no-await-in-loop -- two names
        const existing = await api.listDnsRecords({ name, zoneId: target.zoneId });

        for (const record of existing.filter((candidate) => candidate.type === "A" || candidate.type === "AAAA")) {
            // eslint-disable-next-line no-await-in-loop -- at most two per name
            await api.deleteDnsRecord({ id: record.id, zoneId: target.zoneId });
        }
    }
};

/** A box whose records should exist: not revoked. */
export interface LiveBoxDns {
    boxId: string;
    ipv4?: string;
    ipv6?: string;
    slug: string;
}

/** What one reconcile pass did. */
export interface BoxDnsReconcileResult {
    /** Records written for live boxes that were missing or pointed elsewhere. */
    created: number;
    /** Records removed: orphans of boxes that are revoked or gone, and stale addresses of live ones. */
    deleted: number;
    /** Failures that belong to no box row — an orphan record that could not be removed. */
    orphanFailures: string[];
    /** Per live box whose names were visited: `null` when converged, else why not — for `boxes.dnsError`. */
    outcomes: Map<string, null | string>;
    /** The write budget ran out; the rest converges on the next pass. */
    writesCapped: boolean;
    /** The zone listing was cut at its page bound, so missing records were not created this pass. */
    zoneTruncated: boolean;
}

/** Longest DNS failure kept on a box row (`boxes.recordDns`'s bound). */
export const MAX_DNS_ERROR = 256;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const WILDCARD_PREFIX = /^\*\./u;

/**
 * The box slug a record belongs to, or `null` for anything that is not one of
 * the two names {@link syncBoxDns} writes: `{slug}.{domain}` or
 * `*.{slug}.{domain}`, with `slug` in the minted shape, A or AAAA. The apex,
 * deeper names, other labels and other record types are someone else's.
 */
export const boxSlugOfRecord = (record: Pick<DnsRecord, "name" | "type">, domain: string): null | string => {
    if (record.type !== "A" && record.type !== "AAAA") {
        return null;
    }

    const name = record.name.toLowerCase();
    const suffix = `.${domain.toLowerCase()}`;

    if (!name.endsWith(suffix)) {
        return null;
    }

    const label = name.slice(0, -suffix.length).replace(WILDCARD_PREFIX, "");

    return BOX_SLUG_PATTERN.test(label) ? label : null;
};

/** One write a reconcile pass plans; `boxId` is absent for an orphan's record. */
type DnsOperation =
    { boxId?: string; kind: "delete"; record: DnsRecord } | { boxId: string; content: string; kind: "create"; name: string; type: "A" | "AAAA" };

/** The address records a live box should have, per family. */
const wantedOf = (box: LiveBoxDns): { content: string; type: "A" | "AAAA" }[] => [
    ...(box.ipv4 === undefined ? [] : [{ content: box.ipv4, type: "A" as const }]),
    ...(box.ipv6 === undefined ? [] : [{ content: box.ipv6, type: "AAAA" as const }]),
];

/** The writes that converge one live box's two names on its addresses. */
const planLiveBox = (box: LiveBoxDns, existing: ReadonlyArray<DnsRecord>, domain: string, allowCreate: boolean): DnsOperation[] => {
    const wanted = wantedOf(box);
    const operations: DnsOperation[] = [];

    for (const name of namesOf({ domain, slug: box.slug })) {
        const atName = existing.filter((record) => record.name.toLowerCase() === name.toLowerCase());
        const same = (want: { content: string; type: string }, record: DnsRecord): boolean => want.type === record.type && want.content === record.content;

        for (const record of atName.filter((candidate) => !wanted.some((want) => same(want, candidate)))) {
            operations.push({ boxId: box.boxId, kind: "delete", record });
        }

        for (const want of allowCreate ? wanted.filter((candidate) => !atName.some((record) => same(candidate, record))) : []) {
            operations.push({ boxId: box.boxId, content: want.content, kind: "create", name, type: want.type });
        }
    }

    return operations;
};

/** Every write a pass needs: orphans' records first (the security half), then the live boxes'. */
const planBoxDns = (records: ReadonlyArray<DnsRecord>, domain: string, live: ReadonlyArray<LiveBoxDns>, allowCreate: boolean): DnsOperation[] => {
    const liveSlugs = new Set(live.map((box) => box.slug));
    const bySlug = new Map<string, DnsRecord[]>();

    for (const record of records) {
        const slug = boxSlugOfRecord(record, domain);

        if (slug !== null) {
            bySlug.set(slug, [...(bySlug.get(slug) ?? []), record]);
        }
    }

    const orphans: DnsOperation[] = [...bySlug]
        .filter(([slug]) => !liveSlugs.has(slug))
        .flatMap(([, owned]) =>
            owned.map((record): DnsOperation => {
                return { kind: "delete", record };
            }),
        );

    return [...orphans, ...live.flatMap((box) => planLiveBox(box, bySlug.get(box.slug) ?? [], domain, allowCreate))];
};

/** Run one planned write: `null` when it took, else what went wrong. */
const applyOperation = async (api: CloudflareApi, zoneId: string, operation: DnsOperation): Promise<null | string> => {
    try {
        await (operation.kind === "delete"
            ? api.deleteDnsRecord({ id: operation.record.id, zoneId })
            : api.createDnsRecord({ content: operation.content, name: operation.name, type: operation.type, zoneId }));

        return null;
    } catch (error) {
        return operation.kind === "delete"
            ? `could not remove ${operation.record.type} ${operation.record.name}: ${errorText(error)}`
            : `could not write ${operation.type} ${operation.name}: ${errorText(error)}`;
    }
};

/**
 * Converge the whole box sub-domain on the `boxes` table (plan 458 G13): delete
 * every box record whose slug has no live box — a revoked or purged box's
 * hostnames must not keep pointing at an address its owner may since have
 * released (a subdomain takeover under our zone) — and (re)write the records of
 * every live box.
 *
 * Only records {@link boxSlugOfRecord} claims are ever touched, and at most
 * `maxWrites` creates and deletes happen per pass. When the listing was cut at
 * its page bound nothing is created, since a "missing" record may sit on a page
 * not read; deletes of listed orphans are still safe.
 *
 * `live` is read AFTER the zone is listed, and that order is what keeps a box
 * enrolled mid-pass from losing its records: enrolment inserts the box row
 * before it writes the records, so any record the listing saw belongs to a row
 * that already existed when `live` was read. Read the other way round, a box
 * enrolled between the two reads has records in the listing and no row in the
 * live set — an orphan, deleted.
 */
export const reconcileBoxDns = async (
    api: CloudflareApi,
    input: { domain: string; live: () => Promise<ReadonlyArray<LiveBoxDns>>; maxWrites: number; zoneId: string },
): Promise<BoxDnsReconcileResult> => {
    const { records, truncated } = await api.listDnsRecordsUnder({ domain: input.domain, zoneId: input.zoneId });
    const live = await input.live();
    const operations = planBoxDns(records, input.domain, live, !truncated);
    const executed = operations.slice(0, input.maxWrites);
    const failures = new Map<string, string[]>(live.map((box) => [box.boxId, []]));
    const result: BoxDnsReconcileResult = {
        created: 0,
        deleted: 0,
        orphanFailures: [],
        outcomes: new Map(),
        writesCapped: operations.length > executed.length,
        zoneTruncated: truncated,
    };

    for (const operation of executed) {
        // eslint-disable-next-line no-await-in-loop -- sequential and budgeted: the zone API is rate-limited
        const failure = await applyOperation(api, input.zoneId, operation);

        if (failure === null) {
            result[operation.kind === "delete" ? "deleted" : "created"] += 1;
        } else if (operation.boxId === undefined) {
            result.orphanFailures.push(failure);
        } else {
            failures.get(operation.boxId)?.push(failure);
        }
    }

    // A box with writes the budget cut off is not converged yet: its outcome waits for the pass that finishes it.
    const unfinished = new Set(operations.slice(executed.length).flatMap((operation) => (operation.boxId === undefined ? [] : [operation.boxId])));

    for (const [boxId, messages] of failures) {
        if (!unfinished.has(boxId)) {
            result.outcomes.set(boxId, messages.length === 0 ? null : messages.join("; ").slice(0, MAX_DNS_ERROR));
        }
    }

    return result;
};

/** The env slice box DNS reads. */
export type BoxDnsEnvironment = {
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
    LUNORA_BOX_DOMAIN?: string;
    /** The zone of `LUNORA_BOX_DOMAIN`; unset → boxes enrol without hostnames, and say so on their row. */
    LUNORA_BOX_ZONE_ID?: string;
};

/** The REST port and zone for box DNS, or why this control plane cannot write it. */
export type BoxDnsZone = { api: CloudflareApi; domain: string; zoneId: string } | { unavailable: string };

/** The REST port and zone for box DNS, or why this control plane cannot write it. */
export const boxDnsFromEnv = (environment: BoxDnsEnvironment): BoxDnsZone => {
    if (!environment.LUNORA_BOX_ZONE_ID) {
        return { unavailable: "box DNS is not configured on this control plane (LUNORA_BOX_ZONE_ID is unset)" };
    }

    if (!environment.CLOUDFLARE_API_TOKEN) {
        return { unavailable: "box DNS needs CLOUDFLARE_API_TOKEN with Zone → DNS:Edit on the box zone" };
    }

    return {
        // The account id only prefixes account-scoped paths; DNS calls are zone-scoped.
        api: createHttpCloudflareApi({ accountId: environment.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: environment.CLOUDFLARE_API_TOKEN }),
        domain: environment.LUNORA_BOX_DOMAIN ?? "boxes.lunora.app",
        zoneId: environment.LUNORA_BOX_ZONE_ID,
    };
};
