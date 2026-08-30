/**
 * Raising a `deploy` alert from the EDGE, over the structural control-plane
 * store — the counterpart to `lunora/alerts.ts`'s `fireDeployAlerts`, which does
 * the same thing from inside a mutation's `ctx.db`.
 *
 * The two exist because the release path's failures are raised from both sides:
 * `builds.fail` and `deployments.updateStatus` are mutations, while the rollout
 * guard is an edge sweep holding D1 through {@link ControlPlaneDatabase}. They
 * share the rendering (`renderDeployAlert`) and the row shape; only the handle on
 * the database differs, and neither side can borrow the other's.
 *
 * Delivery is not done here either. The row is left `firing` for the drain sweep,
 * so a `deploy` alert reaches its channel by exactly one path no matter which
 * side raised it.
 */
import type { ControlPlaneDatabase } from "../store";
import type { AlertChannel, DeployAlertSource } from "./alerts";
import { renderDeployAlert } from "./alerts";

/** An `alertRules` row as the control-plane store returns it. */
interface DeployRuleRow {
    _id: string;
    channel: AlertChannel;
    destination: string;
    enabled: boolean;
    name: string;
}

/** Insert one `firing` alert per enabled `deploy` rule on the org; returns how many were raised. */
export const raiseDeployAlerts = async (
    database: ControlPlaneDatabase,
    organizationId: string,
    hash: string,
    source: DeployAlertSource,
    now: number,
): Promise<number> => {
    const { page } = await database.findMany("alertRules", { where: { organizationId, target: "deploy" } });
    const enabled = (page as DeployRuleRow[]).filter((rule) => rule.enabled);

    for (const rule of enabled) {
        const { body, subject } = renderDeployAlert(rule, source);

        // eslint-disable-next-line no-await-in-loop -- an org configures a handful of rules; sequential keeps the writer simple
        await database.insert("alerts", {
            body,
            channel: rule.channel,
            createdAt: now,
            destination: rule.destination,
            hash,
            organizationId,
            ruleId: rule._id,
            status: "firing",
            subject,
            target: "deploy",
            updatedAt: now,
        });
    }

    return enabled.length;
};
