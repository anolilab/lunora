import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `createAuth({...})` call whose `advanced.useSecureCookies` is
 * explicitly `false`.
 *
 * `@lunora/auth` defaults `useSecureCookies` ON unless the deployment's
 * `baseURL` is provably plain `http://` (a local dev origin) — see
 * `hardenAuthOptions` in `packages/auth/src/create-auth.ts`. An explicit
 * `useSecureCookies: false` overrides that secure-by-default posture, so the
 * session cookie ships without the `Secure` attribute even on an HTTPS
 * deployment — it is then sent over any plaintext connection an attacker can
 * coerce (mixed-content requests, a downgraded subdomain), exposing the
 * session.
 *
 * Runs only when the codegen feeder supplies auth-config evidence
 * (`context.authConfigs`), and only for an analyzable config (a static,
 * spread-free object literal); an opaque config could set the key elsewhere
 * and is skipped rather than guessed at. One finding per matching `createAuth`
 * call.
 */
const authSecureCookiesDisabled: Lint = {
    categories: ["SECURITY"],
    description:
        "A `createAuth({...})` call sets `advanced.useSecureCookies: false`, overriding Lunora's secure-by-default posture — the session cookie ships without `Secure` even on an HTTPS deployment, so it can be sent over a plaintext connection.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "auth_secure_cookies_disabled",
    remediation: "Remove `advanced.useSecureCookies: false` from `createAuth({...})` — let Lunora's secure-by-default posture set the `Secure` cookie attribute for an HTTPS deployment.",
    run: (context) => {
        if (context.authConfigs === undefined) {
            return [];
        }

        return context.authConfigs
            .filter((config) => config.analyzable && config.secureCookiesDisabled)
            .map((config) =>
                emit(authSecureCookiesDisabled, {
                    cacheKey: `auth_secure_cookies_disabled:${config.file}:${config.line.toString()}`,
                    detail: `\`createAuth\` in \`${config.exportName}\` (${config.file}:${config.line.toString()}) sets \`advanced.useSecureCookies: false\`, so the session cookie ships without \`Secure\` even on an HTTPS deployment. Remove the override and let Lunora's secure-by-default posture apply.`,
                    metadata: { exportName: config.exportName, file: config.file, line: config.line },
                }),
            );
    },
    source: "static",
    title: "createAuth secure cookies disabled",
};

export default authSecureCookiesDisabled;
