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
    scopeKey: string;
    target: string;
    unavailableReason?: null | string;
}

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

/**
 * The notices for one organization, from every status row: the platform's own
 * for the organization's cell only (`cell`, the cell's name, which is the
 * `cloudflare-wfp` scope), and its own connected accounts'.
 */
export const meteringNotices = (
    rows: ReadonlyArray<SourceStatusRow>,
    accounts: ReadonlyArray<{ _id: string; label: string }>,
    cell: string | undefined,
): MeteringNotice[] => {
    const accountLabel = new Map(accounts.map((account) => [account._id, account.label]));

    return rows.flatMap((row): MeteringNotice[] => {
        if (row.unavailableReason == null || row.unavailableReason === "") {
            return [];
        }

        const { family, scope } = parseScopeKey(row.scopeKey);

        if (row.target === "cloudflare-wfp") {
            // Another cell's outage is not this organization's.
            return scope === cell
                ? [
                      {
                          family,
                          message: `Lunora Cloud cannot read this usage right now: ${FAMILY_EFFECT[family]} toward your usage or spend cap until it can.`,
                          source: "Lunora Cloud",
                      },
                  ]
                : [];
        }

        const label = row.target === "cloudflare-workers" ? accountLabel.get(scope) : undefined;

        // Another organization's account, or a target with no account behind it: not this organization's to see.
        return label === undefined ? [] : [{ family, message: `${row.unavailableReason} (${FAMILY_EFFECT[family]})`, source: label }];
    });
};
