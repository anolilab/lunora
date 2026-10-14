import type { AdvisorCallSiteScope } from "./call-site-scope";

/**
 * One `buildImageDeliveryUrl({ key, … })` call (`@lunora/bindings/images`) whose
 * `key` — the CDN transform's source image, an absolute URL or an
 * origin-relative key — is derived from the handler's `args` with no
 * server-side scoping — the `images_url_source_from_user_input` lint input.
 */
export interface AdvisorImageDeliveryUrlAccess {
    file: string;
    line: number;
    /** Who the site runs on behalf of — see {@link AdvisorCallSiteScope}. */
    scope: AdvisorCallSiteScope;
}
