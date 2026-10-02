/**
 * `cloudflare-wfp` — Lunora Cloud's managed tier: one Worker per project alias
 * in a Workers-for-Platforms dispatch namespace of the cell's Cloudflare
 * account, fronted by the dispatcher Worker (`src/dispatcher/worker.ts`).
 *
 * {@link createCloudflareWfpDriver} is pure over {@link CloudflareWfpPorts}, so
 * the conformance suite and the unit tests drive it with a fake box, a fake
 * dispatch namespace and a fake usage reader. {@link cloudflareWfpDriverFromEnv}
 * is the one place those ports are read off the control plane's Worker env.
 */
import { tenantSender } from "../../backup/tenant-transport";
import { sha256HexBytes } from "../../deploy/keys";
import { BINDING_SUPPORT, UNSUPPORTED_REASONS } from "../../provision-contract";
import type { TargetDriver, UsageRow } from "../driver";
import type { AnalyticsUsageReader } from "./analytics";
import { createHttpAnalyticsReader } from "./analytics";
import type { DispatchNamespaceLike } from "./dispatch";
import { dispatchTenantSender } from "./dispatch";
import type { ProvisionBox } from "./provision-box";
import { deployJobSpec, provisionBoxFrom, runProvisionJob } from "./provision-box";
import { scriptForPlatformHostname } from "./route";

/** The tail Worker every tenant ships its console events to (`tail.wrangler.jsonc`). */
export const TAIL_CONSUMER = "lunora-log-tail";

export interface CloudflareWfpPorts {
    /** The platform apex tenants are served under (`LUNORA_APP_DOMAIN`). */
    appDomain: string;
    /** The provision box (Alchemy 2), reached lazily: a driver that never converges never touches it. */
    box: () => ProvisionBox;
    /** This control plane's cell (`LUNORA_CELL`) — forwarded to the box with every deploy. */
    cell: string;
    /** The bound dispatch namespace (`DISPATCHER`); absent → no in-network fan-out, and backups go over the public URL. */
    dispatcher?: DispatchNamespaceLike;
    /** The dispatch namespace every tenant of this environment deploys into (`LUNORA_DISPATCH_NAMESPACE`). */
    dispatchNamespace: string;
    /** Receives each `log` line the provision box emits, in order. */
    onLog?: (line: string) => Promise<void> | void;
    /** The Analytics-Engine request-count reader; absent without account credentials. */
    usage?: AnalyticsUsageReader;
}

export const createCloudflareWfpDriver = (ports: CloudflareWfpPorts): TargetDriver => {
    const tenantUrl = (alias: string): string => `https://${alias}.${ports.appDomain}`;
    const { dispatcher } = ports;
    const dispatch = dispatcher ? (tenant: { adminToken: string; resourceRef: string }) => dispatchTenantSender(dispatcher, tenant) : undefined;
    const { usage } = ports;

    const bindingSupport = BINDING_SUPPORT["cloudflare-wfp"];

    return {
        bindingSupport,
        capabilities: { fanout: "dispatcher", metering: "readback" },
        deploy: async (spec) => {
            const [bundleHash] = await Promise.all([
                sha256HexBytes(spec.bundle),
                runProvisionJob(
                    ports.box().get(spec.alias),
                    {
                        action: "deploy",
                        spec: deployJobSpec(spec, bindingSupport, {
                            cell: ports.cell,
                            dispatchNamespace: ports.dispatchNamespace,
                            tailConsumer: TAIL_CONSUMER,
                        }),
                    },
                    ports.onLog,
                ),
            ]);

            // The dispatcher's URL, not the box's: tenants are reached through the
            // dispatcher, so a box-reported `workers.dev` URL is not the public one.
            return { bundleHash, url: tenantUrl(spec.alias) };
        },
        destroy: async (reference) => {
            await runProvisionJob(
                ports.box().get(reference.alias),
                { action: "destroy", alias: reference.alias, dispatchNamespace: ports.dispatchNamespace },
                ports.onLog,
            );
        },
        ...(dispatch ? { dispatch } : {}),
        domains: { platformTargets: () => [ports.appDomain] },
        id: "cloudflare-wfp",
        logs: { kind: "tail-consumer", service: TAIL_CONSUMER },
        // The dispatch namespace when bound — the call never leaves Cloudflare —
        // else the deployment's public URL (local dev, where namespaces are not emulated).
        reach: (tenant) => (dispatch ? dispatch(tenant) : tenantSender(tenant)),
        route: async (hostname, lookup) => {
            const platform = scriptForPlatformHostname(hostname, ports.appDomain);
            const scriptName = platform === undefined ? await lookup.customDomain(hostname.toLowerCase()) : platform;

            return scriptName !== null && (await lookup.live(scriptName)) ? { resourceRef: scriptName } : null;
        },
        tenantUrl,
        unsupportedReasons: UNSUPPORTED_REASONS["cloudflare-wfp"],
        ...(usage
            ? {
                  usage: async (sinceMs: number): Promise<UsageRow[]> => {
                      // The dispatcher's `index1` is the script name, which is the resource handle.
                      const rows = await usage.readRequestUsage(sinceMs);

                      return rows.map((row) => {
                          return { requests: row.requests, resourceRef: row.scriptName };
                      });
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
    /** AE dataset the dispatcher writes tenant request usage to. Defaults to `lunora_tenant_usage`. */
    USAGE_ANALYTICS_DATASET?: string;
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

export const cloudflareWfpDriverFromEnv = (environment: CloudflareWfpEnvironment, options: { onLog?: (line: string) => void } = {}): TargetDriver => {
    const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = environment.CLOUDFLARE_API_TOKEN;

    return createCloudflareWfpDriver({
        appDomain: environment.LUNORA_APP_DOMAIN ?? "lunora.app",
        box: () => provisionBoxFrom(environment),
        cell: environment.LUNORA_CELL ?? "default",
        dispatchNamespace: dispatchNamespaceOf(environment),
        ...(environment.DISPATCHER ? { dispatcher: environment.DISPATCHER } : {}),
        ...(options.onLog ? { onLog: options.onLog } : {}),
        ...(accountId && apiToken
            ? { usage: createHttpAnalyticsReader({ accountId, apiToken, dataset: environment.USAGE_ANALYTICS_DATASET ?? "lunora_tenant_usage" }) }
            : {}),
    });
};
