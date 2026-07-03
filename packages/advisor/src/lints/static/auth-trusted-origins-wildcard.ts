import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `createAuth({...})` call whose `trustedOrigins` array literal
 * contains a `"*"` entry.
 *
 * better-auth's `trustedOrigins` is the allowlist its CSRF/origin validation
 * checks every state-changing request against. A `"*"` entry disables that
 * check entirely — any origin is accepted, which is exactly the protection
 * Lunora leans on to keep cross-site requests from riding an authenticated
 * cookie.
 *
 * Runs only when the codegen feeder supplies auth-config evidence
 * (`context.authConfigs`), and only for an analyzable config (a static,
 * spread-free object literal); an opaque config could set `trustedOrigins`
 * elsewhere and is skipped rather than guessed at. One finding per matching
 * `createAuth` call.
 */
const authTrustedOriginsWildcard: Lint = {
    categories: ["SECURITY"],
    description:
        "A `createAuth({...})` call's `trustedOrigins` array contains a `\"*\"` entry, disabling better-auth's CSRF/origin validation entirely — any origin is accepted for state-changing auth requests.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "auth_trusted_origins_wildcard",
    remediation: "List the specific origins your deployment serves in `trustedOrigins` instead of `\"*\"` — a wildcard disables origin validation for every caller.",
    run: (context) => {
        if (context.authConfigs === undefined) {
            return [];
        }

        return context.authConfigs
            .filter((config) => config.analyzable && config.trustedOriginsWildcard)
            .map((config) =>
                emit(authTrustedOriginsWildcard, {
                    cacheKey: `auth_trusted_origins_wildcard:${config.file}:${config.line.toString()}`,
                    detail: `\`createAuth\` in \`${config.exportName}\` (${config.file}:${config.line.toString()}) sets \`trustedOrigins\` to include \`"*"\`, disabling CSRF/origin validation for every request. List the specific origins your deployment serves instead.`,
                    metadata: { exportName: config.exportName, file: config.file, line: config.line },
                }),
            );
    },
    source: "static",
    title: "createAuth trustedOrigins wildcard",
};

export default authTrustedOriginsWildcard;
