/** Config injected into the studio document before the bundle loads. */
export interface StudioHtmlConfig {
    /** Admin token sent with admin requests; omitted (and not injected) when unset. */
    readonly adminToken?: string;
    /** Router basepath the studio mounts under (e.g. `/__cirrus`, or `/` for a root server). */
    readonly basePath: string;

    /**
     * Make the data browser editable (insert/edit/delete rows). Injected as
     * `window.__CIRRUS_DATA_EDITABLE__` for the bundle to read. The loopback-only
     * dev hosts (the Vite `/__cirrus` route, the CLI studio server) set this so a
     * developer can edit; a static deploy leaves it off (read-only) by default.
     */
    readonly dataEditable?: boolean;
    /** URL the studio bundle is served from (absolute, host-relative). */
    readonly scriptSrc: string;
    /** URL the compiled stylesheet is served from (absolute, host-relative). */
    readonly styleHref: string;
}

/** Minimal logger surface both Vite's `Logger` and the CLI's logger satisfy. */
export interface WarnLogger {
    warnOnce?: (message: string) => void;
}

/** Prebuilt studio asset bytes, resolved from `@cirrus/studio`'s dist. */
export interface StudioAssets {
    readonly script: Buffer;
    readonly styles: Buffer;
}
