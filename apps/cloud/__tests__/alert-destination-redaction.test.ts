import { describe, expect, it } from "vitest";

import type { Id } from "../lunora/_generated/dataModel";
import { list, rules } from "../lunora/alerts";
import { makeCtx } from "./_helpers/fake-ctx";

/**
 * A rule's destination is a credential for Slack and PagerDuty, and an address for
 * email. Owners and admins read it; members below admin get the row with the
 * destination redacted, so the page still lists the rules.
 */

const ORG = "org_1" as Id<"organizations">;

const member = (role: string) => {
    return { _id: "m1", createdAt: 1, organizationId: ORG, role, userId: "usr_me" };
};

const rule = { _id: "rule_1", createdAt: 1, destination: "https://hooks.slack.test/T0/B0/secret", name: "Errors", organizationId: ORG };

const alert = { _id: "alert_1", createdAt: 1, destination: "https://hooks.slack.test/T0/B0/secret", organizationId: ORG };

describe("alert destination redaction", () => {
    it.each(["owner", "admin"])("lets a %s read the destination of a rule and of a fired alert", async (role) => {
        const { ctx } = makeCtx({ alertRules: [rule], alerts: [alert], members: [member(role)] }, { userId: "usr_me" });

        await expect(rules.handler(ctx, { organizationId: ORG })).resolves.toMatchObject([{ destination: rule.destination }]);
        await expect(list.handler(ctx, { organizationId: ORG })).resolves.toMatchObject([{ destination: alert.destination }]);
    });

    it.each(["member", "viewer"])("redacts the destination for a %s but keeps the row", async (role) => {
        const { ctx } = makeCtx({ alertRules: [rule], alerts: [alert], members: [member(role)] }, { userId: "usr_me" });

        const redactedRules = await rules.handler(ctx, { organizationId: ORG });
        const redactedAlerts = await list.handler(ctx, { organizationId: ORG });

        expect(redactedRules).toMatchObject([{ _id: "rule_1", destination: "redacted", name: "Errors" }]);
        expect(redactedAlerts).toMatchObject([{ _id: "alert_1", destination: "redacted" }]);
    });
});
