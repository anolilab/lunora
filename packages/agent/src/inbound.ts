/* eslint-disable jsdoc/check-indentation, jsdoc/no-multi-asterisks -- intentional nested bullet list documenting the inbound security model */

/**
 * `@lunora/agent/inbound` — start a durable agent run from an inbound email.
 *
 * Codegen wires this onto the worker's top-level `email(message, env, ctx)`
 * handler for every agent declared with `defineAgent({ onEmail })`. Cloudflare
 * Email Routing delivers received mail here; the handler parses it (reusing
 * `@lunora/mail/inbound`), offers it to each agent's `onEmail` mapper in turn,
 * and starts a durable run for the FIRST agent whose mapper returns a run (an
 * agent that returns `null`/`undefined` declines the message). A message no
 * agent claims is dropped without error.
 *
 * SECURITY — inbound mail is untrusted and a run dispatches privileged:
 * - Cloudflare Email Routing authenticates only the *recipient* domain, not the
 *   *sender*. The envelope `from`, subject, and body are trivially spoofable, so
 *   an `onEmail` mapper MUST NOT make trust/authorization decisions on
 *   `email.from`. The handler below drops a message whose `From` domain is not
 *   vouched for by an aligned verdict before any mapper runs; a mapper that
 *   needs a stricter policy (an allow-list of sender domains, say) checks
 *   `email.authentication` itself and returns `null` to decline.
 * - The started run has no request identity: its thread owner is whatever the
 *   mapper puts in `AgentEmailRun.owner`, and its tools run RLS-bypassed. Derive
 *   `owner` from a verified signal (a DKIM-checked address mapped to an account),
 *   never blindly from the spoofable sender, and treat every mapped field as
 *   attacker-controlled input.
 * - Every failure — parse, verify, or dispatch — rejects the message with a
 *   fixed generic reason, so the sender's bounce never reflects internal error
 *   detail. Cloudflare gives an inbound worker no way to signal "try later": an
 *   uncaught throw is also permanent, just opaque, so there is nothing to gain
 *   by rethrowing. This handler wires no `retain` sink, so a transient dispatch
 *   failure bounces too; the two permanent failures below reject themselves so
 *   their real reason reaches the server log.
 */
/* eslint-enable jsdoc/check-indentation, jsdoc/no-multi-asterisks */
import type { ForwardableEmailMessageLike } from "@lunora/mail/inbound";
import { createInboundEmailHandler, parseInboundEmail } from "@lunora/mail/inbound";

import { BRANCH_MARKER_REJECTION, hasBranchMarker } from "../../../shared/branch-marker";
import type { AgentDefinition, AgentWorkflowBindingLike } from "./types";

/**
 * One agent wired into the inbound `email()` handler.
 * @experimental
 */
interface AgentEmailTarget {
    /**
     * The agent definition — only its `onEmail` mapper is read, deciding whether
     * this agent claims the message and, if so, the run to start.
     */
    agent: Pick<AgentDefinition, "onEmail">;
    /** The `AGENT_*` Workflow binding name (off `env`) that starts a run. */
    binding: string;
}

/**
 * The worker `email(message, env, ctx)` callback. Typed with `unknown`
 * parameters so it drops straight onto the generated `composed.email` slot
 * without a cast.
 * @experimental
 */
type InboundAgentEmailHandler = (message: unknown, env: unknown, context: unknown) => Promise<void>;

/**
 * Fixed reject reason handed to the sender's MTA. SECURITY: never embed internal
 * error detail here — the reason is reflected to the (untrusted) sender in the
 * bounce, so the detail is logged server-side instead.
 */
const GENERIC_REJECT_REASON = "message could not be processed";

/**
 * Bounce the message permanently, logging the real reason server-side.
 *
 * A `dispatch` that THROWS is treated as possibly-transient by
 * `@lunora/mail`'s handler: a transport error there (a shard 502, a
 * briefly-absent admin token) clears on its own, so the handler hands the
 * message to a durable `retain` sink when one is configured rather than losing a
 * legitimate email. The two failures below are not that: a missing Workflow
 * binding is a misconfigured deployment and a reserved branch-marker key is
 * malformed untrusted input, and both fail identically however often they are
 * retried. Only the dispatch implementation knows which of its own errors are
 * permanent, so it rejects those itself and returns — never throwing — so they
 * bounce instead of being queued for a retry that can never succeed.
 */
const rejectPermanently = (context: { message: { setReject: (reason: string) => void } }, detail: string): void => {
    // eslint-disable-next-line no-console -- server-side log of the real reason before bouncing with a generic, non-reflecting one
    console.error("@lunora/agent/inbound: bouncing message —", detail);

    context.message.setReject(GENERIC_REJECT_REASON);
};

/**
 * The angle-bracketed mailbox in a parsed `from` string. The parser renders
 * `name <address>` with the mailbox LAST; anchor there so a display name that
 * itself contains `<x@evil.example>` cannot stand in.
 */
const FROM_MAILBOX = /<([^<>]*)>$/;

/**
 * Domain of the parsed `From` mailbox (`Name <local@domain>` or a bare
 * address), lowercased. `undefined` when there is no single mailbox to align
 * against — an empty `From`, or an RFC 5322 group whose members the parser
 * flattened to a comma list — so the caller fails closed.
 */
const fromDomain = (from: string): string | undefined => {
    const address = FROM_MAILBOX.exec(from)?.[1] ?? from;
    const at = address.indexOf("@");

    if (at === -1 || at !== address.lastIndexOf("@")) {
        return undefined;
    }

    return address
        .slice(at + 1)
        .trim()
        .toLowerCase();
};

/**
 * Build the inbound `email()` handler for one or more `onEmail` agents. The
 * returned callback parses the message, then walks `targets` in order and starts
 * a durable run for the first agent whose `onEmail` mapper returns a run.
 *
 * Two dispatch failures bounce the message permanently rather than retrying: a
 * missing Workflow binding (run codegen/dev so `wrangler.jsonc` declares it) and
 * a run carrying the reserved workflow branch-marker key. See
 * {@link rejectPermanently}.
 * @experimental
 */
const dispatchAgentEmail = (targets: ReadonlyArray<AgentEmailTarget>): InboundAgentEmailHandler => {
    const handler = createInboundEmailHandler({
        dispatch: async (email, context) => {
            for (const target of targets) {
                const mapper = target.agent.onEmail;

                if (!mapper) {
                    continue;
                }

                // Mappers are evaluated in order and the first non-null one wins, so
                // the awaits are intentionally sequential (not a parallelizable fan-out
                // — a later mapper must not run once one has claimed the message).
                // eslint-disable-next-line no-await-in-loop -- ordered first-match-wins routing; see comment above
                const run = await mapper(email);

                // A mapper returns null/undefined to decline the message — let a
                // later agent claim it (or drop it if none does).
                if (run === null || run === undefined) {
                    continue;
                }

                const binding = context.env[target.binding] as AgentWorkflowBindingLike | undefined;

                if (!binding || typeof binding.create !== "function") {
                    rejectPermanently(
                        context,
                        `@lunora/agent: no Workflow binding "${target.binding}" on env for an inbound agent — run codegen/dev so wrangler.jsonc declares it`,
                    );

                    return;
                }

                // `run` is built by an app-authored `onEmail` mapper from a fully
                // untrusted inbound email — reject the reserved workflow
                // branch-marker key at this trust boundary before it ever reaches
                // `create()`.
                if (hasBranchMarker(run)) {
                    rejectPermanently(context, `@lunora/agent: inbound run params ${BRANCH_MARKER_REJECTION}`);

                    return;
                }

                // `AgentEmailRun` is the run-input shape (input/owner/threadKey/title).
                // eslint-disable-next-line no-await-in-loop -- single dispatch then `return`; never iterates past the first claim
                await binding.create({ params: run });

                return;
            }
        },
        parse: parseInboundEmail,
        // SECURITY: fails closed BEFORE any mapper sees the message, because a
        // claimed message starts a durable run whose tools execute RLS-bypassed.
        // Cloudflare Email Routing authenticates the recipient domain, never the
        // sender, so `from`/subject/body are attacker-chosen; a `null` verdict
        // means the receiving MX stamped no `Authentication-Results` header at
        // all, which is "unknown", not "fine".
        //
        // A bare `pass` is not enough either: SPF vouches for the envelope
        // `MAIL FROM` domain and DKIM for the signing `d=`, both of which the
        // attacker picks, so `spf=pass`+`dkim=pass` for evil.example is routine
        // on a message whose `From` says ceo@victim.example. A verdict counts
        // only when the domain it is about equals the `From` domain (RFC 7489
        // strict alignment — there is no public-suffix list here, so
        // `mail.example.com` does not vouch for `example.com`). A DMARC pass
        // already checked alignment at the MX. A pass that reports no domain at
        // all cannot be aligned and is rejected.
        //
        // The header above tells mappers not to trust `email.from`. That is
        // advice each mapper has to remember; this is the guard every agent
        // routes through, so a mapper that forgets is not the only thing
        // standing between a forged sender and a privileged run.
        verify: (email) => {
            const { dkim, dmarc, spf } = email.authentication;
            const from = fromDomain(email.from);

            if (from === undefined) {
                return false;
            }

            // EVERY reported clause of a method is considered, not just the
            // first. One header legitimately reports a method more than once —
            // an ESP-relayed message is DKIM-signed by both the relay and the
            // author domain — and reading only the first threw away the aligned
            // pass whenever the MX happened to list the other one ahead of it,
            // bouncing mail it had fully authenticated. "Any clause passes AND
            // aligns" is still strictly narrower than a bare pass: a clause that
            // vouches for some other domain contributes nothing.
            const alignedPass = (results: ReadonlyArray<{ domain: null | string; result: string }>): boolean =>
                results.some((entry) => entry.result === "pass" && entry.domain === from);

            return alignedPass(dmarc) || alignedPass(spf) || alignedPass(dkim);
        },
    });

    // `createInboundEmailHandler` types `message` as `ForwardableEmailMessageLike`;
    // the generated `composed.email` slot passes it as `unknown`. Re-widen the
    // parameters here so the handler is assignable without a cast at the call site.
    return async (message, env, context) => handler(message as ForwardableEmailMessageLike, env as Record<string, unknown>, context);
};

export { dispatchAgentEmail };
export type { AgentEmailTarget, InboundAgentEmailHandler };
