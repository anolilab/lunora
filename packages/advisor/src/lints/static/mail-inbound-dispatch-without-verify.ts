import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `createInboundEmailHandler({...})` built without a `verify` hook.
 *
 * An inbound email handler receives mail from the public internet, where the
 * `from` address is trivially spoofable and the DKIM/SPF/DMARC verdicts are only
 * meaningful if the handler actually checks them. The `verify` hook is where that
 * check belongs. Omit it and the handler trusts every message it receives — and
 * when the handler dispatches into a Lunora function (which runs under the admin
 * bearer, with RLS disabled), a forged sender can drive privileged writes: a
 * confused-deputy escalation reachable by anyone who can send an email.
 *
 * Runs only when the codegen feeder supplies config-call evidence
 * (`context.configCalls`); a runtime caller flags nothing. Skips calls whose
 * config wasn't a static object literal. One finding per unverified handler.
 */
const mailInboundDispatchWithoutVerify: Lint = {
    categories: ["SECURITY"],
    description:
        "`createInboundEmailHandler({...})` has no `verify` hook, so it trusts every inbound message — the `from` address is spoofable and DKIM/SPF/DMARC verdicts go unchecked. If the handler dispatches into a Lunora function (admin bearer, RLS disabled), a forged sender can drive privileged writes (a confused-deputy escalation).",
    facing: "EXTERNAL",
    level: "ERROR",
    // eslint-disable-next-line no-secrets/no-secrets -- the lint's rule id, not a credential
    name: "mail_inbound_dispatch_without_verify",
    remediation:
        "Pass a `verify` hook to `createInboundEmailHandler({...})` that rejects the message unless its DKIM/SPF/DMARC authentication verdicts pass and the sender is expected — before any dispatch into a Lunora function. Never trust the `from` header alone.",
    run: (context) => {
        if (context.configCalls === undefined) {
            return [];
        }

        return context.configCalls
            .filter((call) => call.callee === "createInboundEmailHandler" && call.analyzable && !call.presentKeys.includes("verify"))
            .map((call) =>
                emit(mailInboundDispatchWithoutVerify, {
                    // eslint-disable-next-line no-secrets/no-secrets -- the lint's rule id, not a credential
                    cacheKey: `mail_inbound_dispatch_without_verify:${call.file}:${call.line.toString()}`,
                    detail: `\`createInboundEmailHandler({...})\` in ${call.file}:${call.line.toString()} has no \`verify\` hook — it trusts the spoofable \`from\` address and unchecked DKIM/SPF/DMARC verdicts. A forged sender can then reach whatever the handler dispatches to (a Lunora function runs with the admin bearer and RLS disabled). Add a \`verify\` gate that enforces the authentication verdicts before dispatch.`,
                    metadata: { callee: call.callee, file: call.file, line: call.line },
                }),
            );
    },
    source: "static",
    title: "Inbound email handler without a verify hook",
};

export default mailInboundDispatchWithoutVerify;
