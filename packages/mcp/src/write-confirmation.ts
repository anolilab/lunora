/**
 * The confirmation handshake in front of `lunora_run_mutation` and
 * `lunora_run_action`.
 *
 * `allowWrites` answers "may this server write at all". It does not answer "was
 * THIS write reviewed", and that is the gap: with writes on, a prompt-injected
 * or merely confused model can fire any discovered mutation or action —
 * including the ones that send mail, move money, or call a third party — with no
 * human in the loop. `destructiveHint` is a UI hint, not a gate.
 *
 * So a write tool runs in two steps. The first call does NOT execute: it returns
 * `status: "action_required"` carrying the proposed action (tool, kind, function
 * path, and the arguments exactly as they would be sent) plus an
 * `actionDigest`. A client renders that for a human, then calls the same tool
 * again with `confirmed: true` and the digest, and only then does the write
 * happen.
 *
 * **The digest is self-verifying, because it has to be.** `./serve-stateless`
 * builds a fresh `Server` per HTTP request and keeps nothing between them, so
 * there is no pending-action table to look a confirmation up in — and on a
 * multi-instance deployment the confirming request need not even reach the
 * instance that issued the proposal. The digest is therefore an HMAC-SHA-256
 * over the canonical form of everything the proposal asserted, keyed by the
 * deployment's own identity (its URL plus the admin bearer every tool already
 * carries). Any instance serving that deployment recomputes it; nobody without
 * the bearer can mint one. Change the target, an argument, the shard key, or the
 * idempotency key and the digest no longer verifies — which is the point: a
 * confirmation is bound to the exact action a human saw, not to "a write of some
 * kind was approved once".
 *
 * Canonicalization is `shared/stable-key`'s `stableStringify`, the repo's single
 * stable-JSON encoder (sorted keys at every depth), so argument key order cannot
 * change a digest. Signing and the constant-time verify are
 * `shared/hmac-url`'s — the repo's single HMAC envelope, cached `CryptoKey` and
 * all. Both are deliberately reused rather than re-derived here: a second
 * canonicalizer or a second HMAC path in the same repo is exactly the kind of
 * near-copy that drifts.
 */
import type { LunoraClient } from "@lunora/client";

import { fromBase64Url, signCanonical, verifyCanonical } from "../../../shared/hmac-url";
import { stableStringify } from "../../../shared/stable-key";
import { errorResult, ok } from "./tool-result";
import type { ToolResult } from "./tool-types";

/** The write a caller proposed — everything a confirmation is bound to. */
interface ProposedWrite {
    /** The arguments exactly as they would be sent to the function. */
    args: Record<string, unknown>;
    /** Discovered public function path, e.g. `"messages:send"`. */
    functionPath: string;
    /** Caller-chosen token distinguishing two otherwise-identical writes; see {@link IDEMPOTENCY_KEY_DESCRIPTION}. */
    idempotencyKey: string | undefined;
    /** Which run tool this is — the kind was already asserted against the registry. */
    kind: "action" | "mutation";
    /** Shard the call targets on a `.shardBy()`-partitioned deployment. */
    shardKey: string | undefined;
    /** MCP tool name, so a mutation digest can never confirm an action. */
    tool: string;
}

/** The confirmation fields a caller may send back on the second call. */
interface WriteConfirmation {
    actionDigest: string | undefined;
    confirmed: boolean;
    idempotencyKey: string | undefined;
}

/**
 * Domain separator folded into the signing key so a digest minted here can never
 * be mistaken for — or replayed against — any other HMAC this deployment's
 * bearer keys.
 */
const DIGEST_DOMAIN = "lunora-mcp-write-confirmation-v1";

/**
 * The signing secret: this deployment's identity.
 *
 * The URL names WHICH deployment a digest is good for (one minted against
 * staging must not confirm anything in production), and the admin bearer is the
 * secret half — every tool already carries it, and a caller that does not hold
 * it cannot reach the deployment at all, so it is the one shared secret every
 * instance serving this deployment provably agrees on without a store. HMAC
 * never discloses its key, so returning the digest to the model discloses
 * nothing about the token.
 */
const digestSecret = (client: LunoraClient): string => `${DIGEST_DOMAIN}\u0000${client.url}\u0000${client.getAuthToken() ?? ""}`;

/**
 * The exact bytes a digest signs. Sorted-key JSON at every depth, so
 * `{ b: 2, a: 1 }` and `{ a: 1, b: 2 }` produce one digest; absent and
 * `undefined` fields collapse together, so an omitted `shardKey` and an explicit
 * `shardKey: undefined` are the same action rather than two.
 */
const canonicalize = (proposal: ProposedWrite): string =>
    stableStringify({
        args: proposal.args,
        functionPath: proposal.functionPath,
        idempotencyKey: proposal.idempotencyKey,
        kind: proposal.kind,
        shardKey: proposal.shardKey,
        tool: proposal.tool,
    });

/** Mint the digest for a proposal. */
const computeActionDigest = async (client: LunoraClient, proposal: ProposedWrite): Promise<string> =>
    signCanonical(digestSecret(client), canonicalize(proposal));

/**
 * Constant-time check that `digest` was minted for exactly this proposal. A
 * malformed (non-base64url) digest is a mismatch, not a throw — it comes from
 * the model's own arguments bag.
 */
const verifyActionDigest = async (client: LunoraClient, proposal: ProposedWrite, digest: string): Promise<boolean> => {
    let signature: Uint8Array;

    try {
        signature = fromBase64Url(digest);
    } catch {
        return false;
    }

    return verifyCanonical(digestSecret(client), canonicalize(proposal), signature);
};

/**
 * What `idempotencyKey` is for, verbatim in the tool description and the docs.
 *
 * Stated as a guarantee and a non-guarantee because the honest version of this
 * feature is smaller than the name suggests. The key is folded into the digest
 * and nowhere else: this server holds no state between requests, so it cannot
 * remember that a call already ran, and it does not forward the key to the
 * function (which never declared it as an argument and would reject it).
 */
const IDEMPOTENCY_KEY_DESCRIPTION =
    "Optional caller-chosen token folded into the digest. GUARANTEE: repeating the same key with the same target and arguments yields the same digest, so a retry after a client timeout replays the confirmation you already have instead of asking for a second review — and a deliberately-repeated identical write sent under a NEW key gets its own digest, so it cannot ride the first review. NOT GUARANTEED: this does not deduplicate the write. The server keeps no state between requests and never forwards the key to the function, so a resubmitted confirmed call executes again. Make the function itself idempotent if the write must happen at most once.";

/** The confirmation fields both write tools add to the shared run-tool input schema. */
const WRITE_CONFIRMATION_PROPERTIES: Record<string, unknown> = {
    actionDigest: {
        description: "The digest returned by the preceding action_required result. Required together with confirmed.",
        type: "string",
    },
    confirmed: {
        description:
            "Set to true ONLY on the second call, after a human has reviewed the proposed action, and only together with the actionDigest that proposal returned. Omit it on the first call.",
        type: "boolean",
    },
    idempotencyKey: { description: IDEMPOTENCY_KEY_DESCRIPTION, type: "string" },
};

/** Read the confirmation fields out of an MCP `arguments` bag, ignoring anything malformed. */
const readConfirmation = (input: Record<string, unknown>): WriteConfirmation => {
    const actionDigest = typeof input.actionDigest === "string" && input.actionDigest.length > 0 ? input.actionDigest : undefined;
    const idempotencyKey = typeof input.idempotencyKey === "string" && input.idempotencyKey.length > 0 ? input.idempotencyKey : undefined;

    return { actionDigest, confirmed: input.confirmed === true, idempotencyKey };
};

/** The `action_required` result: the proposal a human reviews, plus the digest that binds it. */
const actionRequired = (proposal: ProposedWrite, actionDigest: string): ToolResult =>
    ok({
        actionDigest,
        nextStep: `Show proposedAction to a human. To execute, call ${proposal.tool} again with the IDENTICAL functionPath, args, shardKey and idempotencyKey, plus confirmed: true and this actionDigest. Nothing has been written or called yet.`,
        proposedAction: {
            args: proposal.args,
            functionPath: proposal.functionPath,
            idempotencyKey: proposal.idempotencyKey,
            kind: proposal.kind,
            shardKey: proposal.shardKey,
            tool: proposal.tool,
        },
        status: "action_required",
    });

/**
 * Screen a proposed write.
 *
 * Returns the result to hand back — the `action_required` proposal on an
 * unconfirmed call, or a refusal when a confirmation does not verify — and
 * `undefined` when the call is confirmed and may execute. The three-way return
 * is what keeps the caller's happy path a single `if`.
 *
 * Fail closed in both directions: a call that is not fully confirmed (no
 * `confirmed: true`, or no digest to go with it) yields a fresh proposal rather
 * than executing, and a digest that does not verify is refused rather than
 * re-proposed, so a model cannot launder edited arguments through a digest it
 * was handed for something else.
 */
const screenWriteConfirmation = async (client: LunoraClient, proposal: ProposedWrite, confirmation: WriteConfirmation): Promise<ToolResult | undefined> => {
    if (!confirmation.confirmed || confirmation.actionDigest === undefined) {
        return actionRequired(proposal, await computeActionDigest(client, proposal));
    }

    if (await verifyActionDigest(client, proposal, confirmation.actionDigest)) {
        return undefined;
    }

    return errorResult(
        `confirmation rejected: the actionDigest does not match this call. A digest is bound to the exact tool, function path, arguments, shard key and idempotency key it was issued for, so any edit to the proposal invalidates it — and a digest from another deployment never matches. Nothing was written. Call ${proposal.tool} again WITHOUT confirmed to get a fresh actionDigest for the current arguments, have it reviewed, then resubmit those same arguments with it.`,
    );
};

export type { ProposedWrite, WriteConfirmation };
export { readConfirmation, screenWriteConfirmation, WRITE_CONFIRMATION_PROPERTIES };
