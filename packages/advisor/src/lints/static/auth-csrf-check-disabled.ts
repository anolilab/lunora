import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `createAuth({...})` call whose `advanced.disableCSRFCheck` is
 * explicitly `true`.
 *
 * better-auth's CSRF check validates the request's origin against
 * `trustedOrigins` before applying a state-changing auth mutation (sign-in,
 * sign-up, session revocation, …). `disableCSRFCheck: true` turns that check
 * off outright, so a cross-site request riding the browser's ambient auth
 * cookie is processed the same as a same-origin one — the standard CSRF
 * exposure.
 *
 * Runs only when the codegen feeder supplies auth-config evidence
 * (`context.authConfigs`), and only for an analyzable config (a static,
 * spread-free object literal); an opaque config could set the key elsewhere
 * and is skipped rather than guessed at. One finding per matching `createAuth`
 * call.
 */
const authCsrfCheckDisabled: Lint = {
    categories: ["SECURITY"],
    description:
        "A `createAuth({...})` call sets `advanced.disableCSRFCheck: true`, turning off better-auth's origin validation for state-changing auth requests — a cross-site request riding the ambient auth cookie is processed like a same-origin one.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "auth_csrf_check_disabled",
    remediation: "Remove `advanced.disableCSRFCheck: true` from `createAuth({...})` and rely on `trustedOrigins` for origin validation instead of disabling the check.",
    run: (context) => {
        if (context.authConfigs === undefined) {
            return [];
        }

        return context.authConfigs
            .filter((config) => config.analyzable && config.disableCsrfCheck)
            .map((config) =>
                emit(authCsrfCheckDisabled, {
                    cacheKey: `auth_csrf_check_disabled:${config.file}:${config.line.toString()}`,
                    detail: `\`createAuth\` in \`${config.exportName}\` (${config.file}:${config.line.toString()}) sets \`advanced.disableCSRFCheck: true\`, turning off origin validation for state-changing auth requests. Remove the flag and rely on \`trustedOrigins\` instead.`,
                    metadata: { exportName: config.exportName, file: config.file, line: config.line },
                }),
            );
    },
    source: "static",
    title: "createAuth CSRF check disabled",
};

export default authCsrfCheckDisabled;
