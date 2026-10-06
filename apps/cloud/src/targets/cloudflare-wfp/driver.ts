/**
 * `cloudflare-wfp` — Lunora Cloud's managed tier: one Worker per project alias
 * in a Workers-for-Platforms dispatch namespace of the cell's Cloudflare
 * account, fronted by the dispatcher Worker (`src/dispatcher/worker.ts`).
 *
 * Every tenant of a cell shares its one placement, so the driver is built per
 * env and its fleet the same. {@link createCloudflareWfpDriver} and
 * {@link createCloudflareWfpFleet} are pure over their ports, so the conformance
 * suite and the unit tests drive them with a fake box, a fake dispatch namespace
 * and a fake usage reader; the `*FromEnv` builders are the one place those
 * ports are read off the control plane's Worker env.
 */
import { tenantSender } from "../../backup/tenant-transport";
import { createHttpCloudflareApi } from "../../cloudflare/api";
import type { HostList } from "../../cloudflare/host-list";
import { createHttpHostList } from "../../cloudflare/host-list";
import type { ControlPlaneStore } from "../../d1-store";
import { edgeBlockModeOf } from "../../domains/edge-block-mode";
import { BINDING_SUPPORT } from "../../provision-contract";
import type { ProgressLine, TargetDriver, TargetFleet, UsageRow } from "../driver";
import type { ProvisionBox } from "../provision-box/client";
import { deployJobSpec, provisionBoxFrom, runProvisionJob } from "../provision-box/client";
import type { AnalyticsUsageReader } from "./analytics";
import { createHttpAnalyticsReader } from "./analytics";
import type { SaasZone } from "./certificates";
import { issueCertificate, refreshCertificate, removeCertificate } from "./certificates";
import type { DispatchNamespaceLike } from "./dispatch";
import { dispatchTenantSender } from "./dispatch";
import { reconcileEdgeBlocks } from "./edge-block";

/** The tail Worker every tenant ships its console events to (`tail.wrangler.jsonc`). */
export const TAIL_CONSUMER = "lunora-log-tail";

export interface CloudflareWfpPorts {
    /** The platform apex tenants are served under (`LUNORA_APP_DOMAIN`). */
    appDomain: string;
    /** The provision box (Alchemy 2), reached lazily: a driver that never converges never touches it. */
    box: () => ProvisionBox;
    /** This control plane's cell (`LUNORA_CELL`) — forwarded to the box with every deploy. */
    cell: string;
    /** The dispatch namespace every tenant of this environment deploys into (`LUNORA_DISPATCH_NAMESPACE`). */
    dispatchNamespace: string;

    /**
     * Receives each `log` line the provision box emits, in order. Workers Logs
     * only, never the deploy stream: Alchemy's output names the cell's Cloudflare
     * account and its resources, which are the platform's, not the tenant's.
     */
    log?: ProgressLine;

    /** The SaaS zone custom domains get their certificates in (`LUNORA_SAAS_ZONE_ID`); absent → none are issued. */
    saasZone?: SaasZone;
}

/** What a verified domain records when this control plane cannot request its certificate. */
export const UNCONFIGURED_CERTIFICATE = {
    error: "custom-domain certificates are not configured on this control plane (LUNORA_SAAS_ZONE_ID is unset)",
    sslStatus: "unconfigured",
} as const;

export const createCloudflareWfpDriver = (ports: CloudflareWfpPorts): TargetDriver => {
    return {
        // The provision box's progress goes to Workers Logs (`ports.log`), never to `onProgress`: see `log`.
        deploy: async (spec) => {
            await runProvisionJob(
                ports.box().get(spec.alias),
                {
                    action: "deploy",
                    // Crons stay off the Worker: WfP drops `triggers.crons` for namespaced Workers, so the control plane fans them out.
                    spec: deployJobSpec(spec, BINDING_SUPPORT["cloudflare-wfp"], {
                        nativeCrons: false,
                        tailConsumer: TAIL_CONSUMER,
                        target: { cell: ports.cell, dispatchNamespace: ports.dispatchNamespace, kind: "dispatch-namespace" },
                    }),
                },
                ports.log,
            );

            // The dispatcher's URL, not the box's: tenants are reached through the
            // dispatcher, so a box-reported `workers.dev` URL is not the public one.
            return { url: `https://${spec.alias}.${ports.appDomain}` };
        },
        destroy: async (alias) => {
            await runProvisionJob(
                ports.box().get(alias),
                { action: "destroy", alias, target: { cell: ports.cell, dispatchNamespace: ports.dispatchNamespace, kind: "dispatch-namespace" } },
                ports.log,
            );
        },
        domains: {
            // A verified hostname gets its certificate — and its route into the SaaS zone — here, never before.
            issue: async (domain) => (ports.saasZone === undefined ? { ...UNCONFIGURED_CERTIFICATE } : issueCertificate(ports.saasZone, domain)),
            platformTargets: () => [ports.appDomain],
        },
        id: "cloudflare-wfp",
    };
};

export interface CloudflareWfpFleetPorts {
    /** The platform apex (`LUNORA_APP_DOMAIN`), for the platform hostnames the edge block lists. */
    appDomain?: string;
    /** This control plane's cell (`LUNORA_CELL`): the one usage scope, since its Analytics Engine dataset counts every tenant here. */
    cell: string;
    /** `LUNORA_EDGE_BLOCK_DELETE_HOSTNAMES=1`: the edge block may delete a suspended org's custom hostnames (`delete-hostnames` mode). */
    deleteHostnames?: boolean;
    /** The bound dispatch namespace (`DISPATCHER`); absent → no in-network fan-out, and backups go over the public URL. */
    dispatcher?: DispatchNamespaceLike;
    /** The SaaS zone this cell issues custom-domain certificates in; absent → nothing to refresh or release. */
    saasZone?: SaasZone;
    /** The suspended-hostnames WAF list (`LUNORA_SUSPENDED_HOSTS_LIST_ID`, Enterprise-only); absent → custom-hostname removal only. */
    suspendedHostList?: HostList;
    /** The Analytics-Engine request-count reader; absent without account credentials. */
    usage?: AnalyticsUsageReader;
}

export const createCloudflareWfpFleet = (ports: CloudflareWfpFleetPorts): TargetFleet => {
    const { appDomain, cell, deleteHostnames, dispatcher, saasZone, suspendedHostList, usage } = ports;
    const dispatch = dispatcher ? (tenant: { adminToken: string; resourceRef: string }) => dispatchTenantSender(dispatcher, tenant) : undefined;

    return {
        ...(dispatch ? { dispatch } : {}),
        ...(saasZone === undefined && suspendedHostList === undefined
            ? {}
            : {
                  edgeBlock: async (database: ControlPlaneStore, options: { log: (line: string) => void; now: number }) =>
                      reconcileEdgeBlocks(database, {
                          appDomain: appDomain ?? "lunora.app",
                          deleteHostnames: deleteHostnames === true,
                          ...options,
                          ...(saasZone === undefined ? {} : { zone: saasZone }),
                          ...(suspendedHostList === undefined ? {} : { hostList: suspendedHostList }),
                      }),
              }),
        id: "cloudflare-wfp",
        // The dispatch namespace when bound — the call never leaves Cloudflare —
        // else the deployment's public URL (local dev, where namespaces are not emulated).
        reach: (tenant) => (dispatch ? dispatch(tenant) : tenantSender(tenant)),
        ...(saasZone === undefined
            ? {}
            : {
                  certificates: {
                      refresh: async (customHostnameId: string) => refreshCertificate(saasZone, customHostnameId),
                      release: async (customHostnameId: string) => removeCertificate(saasZone, customHostnameId),
                      scope: saasZone.zoneId,
                  },
              }),
        ...(usage
            ? {
                  usage: {
                      read: async (scope: string, sinceMs: number): Promise<UsageRow[]> => {
                          // This cell's dataset is the only source; another cell's scope is another control plane's.
                          if (scope !== cell) {
                              return [];
                          }

                          // The dispatcher's `index1` is the script name, which is the resource handle.
                          const rows = await usage.readRequestUsage(sinceMs);

                          return rows.map((row) => {
                              return { requests: row.requests, resourceRef: row.scriptName };
                          });
                      },
                      scopes: () => Promise.resolve([cell]),
                  },
              }
            : {}),
    };
};

/**
 * The env slice the `cloudflare-wfp` driver reads. A `type`, not an `interface`:
 * the control plane's env types extend it and must stay assignable to
 * `Record&lt;string, unknown>`, which an interface (no implicit index signature) is not.
 */
export type CloudflareWfpEnvironment = {
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
    /** The provision box's Container DO namespace; absent → this deployment cannot converge or tear down. */
    CONTAINER_PROVISION_BOX?: unknown;
    DISPATCHER?: DispatchNamespaceLike;
    LUNORA_APP_DOMAIN?: string;
    LUNORA_CELL?: string;
    LUNORA_DISPATCH_NAMESPACE?: string;

    /**
     * `"1"` opts this cell into deleting a suspended org's custom hostnames
     * (recreated on recovery) when there is no suspended-hostnames list.
     * Destructive; see RUNBOOK §6b. Anything else → no deletion.
     */
    LUNORA_EDGE_BLOCK_DELETE_HOSTNAMES?: string;

    /**
     * The Cloudflare-for-SaaS zone (the zone of `LUNORA_APP_DOMAIN`, which custom
     * domains CNAME to) whose custom hostnames carry custom-domain certificates.
     * Unset → verified domains record that no certificate could be requested.
     */
    LUNORA_SAAS_ZONE_ID?: string;

    /**
     * An account custom list of kind `hostname` that one WAF custom rule blocks
     * (`http.host in $&lt;list>`; Enterprise-only) — the edge block for suspended
     * organizations (plan 365 W8). Unset → the edge block falls back to
     * `LUNORA_EDGE_BLOCK_DELETE_HOSTNAMES`, or to the dispatcher's 503.
     */
    LUNORA_SUSPENDED_HOSTS_LIST_ID?: string;
    /** AE dataset the dispatcher writes tenant request usage to. Defaults to `lunora_tenant_usage`. */
    USAGE_ANALYTICS_DATASET?: string;
};

/** The SaaS zone off the env, when the zone and the cell's credentials are all set. */
const saasZoneOf = (environment: CloudflareWfpEnvironment): SaasZone | undefined => {
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken, LUNORA_SAAS_ZONE_ID: zoneId } = environment;

    return accountId && apiToken && zoneId ? { api: createHttpCloudflareApi({ accountId, apiToken }), zoneId } : undefined;
};

/**
 * The one dispatch namespace tenants deploy into: the one this environment's
 * dispatcher is bound to. Deploying per kind (`lunora-preview`, `lunora-dev`) put
 * previews where no dispatcher routes, and staging's tenants outside `lunora-staging`.
 * Aliases are unique platform-wide (the ownership ledger), so kinds share it safely.
 */
export const dispatchNamespaceOf = (environment: { LUNORA_DISPATCH_NAMESPACE?: string }): string =>
    environment.LUNORA_DISPATCH_NAMESPACE ?? "lunora-production";

/** Whether this control-plane deployment can converge and tear down `cloudflare-wfp` tenants. */
export const cloudflareWfpCanConverge = (environment: CloudflareWfpEnvironment): boolean => environment.CONTAINER_PROVISION_BOX != null;

/** Build the driver off the Worker env. Lazy: nothing is touched until a member is called. */
export const cloudflareWfpDriverFromEnv = (environment: CloudflareWfpEnvironment): TargetDriver => {
    const saasZone = saasZoneOf(environment);

    return createCloudflareWfpDriver({
        appDomain: environment.LUNORA_APP_DOMAIN ?? "lunora.app",
        box: () => provisionBoxFrom(environment),
        cell: environment.LUNORA_CELL ?? "default",
        dispatchNamespace: dispatchNamespaceOf(environment),
        log: (line) => {
            // eslint-disable-next-line no-console -- the provision box's log is the platform's; Workers Logs is its only reader
            console.log("[provision]", line);
        },
        ...(saasZone === undefined ? {} : { saasZone }),
    });
};

/** Build the fleet off the Worker env. */
export const cloudflareWfpFleetFromEnv = (environment: CloudflareWfpEnvironment): TargetFleet => {
    const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = environment.CLOUDFLARE_API_TOKEN;
    const saasZone = saasZoneOf(environment);

    const listId = environment.LUNORA_SUSPENDED_HOSTS_LIST_ID;

    return createCloudflareWfpFleet({
        appDomain: environment.LUNORA_APP_DOMAIN ?? "lunora.app",
        cell: environment.LUNORA_CELL ?? "default",
        deleteHostnames: edgeBlockModeOf(environment) === "delete-hostnames",
        ...(accountId && apiToken && listId ? { suspendedHostList: createHttpHostList({ accountId, apiToken, listId }) } : {}),
        ...(environment.DISPATCHER ? { dispatcher: environment.DISPATCHER } : {}),
        ...(saasZone === undefined ? {} : { saasZone }),
        ...(accountId && apiToken
            ? { usage: createHttpAnalyticsReader({ accountId, apiToken, dataset: environment.USAGE_ANALYTICS_DATASET ?? "lunora_tenant_usage" }) }
            : {}),
    });
};
