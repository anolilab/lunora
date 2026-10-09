/**
 * `lunora alerts test` — what can honestly be said about alert delivery.
 *
 * Cloudflare's API has no endpoint that sends a test notification: the
 * webhook-destination resource is create / get / update / delete / list, and
 * email has nothing at all. The dashboard's "Save and Test" on a new webhook is
 * the only test send. So this reports what the API does know — each webhook
 * destination's last successful and failed dispatch, and the notifications
 * Cloudflare actually sent for this command's policies — and never fakes a send.
 */
import type { Logger } from "../../util/logger";
import type { CloudflareClient } from "./api";
import type { Policy } from "./plan";
import { mechanismsOf, POLICY_NAME_PREFIX } from "./plan";
import { BILLING_ALERT_TYPE } from "./products";

interface WebhookDestination {
    id?: string;
    last_failure?: string;
    last_success?: string;
    name?: string;
    type?: string;
}

interface HistoryEntry {
    alert_type?: string;
    mechanism?: string;
    mechanism_type?: string;
    name?: string;
    policy_id?: string;
    sent?: string;
}

interface DeliveryReport {
    emails: string[];
    history: HistoryEntry[];
    /** Always `false`: there is no API to send a test notification. */
    testSent: false;
    webhooks: (WebhookDestination & { referenced: boolean })[];
}

const NO_TEST_SEND =
    "Cloudflare's API has no endpoint that sends a test notification — not for webhooks and not for email — so `lunora alerts test` sends nothing.";

const WEBHOOK_TEST_PATH = "To test a webhook for real, create it in the dashboard (Alerts > Destinations > Webhooks > Create) and finish with Save and Test.";

const EMAIL_NOTE = "Email destinations cannot be tested at all: Cloudflare offers no test send for them. Check the address on each policy below instead.";

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** How far back the delivery history is read. */
const HISTORY_DAYS = 30;

const reportDeliveries = async (
    client: CloudflareClient,
    policies: ReadonlyArray<Policy>,
    extraWebhooks: ReadonlyArray<string>,
    logger: Logger,
    now: Date,
): Promise<DeliveryReport> => {
    const own = policies.filter((policy) => policy.alert_type === BILLING_ALERT_TYPE && policy.name?.startsWith(POLICY_NAME_PREFIX) === true);
    const targets = own.map((policy) => mechanismsOf(policy));
    const referenced = new Set([...targets.flatMap((mechanisms) => (mechanisms["webhooks"] ?? []).map((hook) => hook.id)), ...extraWebhooks]);
    const emails = [...new Set(targets.flatMap((mechanisms) => (mechanisms["email"] ?? []).map((entry) => entry.id)))];
    const ownIds = new Set(own.map((policy) => policy.id));
    const since = new Date(now.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const [destinations, history] = await Promise.all([
        client.notifications("Listing webhook destinations", "GET", "/alerting/v3/destinations/webhooks"),
        own.length === 0
            ? Promise.resolve([])
            : client.notificationsList("Reading notification history", `/alerting/v3/history?per_page=25&since=${encodeURIComponent(since)}`),
    ]);
    const webhooks = asArray<WebhookDestination>(destinations).map((hook) => {
        return { ...hook, referenced: hook.id !== undefined && referenced.has(hook.id) };
    });
    const sent = asArray<HistoryEntry>(history).filter(
        (entry) => entry.alert_type === BILLING_ALERT_TYPE && entry.policy_id !== undefined && ownIds.has(entry.policy_id),
    );

    logger.warn(NO_TEST_SEND);

    if (own.length === 0) {
        logger.info("No `lunora alerts setup` policies exist on this account yet — run `lunora alerts setup` first.");
    }

    for (const missing of [...referenced].filter((id) => !webhooks.some((hook) => hook.id === id))) {
        logger.warn(`Webhook destination ${missing} is referenced but does not exist on this account.`);
    }

    for (const hook of webhooks.filter((entry) => entry.referenced)) {
        logger.info(
            `webhook "${hook.name ?? hook.id ?? "?"}" (${hook.type ?? "generic"}): last delivered ${hook.last_success ?? "never"}, last failed ${hook.last_failure ?? "never"}`,
        );
    }

    logger.info(WEBHOOK_TEST_PATH);

    if (emails.length > 0) {
        logger.info(`${EMAIL_NOTE} Addresses on the policies: ${emails.join(", ")}.`);
    }

    if (sent.length === 0) {
        logger.info(
            `Cloudflare's notification history shows nothing sent for these policies in the last ${String(HISTORY_DAYS)} days (they only fire once a threshold is crossed).`,
        );
    } else {
        for (const entry of sent) {
            logger.info(`sent ${entry.sent ?? "?"}: "${entry.name ?? "?"}" via ${entry.mechanism_type ?? "?"} to ${entry.mechanism ?? "?"}`);
        }
    }

    return { emails, history: sent, testSent: false, webhooks };
};

export type { DeliveryReport };
export { NO_TEST_SEND, reportDeliveries };
