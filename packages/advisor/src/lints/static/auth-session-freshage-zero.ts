import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `createAuth({...})` call whose `session.freshAge` is explicitly the
 * literal `0`.
 *
 * `freshAge` is the window better-auth treats a session as "recently
 * re-authenticated" for sensitive operations (changing the password, adding a
 * passkey, revoking other sessions, …) that gate on a fresh session rather than
 * merely a valid one. Setting it to `0` disables that recent-reauth check
 * entirely — every sensitive operation is treated as fresh regardless of how
 * old the session is, so a long-lived stolen session (or token) can perform
 * them without ever proving the caller still controls the credentials.
 *
 * Runs only when the codegen feeder supplies auth-config evidence
 * (`context.authConfigs`), and only for an analyzable config (a static,
 * spread-free object literal); an opaque config could set the key elsewhere
 * and is skipped rather than guessed at. One finding per matching `createAuth`
 * call.
 */
const authSessionFreshageZero: Lint = {
    categories: ["SECURITY"],
    description:
        "A `createAuth({...})` call sets `session.freshAge: 0`, disabling better-auth's recent-reauth check for sensitive operations — a long-lived stolen session can perform them without proving the caller still controls the credentials.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "auth_session_freshage_zero",
    remediation: "Remove `session.freshAge: 0` from `createAuth({...})` (or set it to a real window) so sensitive operations require a recently re-authenticated session.",
    run: (context) => {
        if (context.authConfigs === undefined) {
            return [];
        }

        return context.authConfigs
            .filter((config) => config.analyzable && config.sessionFreshAgeZero)
            .map((config) =>
                emit(authSessionFreshageZero, {
                    cacheKey: `auth_session_freshage_zero:${config.file}:${config.line.toString()}`,
                    detail: `\`createAuth\` in \`${config.exportName}\` (${config.file}:${config.line.toString()}) sets \`session.freshAge: 0\`, disabling the recent-reauth check for sensitive operations. Remove the override or set a real window.`,
                    metadata: { exportName: config.exportName, file: config.file, line: config.line },
                }),
            );
    },
    source: "static",
    title: "createAuth session freshAge zero",
};

export default authSessionFreshageZero;
