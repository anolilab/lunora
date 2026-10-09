/**
 * `lunora cloudflare alerts` — protect a self-hosted Cloudflare account from a runaway bill.
 *
 * `status` (default) reads last month's usage and the notification policies;
 * `setup` creates or updates a Usage Based Billing notification per product,
 * well above normal; `test` reports what Cloudflare has delivered. Budget alerts
 * (an account-wide USD threshold) have no API, so every subcommand says so and
 * points at the dashboard rather than pretending to check one.
 */
import type { WranglerConfig } from "@lunora/config/cloudflare";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

import type { CloudflareEnvironment } from "../../../util/cloudflare-credentials";
import { resolveCloudflareCredentials } from "../../../util/cloudflare-credentials";
import { EXIT_CODE } from "../../../util/exit-code";
import type { CloudflareClient } from "./api";
import { createCloudflareClient, PERMISSION } from "./api";
import { reportDeliveries } from "./deliveries";
import type { AccountState, AlertsResult } from "./outcome";
import { baseData, BUDGET_ALERT_NOTE, fail, failFromError, success } from "./outcome";
import type { Policy } from "./plan";
import { discoverProducts } from "./products";
import type { SetupOptions } from "./setup";
import { readSetupInput, runSetup } from "./setup";
import runStatus from "./status";
import type { MetricUsage } from "./usage";
import { METRICS, previousMonth, readUsage } from "./usage";

type AlertsSubcommand = "setup" | "status" | "test";

interface AlertsCommandOptions extends SetupOptions {
    cwd: string;
    environment?: CloudflareEnvironment;
    fetch?: typeof globalThis.fetch;
    /** "Now", for the usage month and the history window (tests). */
    now?: Date;
    subcommand: AlertsSubcommand;
}

/** The `account_id` in the project's wrangler config, when it has a readable one. */
const wranglerAccountId = (cwd: string): unknown => {
    const path = findWranglerFile(cwd);

    return path === undefined ? undefined : readWranglerJsonc<WranglerConfig>(path).parsed?.account_id;
};

/**
 * The client, or the failure that stops the command before any call. The
 * project's deploy target is checked by the `lunora cloudflare` dispatcher.
 */
const connect = (options: AlertsCommandOptions): AlertsResult | CloudflareClient => {
    const { accountId, token } = resolveCloudflareCredentials(options.environment ?? process.env, wranglerAccountId(options.cwd));

    if (token === undefined) {
        return fail(
            options.logger,
            EXIT_CODE.AUTH,
            `CLOUDFLARE_API_TOKEN is not set. \`lunora cloudflare alerts\` calls the Cloudflare API with an API token (a wrangler login session is not reused); ` +
                `create one with the "${PERMISSION.notificationsWrite}" and "${PERMISSION.analytics}" permissions ` +
                `("${PERMISSION.notificationsRead}" is enough for status and test).`,
        );
    }

    if (accountId === undefined) {
        return fail(options.logger, EXIT_CODE.USAGE, "No Cloudflare account: set CLOUDFLARE_ACCOUNT_ID or `account_id` in wrangler.jsonc.");
    }

    return createCloudflareClient({ accountId, token, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
};

const listPolicies = async (client: CloudflareClient): Promise<Policy[]> => {
    const policies = await client.notifications("Listing notification policies", "GET", "/alerting/v3/policies");

    return Array.isArray(policies) ? (policies as Policy[]) : [];
};

/** Policies, eligible alert types and usage, read in parallel. A policy-list failure is fatal; the others degrade. */
const readAccount = async (client: CloudflareClient, options: AlertsCommandOptions): Promise<AccountState> => {
    const period = previousMonth(options.now ?? new Date());
    const { logger } = options;
    const [policies, available, usage] = await Promise.all([
        listPolicies(client),
        client.notifications("Listing the alert types this account is eligible for", "GET", "/alerting/v3/available_alerts").then(
            (value) => {
                return { ok: true as const, value };
            },
            (error: unknown) => {
                return { error, ok: false as const };
            },
        ),
        readUsage(client, period).catch((error: unknown): MetricUsage[] => {
            const reason = error instanceof Error ? error.message : String(error);

            logger.warn(`Usage could not be read: ${reason}`);

            return METRICS.map(({ id, label }) => {
                return { id, label, reason, status: "unavailable" };
            });
        }),
    ]);

    if (!available.ok) {
        logger.warn(
            `Could not read which alert types the account is eligible for: ${available.error instanceof Error ? available.error.message : String(available.error)}`,
        );
    }

    return { discovery: discoverProducts(available.ok ? available.value : undefined, available.ok, policies), period, policies, usage };
};

/** `test` needs the policies and the delivery record — never the usage read. */
const runTest = async (client: CloudflareClient, options: AlertsCommandOptions): Promise<AlertsResult> => {
    const policies = await listPolicies(client);
    const deliveries = await reportDeliveries(client, policies, options.webhooks ?? [], options.logger, options.now ?? new Date());

    options.logger.info(BUDGET_ALERT_NOTE);

    return success({ ...baseData(client), deliveries });
};

const runAlertsCommand = async (options: AlertsCommandOptions): Promise<AlertsResult> => {
    const input = options.subcommand === "setup" ? readSetupInput(options) : undefined;

    if (input !== undefined && "error" in input) {
        return fail(options.logger, EXIT_CODE.USAGE, input.error);
    }

    const client = connect(options);

    if (!("graphql" in client)) {
        return client;
    }

    try {
        if (options.subcommand === "test") {
            return await runTest(client, options);
        }

        const state = await readAccount(client, options);

        if (input === undefined) {
            return runStatus(client, state, options.logger);
        }

        return await runSetup(client, state, options, input);
    } catch (error) {
        return failFromError(options.logger, error);
    }
};

export type { AlertsCommandOptions, AlertsSubcommand };
export { runAlertsCommand };
