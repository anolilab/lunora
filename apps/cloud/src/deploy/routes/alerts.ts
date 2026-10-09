/**
 * `POST /v1/alerts/test` — `session`: send one alert rule a test notification,
 * through its real channel, and answer with the real outcome.
 *
 * `alerts.prepareTestAlert` decides (owners/admins, throttled, audited) and
 * renders; this route sends, because a mutation has no `fetch`. Answering with
 * the send's own error — a webhook's 404, a mailer refusal, "no owner has an
 * address" — is the point: a wrong destination is found now, by the person who
 * typed it, instead of during the incident the rule exists for.
 */
import type { D1DatabaseLike } from "@lunora/d1";

import { api } from "../../../lunora/_generated/api.js";
import type { TestAlert } from "../../../lunora/alerts";
import type { AuthEnv } from "../../auth";
import { authUserEmails } from "../../auth";
import { controlPlaneDatabase } from "../../d1-store";
import { deliverAlert } from "../../mail/notify";
import { ORG_ADMINS_DESTINATION, orgAdminEmails } from "../../telemetry/recipients";
import type { RouterEnv } from "./shared";
import { jsonError, rejected, requireContext } from "./shared";

/** What the route sends with and resolves recipients through; real by default, faked in tests. */
export interface AlertTestDeps {
    adminEmails: (environment: RouterEnv, organizationId: string) => Promise<string[]>;
    deliver: (environment: RouterEnv, alert: TestAlert, recipients?: ReadonlyArray<string>) => Promise<void>;
}

const defaultDeps: AlertTestDeps = {
    adminEmails: async (environment, organizationId) => {
        const { DB } = environment;

        return DB ? orgAdminEmails(controlPlaneDatabase(DB as D1DatabaseLike), organizationId, authUserEmails(environment as AuthEnv)) : [];
    },
    deliver: deliverAlert,
};

/** `POST /v1/alerts/test` with `{ organizationId, ruleId }`: `{ ok: true, recipients? }`, or the send's error. */
export const handleAlertTestRoute = async (request: Request, environment: RouterEnv, deps: AlertTestDeps = defaultDeps): Promise<Response> => {
    const body = (await request.json().catch(() => null)) as null | { organizationId?: unknown; ruleId?: unknown };

    if (typeof body?.organizationId !== "string" || typeof body.ruleId !== "string") {
        return jsonError(400, "organizationId and ruleId are required");
    }

    let alert: TestAlert;

    try {
        alert = await requireContext(environment).runMutation<TestAlert>(api.alerts.prepareTestAlert, {
            organizationId: body.organizationId,
            ruleId: body.ruleId,
        });
    } catch (error) {
        return rejected(error, "test alert refused");
    }

    const recipients =
        alert.channel === "email" && alert.destination === ORG_ADMINS_DESTINATION ? await deps.adminEmails(environment, alert.organizationId) : undefined;

    try {
        await deps.deliver(environment, alert, recipients);
    } catch (error) {
        // 502: the request was fine; the rule's destination is what failed.
        return Response.json({ error: error instanceof Error ? error.message : "the test notification could not be delivered", ok: false }, { status: 502 });
    }

    return Response.json({ ok: true, ...(recipients === undefined ? {} : { recipients }) });
};
