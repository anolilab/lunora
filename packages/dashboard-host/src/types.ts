/** Config injected into the dashboard document before the bundle loads. */
export interface DashboardHtmlConfig {
    /** Admin token sent with admin requests; omitted (and not injected) when unset. */
    readonly adminToken?: string;
    /** Router basepath the dashboard mounts under (e.g. `/__cirrus`, or `/` for a root server). */
    readonly basePath: string;
    /** URL the dashboard bundle is served from (absolute, host-relative). */
    readonly scriptSrc: string;
    /** URL the compiled stylesheet is served from (absolute, host-relative). */
    readonly styleHref: string;
}

/** Minimal logger surface both Vite's `Logger` and the CLI's logger satisfy. */
export interface WarnLogger {
    warnOnce?: (message: string) => void;
}

/** Prebuilt dashboard asset bytes, resolved from `@cirrus/dashboard`'s dist. */
export interface DashboardAssets {
    readonly script: Buffer;
    readonly styles: Buffer;
}
