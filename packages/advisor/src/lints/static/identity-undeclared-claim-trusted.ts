import emit from "../../finding";
import type { AdvisorIdentityClaimRead } from "../../identity-claim-reads";
import type { Lint } from "../../types";

/**
 * Flags an authorization read of an identity claim that is **not** in the app's
 * declared `defineIdentity({ ... })` contract.
 *
 * `defineIdentity` is the trust boundary for `ctx.auth.identity`: the worker
 * validates a resolver's returned claims against the *declared* validators, but
 * — by design — forwards any **undeclared** claims through verbatim, unchecked.
 * So a policy predicate or authorize hook that reads `auth.identity.<key>` for a
 * `<key>` the contract never declares is trusting a value the runtime never
 * validated — a claim an attacker's token can carry with an arbitrary value.
 * Reading `userId` (always declared) or any declared claim is fine.
 *
 * Runs only when the codegen feeder supplies claim-read evidence
 * (`context.identityClaimReads`) — which it does only when a resolvable
 * `defineIdentity` contract exists — so an app with no typed identity contract,
 * or a runtime caller, flags nothing. One finding per undeclared read.
 */
const identityUndeclaredClaimTrusted: Lint = {
    categories: ["SECURITY"],
    description:
        "An authorization read of `auth.identity.<key>` for a claim outside the declared `defineIdentity({ ... })` contract. `defineIdentity` validates only declared claims and forwards undeclared ones verbatim, so the value the policy trusts was never validated — an attacker's token can forge it.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "identity_undeclared_claim_trusted",
    remediation:
        "Declare the claim in `defineIdentity({ ... })` (e.g. `role: v.optional(v.string())`) so the worker validates it at the trust boundary before a policy reads it, or stop trusting it for authorization. Declared claims (and `userId`) are validated; undeclared claims are forwarded unchecked.",
    run: (context) => {
        if (context.identityClaimReads === undefined) {
            return [];
        }

        return context.identityClaimReads
            .filter((row: AdvisorIdentityClaimRead) => !row.declared)
            .map((row) => {
                const location = `\`${row.exportName}\` (${row.file}:${row.line.toString()})`;

                return emit(identityUndeclaredClaimTrusted, {
                    cacheKey: `identity_undeclared_claim_trusted:${row.file}:${row.line.toString()}:${row.key}`,
                    detail: `\`${row.key}\` in ${location} is read off \`identity\` but is not declared in \`defineIdentity({ ... })\`. Undeclared claims are forwarded unvalidated, so this authorization decision trusts a forgeable value.`,
                    metadata: {
                        exportName: row.exportName,
                        file: row.file,
                        key: row.key,
                        line: row.line,
                    },
                });
            });
    },
    source: "static",
    title: "Authorization trusts an undeclared identity claim",
};

export default identityUndeclaredClaimTrusted;
