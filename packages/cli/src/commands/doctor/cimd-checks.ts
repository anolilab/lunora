/**
 * `lunora doctor`'s CIMD check (plan 461). `workersCimdFetch()` from
 * `@lunora/auth/cimd/workers` fetches client metadata from URLs a client chose,
 * so it only builds when the Worker runs with `global_fetch_strictly_public`.
 * This check finds a deploy that would throw at startup instead.
 */
import type { WranglerConfig } from "@lunora/config/cloudflare";
import { GLOBAL_FETCH_STRICTLY_PUBLIC_FLAG } from "@lunora/config/cloudflare";

import type { Finding } from "./handler";

/**
 * `@lunora/auth/cimd/workers` imported, but a deployable config lacks the
 * `global_fetch_strictly_public` flag → WARN (`cimd-fetch-not-strictly-public`).
 *
 * Without the flag, `fetch` from the Worker can reach private addresses, so the
 * CIMD transport refuses to build — every request that constructs the auth
 * instance then fails at startup. Each `env.<name>` that declares its own
 * `compatibility_flags` replaces the top-level list, so it is checked on its own.
 * WARN rather than FAIL because usage is inferred from an import, which an
 * unused import can trip.
 */
const checkCimdFetchFlag = (parsed: WranglerConfig | undefined, usesCimdWorkers: boolean, findings: Finding[]): void => {
    if (parsed === undefined || !usesCimdWorkers) {
        return;
    }

    const missing: string[] = [];

    if (!(parsed.compatibility_flags ?? []).includes(GLOBAL_FETCH_STRICTLY_PUBLIC_FLAG)) {
        missing.push("the top level");
    }

    for (const [name, environment] of Object.entries(parsed.env ?? {})) {
        if (environment.compatibility_flags !== undefined && !environment.compatibility_flags.includes(GLOBAL_FETCH_STRICTLY_PUBLIC_FLAG)) {
            missing.push(`env.${name}`);
        }
    }

    if (missing.length > 0) {
        findings.push({
            code: "cimd-fetch-not-strictly-public",
            fix: `Add "${GLOBAL_FETCH_STRICTLY_PUBLIC_FLAG}" to "compatibility_flags" in wrangler.jsonc.`,
            level: "warn",
            message: `@lunora/auth/cimd/workers is imported, but ${missing.join(", ")} of wrangler.jsonc lacks the ${GLOBAL_FETCH_STRICTLY_PUBLIC_FLAG} compatibility flag — workersCimdFetch() refuses to build without it.`,
        });
    }
};

export default checkCimdFetchFlag;
