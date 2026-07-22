import { createMailerFromEnv } from "@lunora/mail";

import type { AlertChannel } from "../telemetry/alerts";
import { isSafeWebhookUrl, webhookRequestFor } from "../telemetry/alerts";

/**
 * Transactional email for the control plane (CLOUD-PLAN.md §3). Built on
 * `@lunora/mail`'s env-driven mailer: a Resend transport in production (or the
 * Worker `send_email` binding), captured into the studio Mail tab in dev. These
 * run at the Worker edge (the deploy router), where `env` is available — Lunora
 * mutations can't do I/O, so the email is sent here rather than inside the
 * `invitations.invite` mutation.
 */

export interface InvitationEmail {
    /** The one-time accept link carrying the invite token. */
    acceptUrl: string;
    /** Optional organization name for the copy. */
    organizationName?: string;
    /** Invitee address. */
    to: string;
}

/** Send a team-invitation email with the one-time accept link. */
export const sendInvitationEmail = async (env: Record<string, unknown>, invitation: InvitationEmail): Promise<void> => {
    const org = invitation.organizationName ? ` to ${invitation.organizationName}` : "";

    await createMailerFromEnv(env).send({
        subject: `You've been invited${org} on Lunora Cloud`,
        text: `You've been invited${org} on Lunora Cloud.\n\nAccept your invitation:\n${invitation.acceptUrl}`,
        to: invitation.to,
    });
};

/** A fired alert to deliver over its rule's channel. */
export interface AlertNotification {
    /** Rendered notification body. */
    body: string;
    channel: AlertChannel;
    /** Email address (`email`), webhook/Slack URL, or PagerDuty routing key. */
    destination: string;
    /** Notification subject / summary line. */
    subject: string;
}

/**
 * Deliver a fired Observability alert over its channel. `email` goes through the
 * same env-driven mailer as invitations; every other channel is a typed JSON
 * POST whose URL + body come from {@link webhookRequestFor} (`webhook` → plain
 * `{ subject, body }`, `slack` → incoming-webhook message, `pagerduty` → Events
 * API v2 event to the fixed PagerDuty endpoint). Runs at the Worker edge; throws
 * on transport failure so the caller can mark the alert failed (best-effort — a
 * failed send never blocks ingest).
 */
export const deliverAlert = async (env: Record<string, unknown>, alert: AlertNotification): Promise<void> => {
    if (alert.channel === "email") {
        await createMailerFromEnv(env).send({ subject: alert.subject, text: alert.body, to: alert.destination });

        return;
    }

    const request = webhookRequestFor(alert);

    // Defense in depth against SSRF: never fetch an unsafe destination, even if
    // one slipped past `createRule` (e.g. a rule created before this guard). The
    // fixed PagerDuty endpoint clears the same guard, so every channel goes through it.
    if (!isSafeWebhookUrl(request.url)) {
        throw new Error("unsafe webhook destination");
    }

    const response = await fetch(request.url, {
        body: request.body,
        headers: { "content-type": "application/json" },
        method: "POST",
        // `isSafeWebhookUrl` only vets the original URL, so a vetted public host that
        // 3xx-redirects to an internal address (e.g. the metadata IP) would still be
        // an SSRF sink if we followed it. `redirect: "manual"` surfaces the redirect
        // here instead of the runtime chasing the `Location` header.
        redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
        throw new Error("unsafe webhook redirect");
    }
};
