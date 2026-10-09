/**
 * What the Usage tab says about a metering source that cannot read
 * (`usage.meteringStatus`). It is read off the `usageSourceStatus` rows the
 * readback sweep keeps per (target, scope, family).
 *
 * An organization sees two kinds of source:
 *
 * - The platform's own (`cloudflare-wfp`), worded for the customer. The
 *   operator's reason stays in the control plane's log and on the row.
 * - Its own connected accounts (`cloudflare-workers`), with the reason itself,
 *   because the fix is usually that organization's token.
 */
import type { UsageFamily } from "../targets/driver";
import { USAGE_FAMILIES } from "../targets/driver";

/** One source the Usage tab warns about. */
export interface MeteringNotice {
    family: UsageFamily;
    message: string;
    /** Which account: `Lunora Cloud`, or the connected account's label. */
    source: string;
}

/** A `usageSourceStatus` row as the notices read it. `.global()` rows answer SQL NULL for unset columns. */
export interface SourceStatusRow {
    failingSince?: null | number;
    gapNote?: null | string;
    gapRecordedAt?: null | number;
    lastError?: null | string;
    scopeKey: string;
    target: string;
    unavailableReason?: null | string;
}

/** How long a source's reads must have failed in a row before the Usage tab says so; a blip is retried quietly. */
export const FAILING_NOTICE_MS = 3 * 60 * 60 * 1000;

/** How long a span too old to read is mentioned after it was skipped. */
export const GAP_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;

/** The scope and family a `scopeKey` (`usageScopeKey`) names. */
export const parseScopeKey = (scopeKey: string): { family: UsageFamily; scope: string } => {
    const separator = scopeKey.lastIndexOf("#");
    const family = scopeKey.slice(separator + 1);

    return separator !== -1 && (USAGE_FAMILIES as ReadonlyArray<string>).includes(family)
        ? { family: family as UsageFamily, scope: scopeKey.slice(0, separator) }
        : { family: "requests", scope: scopeKey };
};

/** What a family's missing usage means for the organization. */
const FAMILY_EFFECT: Record<UsageFamily, string> = {
    d1: "D1 rows read and written are not counted",
    durableObjects: "Durable Object rows read and written are not counted",
    requests: "requests are not counted",
};

/** What is wrong with a source right now, worded for whoever owns the account, or `undefined` when nothing is. */
const problemOf = (row: SourceStatusRow, now: number): undefined | { own: string; platform: string } => {
    if (row.unavailableReason != null && row.unavailableReason !== "") {
        return { own: row.unavailableReason, platform: "Lunora Cloud cannot read this usage right now" };
    }

    if (row.failingSince != null && now - row.failingSince >= FAILING_NOTICE_MS) {
        const since = new Date(row.failingSince).toISOString();

        return {
            own: `not read since ${since}: ${row.lastError ?? "the read keeps failing"}`,
            platform: `Lunora Cloud has not been able to read this usage since ${since}`,
        };
    }

    if (row.gapNote != null && row.gapRecordedAt != null && now - row.gapRecordedAt < GAP_NOTICE_MS) {
        return { own: row.gapNote, platform: `Lunora Cloud could not read some of this usage: ${row.gapNote}` };
    }

    return undefined;
};

/**
 * The notices for one organization, from every status row: the platform's own
 * for the organization's cell only (`cell`, the cell's name, which is the
 * `cloudflare-wfp` scope), and its own connected accounts'. A source is shown
 * when it cannot read at all, when its reads have failed for
 * {@link FAILING_NOTICE_MS}, or for {@link GAP_NOTICE_MS} after a span too old
 * to read was skipped.
 */
export const meteringNotices = (
    rows: ReadonlyArray<SourceStatusRow>,
    accounts: ReadonlyArray<{ _id: string; label: string }>,
    cell: string | undefined,
    now: number,
): MeteringNotice[] => {
    const accountLabel = new Map(accounts.map((account) => [account._id, account.label]));

    return rows.flatMap((row): MeteringNotice[] => {
        const problem = problemOf(row, now);

        if (problem === undefined) {
            return [];
        }

        const { family, scope } = parseScopeKey(row.scopeKey);

        if (row.target === "cloudflare-wfp") {
            // Another cell's outage is not this organization's.
            return scope === cell
                ? [{ family, message: `${problem.platform}: ${FAMILY_EFFECT[family]} toward your usage or spend cap until it can.`, source: "Lunora Cloud" }]
                : [];
        }

        const label = row.target === "cloudflare-workers" ? accountLabel.get(scope) : undefined;

        // Another organization's account, or a target with no account behind it: not this organization's to see.
        return label === undefined ? [] : [{ family, message: `${problem.own} (${FAMILY_EFFECT[family]})`, source: label }];
    });
};
