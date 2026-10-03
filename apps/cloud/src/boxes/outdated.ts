/**
 * The outdated-box alert (plan 458 W7, the security floor): a box whose celld is
 * not the newest stable `lunora-hostd` release's for more than
 * {@link OUTDATED_ALERT_AFTER_MS} raises an alert. celld patches only its latest
 * release (`MULTIPLATFORM.md` §7.8), so a box left behind is a security
 * finding; the studio already flags it (`boxes.list` → `outdated`).
 *
 * Fired through the `deploy` alert rules, exactly as a failed build or
 * deployment is (`fireDeployRules`), and delivered by the alert drain. One alert
 * per box per release: the row's `hash` names both, and a box that already has
 * one is skipped — so the hourly sweep never repeats it, while a newer release
 * the box also misses raises a new one.
 *
 * "Outdated since" is the later of when the newest stable release was stored and
 * when the box enrolled: a box enrolled on an old celld has not been behind for
 * longer than it has existed.
 */
import type { BoxVersions } from "@lunora/hostd/protocol";

import type { ControlPlaneDatabase } from "../store";
import { drainTable } from "../store";
import type { AlertChannel, DeployRule } from "../telemetry/alerts";
import { fireDeployRules } from "../telemetry/alerts";
import type { StoredReleaseSummary } from "./hostd-releases";
import { newestStableRelease } from "./hostd-releases";

/** How long a box may run an older celld before it alerts. */
export const OUTDATED_ALERT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** The `boxes` columns the sweep reads. `.global()` rows answer SQL NULL for an unset column. */
interface OutdatedBoxRow {
    _id: string;
    createdAt: number;
    enrolledAt?: null | number;
    name: string;
    organizationId: string;
    slug: string;
    status: string;
    versions?: null | BoxVersions;
}

interface DeployRuleRow {
    _id: string;
    channel: AlertChannel;
    destination: string;
    enabled: boolean;
    name: string;
}

/** The fingerprint that makes the alert once-per-box-per-release. */
export const outdatedBoxHash = (boxId: string, releaseId: string): string => `box-outdated:${boxId}:${releaseId}`;

/** Raise the outdated-box alerts that are due. Answers how many alert rows it inserted. */
export const runOutdatedBoxAlerts = async (database: ControlPlaneDatabase, options: { now: number }): Promise<{ fired: number }> => {
    const latest = newestStableRelease(await drainTable<StoredReleaseSummary>(database, "hostdReleases"));

    if (latest === undefined) {
        return { fired: 0 };
    }

    const boxes = await drainTable<OutdatedBoxRow>(database, "boxes");
    const due = boxes.filter(
        (box) =>
            box.status !== "revoked" &&
            box.versions != null &&
            box.versions.celld !== latest.versions.celld &&
            options.now - Math.max(latest.createdAt, box.enrolledAt ?? box.createdAt) > OUTDATED_ALERT_AFTER_MS,
    );
    let fired = 0;

    for (const box of due) {
        const hash = outdatedBoxHash(box._id, latest.releaseId);
        // eslint-disable-next-line no-await-in-loop -- a handful of outdated boxes per tick; sequential keeps the writer simple
        const { page: existing } = await database.findMany("alerts", { limit: 1, where: { hash, organizationId: box.organizationId } });

        if (existing.length > 0) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- see above
        const { page: rules } = await database.findMany("alertRules", { where: { organizationId: box.organizationId, target: "deploy" } });
        const enabled: DeployRule[] = (rules as DeployRuleRow[])
            .filter((rule) => rule.enabled)
            .map((rule) => {
                return { channel: rule.channel, destination: rule.destination, name: rule.name, ruleId: rule._id };
            });

        // eslint-disable-next-line no-await-in-loop -- see above
        fired += await fireDeployRules(
            enabled,
            {
                detail:
                    `The box runs celld ${box.versions?.celld ?? "?"}; the newest stable lunora-hostd release (${latest.releaseId}) ships celld ` +
                    `${latest.versions.celld}. celld patches only its latest release, so this box no longer receives security fixes. ` +
                    "Roll the release out to it, or re-run the installer on the machine.",
                kind: "box",
                project: box.name,
                reference: box.slug,
            },
            { hash, now: options.now, organizationId: box.organizationId },
            (row) => database.insert("alerts", row),
        );
    }

    return { fired };
};
