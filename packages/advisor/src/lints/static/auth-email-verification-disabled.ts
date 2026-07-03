import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `createAuth({...})` call with `emailAndPassword.enabled: true` and no
 * `emailAndPassword.requireEmailVerification: true`.
 *
 * better-auth defaults `requireEmailVerification` off, so an email/password
 * account is usable — signed in, able to act — the moment it's created, before
 * the caller has proven ownership of the email address. That lets an attacker
 * sign up with a victim's email (or an address they don't control) and operate
 * the account immediately, and it weakens any downstream flow (password reset,
 * account recovery) that assumes a verified address.
 *
 * Runs only when the codegen feeder supplies auth-config evidence
 * (`context.authConfigs`), and only for an analyzable config (a static,
 * spread-free object literal); an opaque config could set the key elsewhere
 * and is skipped rather than guessed at. One finding per matching `createAuth`
 * call.
 */
const authEmailVerificationDisabled: Lint = {
    categories: ["SECURITY"],
    description:
        "A `createAuth({...})` call enables `emailAndPassword` with no `requireEmailVerification: true`. better-auth defaults email verification off, so an account is usable before the caller has proven ownership of the email address.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "auth_email_verification_disabled",
    remediation: "Set `emailAndPassword.requireEmailVerification: true` on `createAuth({...})` so a new account can't act until its email address is verified.",
    run: (context) => {
        if (context.authConfigs === undefined) {
            return [];
        }

        return context.authConfigs
            .filter((config) => config.analyzable && config.emailPasswordEnabled && !config.requireEmailVerification)
            .map((config) =>
                emit(authEmailVerificationDisabled, {
                    cacheKey: `auth_email_verification_disabled:${config.file}:${config.line.toString()}`,
                    detail: `\`createAuth\` in \`${config.exportName}\` (${config.file}:${config.line.toString()}) enables \`emailAndPassword\` with no \`requireEmailVerification: true\`, so an account is usable before its email is proven. Set \`emailAndPassword.requireEmailVerification: true\`.`,
                    metadata: { exportName: config.exportName, file: config.file, line: config.line },
                }),
            );
    },
    source: "static",
    title: "createAuth email verification disabled",
};

export default authEmailVerificationDisabled;
