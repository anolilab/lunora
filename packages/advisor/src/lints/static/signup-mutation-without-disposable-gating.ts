import emit from "../../finding";
import type { Lint } from "../../types";
import { isPublicWrite } from "../helpers";

/**
 * Flags a public `mutation`/`action` that creates a user/session/account row but
 * installs no email-domain gate.
 *
 * Account-minting endpoints are the classic throwaway-signup surface: disposable
 * mailboxes farm free trials, evade bans, and pollute the user table. Lunora
 * ships `emailGateMiddleware` (`@lunora/auth/email-guard`) — pure-data on the
 * default (edge-safe) path — that rejects disposable domains at signup. This lint
 * fires when a public procedure writes a user/session/account-shaped table with
 * no email gate, pairing with the existing `user_creating_mutation_without_captcha`
 * lint (a CAPTCHA stops bots; the email gate stops throwaway domains — both are
 * worth having).
 *
 * Runs only when the codegen feeder supplies protection evidence
 * (`context.procedureProtections`); a runtime caller with no evidence flags
 * nothing.
 */
const signupMutationWithoutDisposableGating: Lint = {
    categories: ["SECURITY"],
    description:
        "A public `mutation`/`action` that creates a user/session/account row has no disposable-email gate. Throwaway mailboxes farm free trials, evade bans, and pollute the user table.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "signup_mutation_without_disposable_gating",
    remediation:
        "Add `.use(emailGateMiddleware({ email: (ctx) => ctx.args.email }))` from `@lunora/auth/email-guard` to reject disposable domains at signup, or gate better-auth's native signup with `withEmailGate(...)` / `emailGateDatabaseHooks(...)`.",
    run: (context) => {
        if (context.procedureProtections === undefined) {
            return [];
        }

        const findings = [];

        for (const procedure of context.procedureProtections) {
            if (!isPublicWrite(procedure) || !procedure.writesUserTable || procedure.usesEmailGate) {
                continue;
            }

            findings.push(
                emit(signupMutationWithoutDisposableGating, {
                    cacheKey: `signup_mutation_without_disposable_gating:${procedure.file}:${procedure.exportName}`,
                    detail: `Public ${procedure.kind} \`${procedure.exportName}\` (${procedure.file}) writes a user/session/account table but has no disposable-email gate. Add \`.use(emailGateMiddleware(...))\` from \`@lunora/auth/email-guard\`.`,
                    metadata: {
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
    title: "Account-creating write without a disposable-email gate",
};

export default signupMutationWithoutDisposableGating;
