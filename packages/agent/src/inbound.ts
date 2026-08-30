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
 *   `email.from`. Gate on `email.authentication` (DKIM/SPF/DMARC verdicts) and
 *   return `null` to drop an unauthenticated message.
 * - The started run has no request identity: its thread owner is whatever the
 *   mapper puts in `AgentEmailRun.owner`, and its tools run RLS-bypassed. Derive
 *   `owner` from a verified signal (a DKIM-checked address mapped to an account),
 *   never blindly from the spoofable sender, and treat every mapped field as
 *   attacker-controlled input.
 * - A parse failure routes through `@lunora/mail/inbound`'s default `onError`,
 *   which rejects the message with a fixed generic reason. A dispatch failure is
 *   rethrown there instead, so a transient transport error is redelivered rather
 *   than bounced — the two permanent dispatch failures below reject themselves.
 *   Either way the sender's bounce carries a fixed generic reason and never
 *   reflects internal error detail.
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
 * `@lunora/mail`'s handler rethrows a `dispatch` failure so the platform can
 * redeliver, because a transport error there (a shard 502, a briefly-absent
 * admin token) is transient and bouncing it would lose a legitimate email. The
 * two failures below are not that: a missing Workflow binding is a
 * misconfigured deployment and a reserved branch-marker key is malformed
 * untrusted input, and both fail identically on every redelivery. Only the
 * dispatch implementation knows which of its own errors are permanent, so it
 * rejects those itself rather than letting them retry forever.
 */
const rejectPermanently = (context: { message: { setReject: (reason: string) => void } }, detail: string): void => {
    // eslint-disable-next-line no-console -- server-side log of the real reason before bouncing with a generic, non-reflecting one
    console.error("@lunora/agent/inbound: bouncing message —", detail);

    context.message.setReject(GENERIC_REJECT_REASON);
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
    });

    // `createInboundEmailHandler` types `message` as `ForwardableEmailMessageLike`;
    // the generated `composed.email` slot passes it as `unknown`. Re-widen the
    // parameters here so the handler is assignable without a cast at the call site.
    return async (message, env, context) => handler(message as ForwardableEmailMessageLike, env as Record<string, unknown>, context);
};

export { dispatchAgentEmail };
export type { AgentEmailTarget, InboundAgentEmailHandler };
