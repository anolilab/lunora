/**
 * `cloudflare-workers` — bring-your-own Cloudflare (MULTIPLATFORM.md Phase 3):
 * a project runs as a plain Worker (no dispatch namespace) in a Cloudflare
 * account its organization connected (`lunora/cloudflare-accounts.ts`), on that
 * account's `workers.dev` subdomain: `https://{alias}.{subdomain}.workers.dev`.
 *
 * Converging is the same provision box and Alchemy program `cloudflare-wfp`
 * uses, with an `account` target: the job carries the account id and the
 * organization's token, unsealed here at the edge, and the box converges the
 * project's resources and its Worker in THAT account — while the Alchemy state
 * stays in the platform's own account (MULTIPLATFORM.md §5.3). The Worker
 * carries its own cron triggers and is its own queue consumer, so nothing is
 * fanned out to it (`fanout: "native"`).
 *
 * Metering reads each connected account's GraphQL Analytics API back
 * (`metering: "readback"`), one usage scope per account, for display: the
 * requests are on the customer's Cloudflare bill, so the rows are never billed
 * (`isBillableUsage`).
 *
 * {@link createCloudflareWorkersDriver} and {@link createCloudflareWorkersFleet}
 * are pure over their ports; the `*FromEnv` builders are the one place those
 * ports are read off the Worker env.
 */
import type { D1DatabaseLike } from "@lunora/d1";
import { LunoraError } from "@lunora/server";

import { tenantSender } from "../../backup/tenant-transport";
import { controlPlaneDatabase } from "../../d1-store";
import { BINDING_SUPPORT } from "../../provision-contract";
import { decryptSecret } from "../../secrets/crypto";
import type { ProgressLine, TargetDriver, TargetFleet } from "../driver";
import type { AccountPlacement } from "../placement";
import type { ProvisionBox } from "../provision-box/client";
import { deployJobSpec, provisionBoxFrom, runProvisionJob } from "../provision-box/client";
import type { ProvisionTarget } from "../provision-box/contract";
import type { ScriptRequests } from "./api";
import { readScriptRequests } from "./api";

/** The connected account's unsealed token. Lives for one converge or one readback, in-process. */
export type AccountCredentials = (accountRowId: string) => Promise<{ accountId: string; apiToken: string }>;

export interface CloudflareWorkersPorts {
    /** The connected account this driver converges into — the project's placement. */
    account: AccountPlacement;
    /** The provision box, reached lazily: a driver that never converges never touches it. */
    box: () => ProvisionBox;
    /** Unseal the account's token (`cloudflareAccounts` → `SECRET_ENCRYPTION_KEY`). */
    credentials: AccountCredentials;
    /** The provision box's log lines — Workers Logs only, as on `cloudflare-wfp`. */
    log?: ProgressLine;
}

/** The public URL of `alias` in an account: its Worker on the account's `workers.dev` subdomain. */
export const workersDevUrl = (alias: string, workersSubdomain: string): string => `https://${alias}.${workersSubdomain}.workers.dev`;

export const createCloudflareWorkersDriver = (ports: CloudflareWorkersPorts): TargetDriver => {
    const { account } = ports;

    const target = async (): Promise<ProvisionTarget> => {
        const credentials = await ports.credentials(account.id);

        // Rotating is refused across accounts, so this only guards drift; converging into another account would strand the tenant.
        if (credentials.accountId !== account.accountId) {
            throw new LunoraError("CONFLICT", `the connected token is for account ${credentials.accountId}, not ${account.accountId}`);
        }

        return { accountId: account.accountId, apiToken: credentials.apiToken, kind: "account" };
    };

    return {
        deploy: async (spec) => {
            await runProvisionJob(
                ports.box().get(spec.alias),
                // No tail consumer: the platform's runs in its own account and cannot be attached to a Worker in the customer's.
                { action: "deploy", spec: deployJobSpec(spec, BINDING_SUPPORT["cloudflare-workers"], { nativeCrons: true, target: await target() }) },
                ports.log,
            );

            return { url: workersDevUrl(spec.alias, account.workersSubdomain) };
        },
        destroy: async (alias) => {
            await runProvisionJob(ports.box().get(alias), { action: "destroy", alias, target: await target() }, ports.log);
        },
        // A hostname CNAMEd at the account's workers.dev subdomain. Serving it needs a
        // Custom Domain on the customer's zone, which is not wired yet (TARGETS limitations).
        domains: { platformTargets: () => [`${account.workersSubdomain}.workers.dev`] },
        id: "cloudflare-workers",
    };
};

/** Requests per script in one connected account since a moment — the GraphQL Analytics API. */
export type AccountUsageReader = (access: { accountId: string; apiToken: string }, sinceMs: number) => Promise<ScriptRequests[]>;

export interface CloudflareWorkersFleetPorts {
    /** The connected accounts this control plane meters — one usage scope each — by row id. */
    accounts: () => Promise<string[]>;
    credentials: AccountCredentials;
    read: AccountUsageReader;
}

export const createCloudflareWorkersFleet = (ports: CloudflareWorkersFleetPorts): TargetFleet => {
    return {
        id: "cloudflare-workers",
        // A tenant answers on its public workers.dev URL; nothing of the platform sits in front of it.
        reach: (tenant) => tenantSender(tenant),
        usage: {
            read: async (scope, sinceMs) => {
                const metered = await ports.accounts();

                if (!metered.includes(scope)) {
                    return [];
                }

                const credentials = await ports.credentials(scope);
                const rows = await ports.read(credentials, sinceMs);

                // Qualified by the account (`deployments.resourceRef`), so a script in this
                // account can only ever be attributed to a deployment placed in it.
                return rows.map((row) => {
                    return { requests: row.requests, resourceRef: `${scope}/${row.scriptName}` };
                });
            },
            scopes: ports.accounts,
        },
    };
};

/**
 * The env slice the `cloudflare-workers` driver reads. A `type`, not an
 * `interface`, so the control plane's env types stay assignable to it.
 */
export type CloudflareWorkersEnvironment = {
    /** The provision box's Container DO namespace; absent → this deployment cannot converge or tear down. */
    CONTAINER_PROVISION_BOX?: unknown;
    DB?: unknown;
    LUNORA_CELL?: string;
    /** Unseals each connected account's token. */
    SECRET_ENCRYPTION_KEY?: string;
};

interface AccountRow {
    _id: string;
    accountId: string;
    ciphertext: string;
    iv: string;
    organizationId: string;
    permissions: string[];
}

/** Unseal a connected account's token off the control-plane store. */
const credentialsFrom =
    (environment: CloudflareWorkersEnvironment): AccountCredentials =>
    async (accountRowId) => {
        if (environment.DB == null || !environment.SECRET_ENCRYPTION_KEY) {
            throw new LunoraError(
                "SERVICE_UNAVAILABLE",
                "this control plane cannot unseal connected Cloudflare accounts (DB or SECRET_ENCRYPTION_KEY missing)",
            );
        }

        const row = (await controlPlaneDatabase(environment.DB as D1DatabaseLike).get(accountRowId, "cloudflareAccounts")) as AccountRow | null;

        if (row === null) {
            throw new LunoraError(
                "CONFLICT",
                "this project's Cloudflare account is no longer connected; connect it again and choose it in the project's settings",
            );
        }

        return { accountId: row.accountId, apiToken: await decryptSecret(environment.SECRET_ENCRYPTION_KEY, { ciphertext: row.ciphertext, iv: row.iv }) };
    };

/**
 * The connected accounts THIS control plane meters: those of organizations
 * placed on its cell (every cell runs the same sweep, and an account read by
 * two would be counted twice), whose token was seen to hold Account Analytics
 * Read. An account without it is never read — its usage chart stays empty
 * rather than an hourly failure.
 */
const meteredAccountsFrom = (environment: CloudflareWorkersEnvironment) => async (): Promise<string[]> => {
    if (environment.DB == null || !environment.SECRET_ENCRYPTION_KEY) {
        return [];
    }

    const database = controlPlaneDatabase(environment.DB as D1DatabaseLike);
    const { page: cells } = await database.findMany("cells", { where: { name: environment.LUNORA_CELL ?? "default" } });
    const cell = (cells as { _id: string }[]).at(0);

    if (cell === undefined) {
        return [];
    }

    const { page: organizations } = await database.findMany("organizations", { where: { cellId: cell._id } });
    const scopes: string[] = [];

    for (const organization of organizations as { _id: string }[]) {
        // eslint-disable-next-line no-await-in-loop -- one indexed read per organization of this cell; an hourly sweep
        const { page } = await database.findMany("cloudflareAccounts", { where: { organizationId: organization._id } });

        scopes.push(...(page as AccountRow[]).filter((row) => row.permissions.includes("analytics")).map((row) => row._id));
    }

    return scopes;
};

/** Whether this control-plane deployment can converge and tear down `cloudflare-workers` tenants. */
export const cloudflareWorkersCanConverge = (environment: CloudflareWorkersEnvironment): boolean =>
    environment.CONTAINER_PROVISION_BOX != null && environment.DB != null && Boolean(environment.SECRET_ENCRYPTION_KEY);

/** Build the driver for one connected account off the Worker env. Lazy: nothing is touched until a member is called. */
export const cloudflareWorkersDriverFromEnv = (account: AccountPlacement, environment: CloudflareWorkersEnvironment): TargetDriver =>
    createCloudflareWorkersDriver({
        account,
        box: () => provisionBoxFrom(environment),
        credentials: credentialsFrom(environment),
        log: (line) => {
            // eslint-disable-next-line no-console -- the provision box's log stays in Workers Logs, as on cloudflare-wfp
            console.log("[provision]", line);
        },
    });

/** Build the fleet off the Worker env. */
export const cloudflareWorkersFleetFromEnv = (environment: CloudflareWorkersEnvironment): TargetFleet =>
    createCloudflareWorkersFleet({
        accounts: meteredAccountsFrom(environment),
        credentials: credentialsFrom(environment),
        read: (access, sinceMs) => readScriptRequests(access, sinceMs),
    });
