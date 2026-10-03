/**
 * The in-network path to a `cloudflare-wfp` tenant: its script in the dispatch
 * namespace the control plane has bound as `DISPATCHER`. The cron fan-out, the
 * queue consumer and tenant backups take it, so those calls never leave
 * Cloudflare (and work for a tenant whose public hostname is down).
 */
import type { TenantSend } from "../../backup/tenant-transport";

/** The dispatch-namespace binding, as far as reaching one script goes. */
export interface DispatchNamespaceLike {
    get: (scriptName: string) => { fetch: (request: Request) => Promise<Response> };
}

/** A {@link TenantSend} for one tenant through the dispatch namespace, under its admin bearer. */
export const dispatchTenantSender = (dispatcher: DispatchNamespaceLike, tenant: { adminToken: string; resourceRef: string }): TenantSend => {
    const script = dispatcher.get(tenant.resourceRef);

    return (path, body, contentType) =>
        script.fetch(
            new Request(`https://tenant.internal${path}`, {
                body,
                headers: { authorization: `Bearer ${tenant.adminToken}`, "content-type": contentType },
                method: "POST",
            }),
        );
};
