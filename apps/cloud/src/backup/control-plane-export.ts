/**
 * The control plane's own D1 export, for the off-database backup sweep
 * (`./sweep.ts`, GAPS.md D1).
 *
 * This is the one place outside `src/targets/cloudflare-wfp/` that talks to the
 * Cloudflare REST API, and deliberately so: the database it exports is the
 * control plane's, which always runs on Cloudflare (MULTIPLATFORM.md §5.3). It is
 * the HOST, not a deploy target, so it does not belong behind `TargetDriver` —
 * and it is named in the import boundary in `eslint.config.js` for that reason.
 */
import { createHttpCloudflareApi } from "../cloudflare/api";

/** The env slice the export reads. */
export interface ControlPlaneExportEnvironment {
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
    /** The control-plane D1's own uuid, which the export REST call addresses (a binding cannot answer it). */
    CONTROL_PLANE_DATABASE_ID?: string;
}

/** Start-and-await one full export of the control-plane D1, or `undefined` when the account credentials or the database id are missing. */
export const controlPlaneExport = (environment: ControlPlaneExportEnvironment): (() => Promise<{ signedUrl: string }>) | undefined => {
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken, CONTROL_PLANE_DATABASE_ID: databaseId } = environment;

    if (!accountId || !apiToken || !databaseId) {
        return undefined;
    }

    const api = createHttpCloudflareApi({ accountId, apiToken });

    return () => api.exportD1Database(databaseId);
};
