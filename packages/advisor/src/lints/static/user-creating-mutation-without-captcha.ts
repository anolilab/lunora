import emit from "../../finding";
import type { Lint } from "../../types";
import { isPublicWrite } from "../helpers";

/**
 * Flags a public `mutation`/`action` that creates a user/session or sends mail but
 * installs no CAPTCHA / bot check.
 *
 * Endpoints that mint accounts or trigger emails are the classic automated-abuse
 * surface: credential-stuffing sign-ups, mailbox-flooding "forgot password" loops,
 * and disposable-account farming. A server-verified human check (Turnstile) in
 * front of them is the defense. Lunora ships `verifyTurnstile()` (`@lunora/auth`)
 * and the `protectPublic({ captcha })` bundle; this lint fires when a public
 * procedure writes a user/session/account-shaped table (or references `ctx.mail`)
 * with no captcha middleware.
 *
 * Runs only when the codegen feeder supplies protection evidence
 * (`context.procedureProtections`); a runtime caller with no evidence flags
 * nothing.
 */
const userCreatingMutationWithoutCaptcha: Lint = {
    categories: ["SECURITY"],
    description:
        "A public `mutation`/`action` that creates a user/session or sends mail has no CAPTCHA / bot check. Account-creating and mail-sending endpoints are prime automated-abuse targets (credential stuffing, mailbox flooding, disposable-account farming).",
    facing: "EXTERNAL",
    level: "WARN",
    name: "user_creating_mutation_without_captcha",
    remediation:
        "Add a server-verified human check: `.use(verifyTurnstile({ secret, token }))` from `@lunora/auth`, or wrap it with `.use(protectPublic({ rateLimit, captcha }))` from `@lunora/server`. Pair with a rate limit for defense in depth.",
    run: (context) => {
        if (context.procedureProtections === undefined) {
            return [];
        }

        const findings = [];

        for (const procedure of context.procedureProtections) {
            // `undefined` means the feeder couldn't read the handler body (a
            // cross-file handler) — stays fail-closed, treated as "might write a
            // user table" / "might send mail" rather than cleared.
            const sensitive = procedure.writesUserTable !== false || procedure.callsMail !== false;

            if (!isPublicWrite(procedure) || !sensitive || procedure.usesCaptcha) {
                continue;
            }

            // Reaching here, `sensitive` is true, so at least one of the two facts
            // below is `true` or `undefined` (never both provably `false`).
            const reason =
                procedure.writesUserTable === true
                    ? "writes a user/session table"
                    : procedure.callsMail === true
                      ? "sends mail"
                      : "may write a user/session table or send mail — its handler body could not be read";

            findings.push(
                emit(userCreatingMutationWithoutCaptcha, {
                    cacheKey: `user_creating_mutation_without_captcha:${procedure.file}:${procedure.exportName}`,
                    detail: `Public ${procedure.kind} \`${procedure.exportName}\` (${procedure.file}) ${reason} but has no CAPTCHA check. Add \`.use(verifyTurnstile(...))\` or \`.use(protectPublic({ captcha }))\`.`,
                    metadata: {
                        callsMail: procedure.callsMail,
                        exportName: procedure.exportName,
                        file: procedure.file,
                        kind: procedure.kind,
                        writesUserTable: procedure.writesUserTable,
                    },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Account-creating / mail-sending write without a CAPTCHA",
};

export default userCreatingMutationWithoutCaptcha;
