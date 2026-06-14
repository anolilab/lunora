/**
 * Dispatcher routing (CLOUD-PLAN.md §2.1). Resolves an inbound hostname to the
 * dispatch-namespace script that serves it. Tenant scripts are reachable at
 * `{scriptName}.{appDomain}` (the same URL the provisioner mints), so the
 * subdomain label *is* the script id; custom domains resolve through an injected
 * lookup (backed by Cloudflare for SaaS + the control plane).
 */

export interface TenantRoute {
    scriptName: string;
}

export interface ResolveTenantOptions {
    /** The platform apex, e.g. `cirrus.app`. */
    appDomain: string;
    /** Resolve a custom (non-apex) hostname to a script id, or null if unknown. */
    resolveCustomDomain?: (hostname: string) => Promise<null | string>;
}

export const resolveTenant = async (hostname: string, options: ResolveTenantOptions): Promise<null | TenantRoute> => {
    const host = hostname.toLowerCase();
    const suffix = `.${options.appDomain.toLowerCase()}`;

    if (host.endsWith(suffix)) {
        const label = host.slice(0, -suffix.length);

        // Single-label subdomains only (`proj.cirrus.app`, not `a.b.cirrus.app`).
        return label !== "" && !label.includes(".") ? { scriptName: label } : null;
    }

    const custom = await options.resolveCustomDomain?.(host);

    return custom ? { scriptName: custom } : null;
};
