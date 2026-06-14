/**
 * Dispatcher routing (CLOUD-PLAN.md §2.1). Resolves an inbound hostname to the
 * dispatch-namespace script that serves it. Tenant scripts are reachable at
 * `{scriptName}.{appDomain}` (the same URL the provisioner mints), so the
 * subdomain label *is* the script id; custom domains resolve through an injected
 * lookup (backed by Cloudflare for SaaS + the control plane).
 */

export interface TenantRoute {
    /** Plan name (free/pro/enterprise) the tenant is on, for runtime limits. */
    plan?: string;
    scriptName: string;
}

export interface ResolveTenantOptions {
    /** The platform apex, e.g. `cirrus.app`. */
    appDomain: string;
    /** Resolve a custom (non-apex) hostname to a script id, or null if unknown. */
    resolveCustomDomain?: (hostname: string) => Promise<null | string>;
    /** Resolve a script id to its org's plan name (for per-plan runtime limits). */
    resolvePlan?: (scriptName: string) => Promise<string | undefined>;
}

export const resolveTenant = async (hostname: string, options: ResolveTenantOptions): Promise<null | TenantRoute> => {
    const host = hostname.toLowerCase();
    const suffix = `.${options.appDomain.toLowerCase()}`;

    const resolveScript = async (): Promise<null | string> => {
        if (host.endsWith(suffix)) {
            const label = host.slice(0, -suffix.length);

            // Single-label subdomains only (`proj.cirrus.app`, not `a.b.cirrus.app`).
            return label !== "" && !label.includes(".") ? label : null;
        }

        return (await options.resolveCustomDomain?.(host)) ?? null;
    };

    const scriptName = await resolveScript();

    if (!scriptName) {
        return null;
    }

    const plan = await options.resolvePlan?.(scriptName);

    return { plan, scriptName };
};
