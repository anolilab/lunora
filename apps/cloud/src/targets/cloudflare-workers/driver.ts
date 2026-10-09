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
 * (`metering: "readback"`), one usage scope per account: request counts, and
 * D1 and Durable Object rows (`src/cloudflare/storage-usage.ts`). They are for
 * display and anomaly detection only. The usage is on the customer's
 * Cloudflare bill, so the rows are never billed (`isBillableUsage`).
 *
 * {@link createCloudflareWorkersDriver} and {@link createCloudflareWorkersFleet}
 * are pure over their ports; the `*FromEnv` builders are the one place those
 * ports are read off the Worker env.
 */
import type { D1DatabaseLike } from "@lunora/d1";
import { LunoraError } from "@lunora/server";

import { tenantSender } from "../../backup/tenant-transport";
import type { PeriodUsage } from "../../billing/spend";
import { readD1UsageByAlias, readDurableObjectUsageByScript, unavailableOnRefusal } from "../../cloudflare/storage-usage";
import type { CloudflareAccountStore } from "../../cloudflare-accounts/store";
import { accountTableIn, cloudflareAccountStore } from "../../cloudflare-accounts/store";
import { controlPlaneDatabase } from "../../d1-store";
import { BINDING_SUPPORT } from "../../provision-contract";
import type { ProgressLine, TargetDriver, TargetFleet, UsageSource, UsageWindow } from "../driver";
import type { AccountHost } from "../placement";
import { resourceRefOf } from "../placement";
import type { ProvisionBox } from "../provision-box/client";
import { deployJobSpec, provisionBoxFrom, runProvisionJob } from "../provision-box/client";
import type { PlatformStateStore, ProvisionTarget } from "../provision-box/contract";
import { usageRows } from "../storage-sources";
import type { ScriptRequests } from "./api";
import { readScriptRequests } from "./api";

/** The connected account's unsealed token. Lives for one converge or one readback, in-process. */
export type AccountCredentials = (accountRowId: string) => Promise<{ accountId: string; apiToken: string }>;

export interface CloudflareWorkersPorts {
    /** The connected account this driver converges into — the project's placement. */
    account: AccountHost;
    /** The provision box, reached lazily: a driver that never converges never touches it. */
    box: () => ProvisionBox;
    /** Unseal the account's token (`cloudflareAccounts` → `SECRET_ENCRYPTION_KEY`). */
    credentials: AccountCredentials;
    /** The provision box's log lines — Workers Logs only, as on `cloudflare-wfp`. */
    log?: ProgressLine;
    /** The cell's Alchemy state store, where every converge of this target keeps its state; absent → this control plane cannot converge it. */
    state?: PlatformStateStore;
}

/** The public URL of `alias` in an account: its Worker on the account's `workers.dev` subdomain. */
export const workersDevUrl = (alias: string, workersSubdomain: string): string => `https://${alias}.${workersSubdomain}.workers.dev`;

export const createCloudflareWorkersDriver = (ports: CloudflareWorkersPorts): TargetDriver => {
    const { account } = ports;

    const target = async (): Promise<ProvisionTarget> => {
        const { state } = ports;

        // Never fall back to a store in the customer's account: convergence state is platform state.
        if (state === undefined) {
            throw new LunoraError(
                "SERVICE_UNAVAILABLE",
                "this control plane has no Alchemy state store configured (LUNORA_STATE_STORE_URL, LUNORA_STATE_STORE_TOKEN)",
            );
        }

        const credentials = await ports.credentials(account.id);

        // Rotating is refused across accounts, so this only guards drift; converging into another account would strand the tenant.
        if (credentials.accountId !== account.accountId) {
            throw new LunoraError("CONFLICT", `the connected token is for account ${credentials.accountId}, not ${account.accountId}`);
        }

        return { accountId: account.accountId, apiToken: credentials.apiToken, kind: "account", state };
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
        domains: { issue: () => Promise.resolve(undefined), platformTargets: () => [`${account.workersSubdomain}.workers.dev`] },
        id: "cloudflare-workers",
    };
};

/** One connected account's credentials, as the readers take them. */
type AccountAccess = { accountId: string; apiToken: string };

/** Requests per script in one connected account in `(sinceMs, untilMs]` — the GraphQL Analytics API. */
export type AccountUsageReader = (access: AccountAccess, sinceMs: number, untilMs: number) => Promise<ScriptRequests[]>;

/** Storage rows per tenant name (D1: alias; Durable Objects: script) in one connected account, in a closed window. */
export type AccountStorageReader = (access: AccountAccess, window: UsageWindow) => Promise<Map<string, PeriodUsage>>;

export interface CloudflareWorkersFleetPorts {
    /** The connected accounts this control plane meters — one usage scope each — by row id. */
    accounts: () => Promise<string[]>;
    credentials: AccountCredentials;
    read: AccountUsageReader;
    /** D1 and Durable Object rows; absent → this control plane reads only request counts. */
    storage?: { d1: AccountStorageReader; durableObjects: AccountStorageReader };
}

export const createCloudflareWorkersFleet = (ports: CloudflareWorkersFleetPorts): TargetFleet => {
    // The scope IS the account's row id — the `placementRef` its deployments
    // carry — so a script in this account can only ever be attributed to a
    // deployment placed in it (`resourceRefOf`, as `deployments.create` wrote it).
    const resourceRef = (scope: string, name: string): string => resourceRefOf({ placementRef: scope, target: "cloudflare-workers" }, name);
    // Only an account this control plane meters, with its own token.
    const accessOf = async (scope: string): Promise<AccountAccess | undefined> => {
        const metered = await ports.accounts();

        return metered.includes(scope) ? ports.credentials(scope) : undefined;
    };
    const storage = (read: AccountStorageReader): UsageSource => {
        return {
            cadence: "hourly",
            read: async (scope, window) => {
                const access = await accessOf(scope);

                return access === undefined ? [] : usageRows(await read(access, window), (name) => resourceRef(scope, name));
            },
        };
    };

    return {
        id: "cloudflare-workers",
        // A tenant answers on its public workers.dev URL; nothing of the platform sits in front of it.
        reach: (tenant) => tenantSender(tenant),
        usage: {
            scopes: ports.accounts,
            sources: {
                requests: {
                    cadence: "continuous",
                    read: async (scope, window) => {
                        const access = await accessOf(scope);

                        if (access === undefined) {
                            return [];
                        }

                        const rows = await ports.read(access, window.sinceMs, window.untilMs);

                        return rows.map((row) => {
                            return { meters: { requests: row.requests }, resourceRef: resourceRef(scope, row.scriptName) };
                        });
                    },
                },
                ...(ports.storage === undefined ? {} : { d1: storage(ports.storage.d1), durableObjects: storage(ports.storage.durableObjects) }),
            },
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
    /** The bearer token of this cell's `alchemy-state-store` (from its bootstrap). A secret. */
    LUNORA_STATE_STORE_TOKEN?: string;
    /** This cell's `alchemy-state-store` URL (`https://alchemy-state-store.{subdomain}.workers.dev`). */
    LUNORA_STATE_STORE_URL?: string;
    /** Unseals each connected account's token. */
    SECRET_ENCRYPTION_KEY?: string;
};

/** The connected accounts off the control-plane store, or `undefined` when this deployment cannot unseal them. */
const accountsOf = (environment: CloudflareWorkersEnvironment): undefined | { encryptionKey: string; store: CloudflareAccountStore } =>
    environment.DB == null || !environment.SECRET_ENCRYPTION_KEY
        ? undefined
        : {
              encryptionKey: environment.SECRET_ENCRYPTION_KEY,
              store: cloudflareAccountStore(accountTableIn(controlPlaneDatabase(environment.DB as D1DatabaseLike))),
          };

/** Unseal a connected account's token off the control-plane store. */
const credentialsFrom =
    (environment: CloudflareWorkersEnvironment): AccountCredentials =>
    async (accountRowId) => {
        const accounts = accountsOf(environment);

        if (accounts === undefined) {
            throw new LunoraError(
                "SERVICE_UNAVAILABLE",
                "this control plane cannot unseal connected Cloudflare accounts (DB or SECRET_ENCRYPTION_KEY missing)",
            );
        }

        return accounts.store.credentials(accountRowId, accounts.encryptionKey);
    };

/** The connected accounts THIS control plane meters (`meteredFor` its cell), by row id. */
const meteredAccountsFrom = (environment: CloudflareWorkersEnvironment) => async (): Promise<string[]> => {
    const accounts = accountsOf(environment);

    if (accounts === undefined) {
        return [];
    }

    const { page: cells } = await controlPlaneDatabase(environment.DB as D1DatabaseLike).findMany("cells", {
        where: { name: environment.LUNORA_CELL ?? "default" },
    });
    const cell = (cells as { _id: string }[]).at(0);

    if (cell === undefined) {
        return [];
    }

    const metered = await accounts.store.meteredFor(cell._id);

    return metered.map((row) => row._id);
};

/** This cell's Alchemy state store, when both halves are configured. */
const stateStoreOf = (environment: CloudflareWorkersEnvironment): PlatformStateStore | undefined =>
    environment.LUNORA_STATE_STORE_URL && environment.LUNORA_STATE_STORE_TOKEN
        ? { token: environment.LUNORA_STATE_STORE_TOKEN, url: environment.LUNORA_STATE_STORE_URL }
        : undefined;

/** Whether this control-plane deployment can converge and tear down `cloudflare-workers` tenants. */
export const cloudflareWorkersCanConverge = (environment: CloudflareWorkersEnvironment): boolean =>
    environment.CONTAINER_PROVISION_BOX != null &&
    environment.DB != null &&
    Boolean(environment.SECRET_ENCRYPTION_KEY) &&
    stateStoreOf(environment) !== undefined;

/** Build the driver for one connected account off the Worker env. Lazy: nothing is touched until a member is called. */
export const cloudflareWorkersDriverFromEnv = (account: AccountHost, environment: CloudflareWorkersEnvironment): TargetDriver =>
    createCloudflareWorkersDriver({
        account,
        box: () => provisionBoxFrom(environment),
        credentials: credentialsFrom(environment),
        ...(stateStoreOf(environment) === undefined ? {} : { state: stateStoreOf(environment) }),
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
        // A customer's token without the permission is shown on its account, not retried hourly as a failure.
        read: async (access, sinceMs, untilMs) => unavailableOnRefusal(async () => readScriptRequests(access, sinceMs, untilMs)),
        storage: {
            d1: async (access, window) => unavailableOnRefusal(async () => readD1UsageByAlias(access, window)),
            durableObjects: async (access, window) => unavailableOnRefusal(async () => readDurableObjectUsageByScript(access, window)),
        },
    });
