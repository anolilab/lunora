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
 * **What the handshake enforces, and what it does not.** It binds INTENT, not
 * human presence. A verified digest proves the call about to run is exactly the
 * call that was proposed — same tool, kind, function path, arguments, shard key
 * and idempotency key — on THIS deployment, and was proposed within the last
 * {@link CONFIRMATION_TTL_MS}. It does not prove a human ever saw it, and it
 * cannot: an MCP server has no channel to a person. `./serve-stateless` answers
 * one HTTP request at a time with no session, no end-user identity and no UI,
 * and MCP puts the human-in-the-loop at the HOST — the client is what renders a
 * tool call for approval. A client that asks nobody can take the digest it was
 * just handed, send it straight back with `confirmed: true`, and the write
 * runs. That is why the write surface is off by default and refused at dispatch
 * ({@link file://./tools.ts}'s `allowWrites`): enabling writes is the operator
 * asserting that the client on the other end does the asking. What the digest
 * adds PAST that gate is bounded but real — an approved proposal cannot be
 * executed with edited arguments, cannot be replayed as the other kind of tool,
 * cannot be replayed against another deployment, and cannot be replayed once its
 * window has passed.
 *
 * Binding a confirmation to a PERSON rather than to a call would need an
 * end-user identity this package does not have. The digest key is the
 * deployment's admin bearer, which every principal on an OAuth-fronted server
 * shares (see `./authed-http`), so within the window any principal holding write
 * scope can confirm any other's identical proposal. Fixing that means either
 * plumbing the verified `sub` claim into the signing key or moving approval out
 * of MCP tool arguments entirely; both are design decisions beyond a handshake,
 * and the README says so plainly rather than implying a gate that is not there.
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
 * The same self-verifying construction carries the expiry. A stateless server
 * has nowhere to record "this digest was issued at T", so the issuing instance
 * writes the deadline into the digest itself and signs it alongside the
 * proposal: `<expiresAt>.<signature>`. The deadline is public — it has to be, so
 * the verifying instance can read it — but it is not forgeable, because moving
 * it changes what the signature covers.
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
import { LunoraError } from "@lunora/errors";

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
 * How long a minted digest stays confirmable — ten minutes.
 *
 * A digest with no deadline authorises its exact call forever: one approved
 * `payments:refund` stays confirmable for the life of the deployment URL and the
 * admin bearer, on every later session. Bounding it does not stop a client that
 * confirms its own proposals (nothing server-side can — see the module note),
 * but it does stop a digest surviving the review it belongs to, which is the
 * part a stateless server CAN enforce.
 *
 * Ten minutes rather than seconds because the other party is a human reading a
 * proposal in a chat client, and rather than hours because the window is the
 * whole mitigation. Expiring is cheap to recover from: the refusal says to call
 * again without `confirmed` and a fresh proposal comes back.
 */
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

/** Separates the public deadline from the signature over it. Not present in base64url, so a split is unambiguous. */
const DIGEST_SEPARATOR = ".";

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
const digestSecret = (client: LunoraClient): string => {
    const token = client.getAuthToken();

    // Refused rather than defaulted. `?? ""` made a tokenless client sign with a
    // key that is a public constant — every input to it is then knowable, so
    // anyone could mint a digest that verifies and the handshake would still
    // LOOK like it was working. A tokenless server cannot run a write anyway
    // (`assertRunnable` reads admin-gated routes), so refusing costs nothing
    // real and removes a silent downgrade of the only secret in the key.
    if (token === null || token === "") {
        throw new LunoraError(
            "UNAUTHORIZED",
            "write confirmation needs the deployment's admin token: it is the secret half of the digest key, and without it a digest would be forgeable by anyone.",
        );
    }

    return `${DIGEST_DOMAIN}\u0000${client.url}\u0000${token}`;
};

/**
 * The exact bytes a digest signs. Sorted-key JSON at every depth, so
 * `{ b: 2, a: 1 }` and `{ a: 1, b: 2 }` produce one digest; absent and
 * `undefined` fields collapse together, so an omitted `shardKey` and an explicit
 * `shardKey: undefined` are the same action rather than two.
 *
 * Signs the WHOLE proposal rather than a hand-listed subset of its fields, and
 * that is a security property, not brevity. A field enumerated here would have
 * to be enumerated again by every future editor; the one that got forgotten
 * would sit in `ProposedWrite`, be shown to the human in `action_required`, and
 * not be bound by the digest — so a confirmation for the action a human saw
 * would also confirm one with that field changed. Binding by construction fails
 * closed instead: a new field is covered the moment it exists.
 */
const canonicalize = (proposal: ProposedWrite, expiresAt: number): string => `${stableStringify(proposal)}\u0000${String(expiresAt)}`;

/**
 * Mint the digest for a proposal, valid for {@link CONFIRMATION_TTL_MS}.
 *
 * Returns the deadline alongside the digest so `action_required` can state it:
 * a client that shows a human "approve within 10 minutes" is showing the same
 * number the verify will enforce, not a second copy of it.
 */
const computeActionDigest = async (client: LunoraClient, proposal: ProposedWrite): Promise<{ actionDigest: string; expiresAt: number }> => {
    const expiresAt = Date.now() + CONFIRMATION_TTL_MS;
    const signature = await signCanonical(digestSecret(client), canonicalize(proposal, expiresAt));

    return { actionDigest: `${String(expiresAt)}${DIGEST_SEPARATOR}${signature}`, expiresAt };
};

/** Why a digest was not honoured — separate outcomes because they need different advice. */
type DigestVerdict = "expired" | "mismatch" | "valid";

/**
 * Constant-time check that `digest` was minted for exactly this proposal and is
 * still inside its window.
 *
 * Every malformed shape — no separator, a non-integer deadline, a non-base64url
 * signature — is a `"mismatch"` rather than a throw: the whole string comes out
 * of the model's own arguments bag, so it is untrusted input, not a bug.
 *
 * The expiry is checked BEFORE the signature so an expired digest reports as
 * expired rather than as tampering; both refuse, and neither reveals anything a
 * holder of the digest does not already have (the deadline is in the string).
 */
const verifyActionDigest = async (client: LunoraClient, proposal: ProposedWrite, digest: string): Promise<DigestVerdict> => {
    const separatorAt = digest.indexOf(DIGEST_SEPARATOR);

    if (separatorAt <= 0) {
        return "mismatch";
    }

    const expiresAt = Number(digest.slice(0, separatorAt));

    // `Number("")` is 0 and `Number("1e3")` is 1000, so an explicit integer test
    // rather than a parse: only the exact digits this module emits are accepted.
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
        return "mismatch";
    }

    if (Date.now() >= expiresAt) {
        return "expired";
    }

    let signature: Uint8Array;

    try {
        signature = fromBase64Url(digest.slice(separatorAt + 1));
    } catch {
        return "mismatch";
    }

    return (await verifyCanonical(digestSecret(client), canonicalize(proposal, expiresAt), signature)) ? "valid" : "mismatch";
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
    "Optional caller-chosen token folded into the digest. GUARANTEE: a retry after a client timeout can resubmit the confirmation you already hold, for as long as that digest is inside its window, instead of asking for a second review — and a deliberately-repeated identical write sent under a NEW key gets its own digest, so it cannot ride the first review. NOT GUARANTEED: this does not deduplicate the write. The server keeps no state between requests and never forwards the key to the function, so a resubmitted confirmed call executes again. Make the function itself idempotent if the write must happen at most once.";

/** The confirmation fields both write tools add to the shared run-tool input schema. */
const WRITE_CONFIRMATION_PROPERTIES: Record<string, unknown> = {
    actionDigest: {
        description:
            "The digest returned by the preceding action_required result. Required together with confirmed, and only valid until the expiresAt that result reported — past that, propose again.",
        type: "string",
    },
    confirmed: {
        description:
            "Set to true ONLY on the second call, after a human has reviewed the proposed action, and only together with the actionDigest that proposal returned. Omit it on the first call. The server cannot tell whether a human actually reviewed it — that is this client's responsibility, and the operator enabled writes on the understanding that this client asks.",
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

/**
 * The `action_required` result: the proposal a human reviews, plus the digest
 * that binds it.
 *
 * Hands back the proposal itself for the same reason {@link canonicalize} signs
 * it whole — what the human is shown and what the digest binds must be the same
 * object, or a field can drift into one and not the other.
 */
const actionRequired = (proposal: ProposedWrite, minted: { actionDigest: string; expiresAt: number }): ToolResult =>
    ok({
        actionDigest: minted.actionDigest,
        expiresAt: new Date(minted.expiresAt).toISOString(),
        nextStep: `Show proposedAction to a human. To execute, call ${proposal.tool} again with the IDENTICAL functionPath, args, shardKey and idempotencyKey, plus confirmed: true and this actionDigest, before expiresAt. Nothing has been written or called yet.`,
        proposedAction: proposal,
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
 * Fail closed in every direction: a call that is not fully confirmed (no
 * `confirmed: true`, or no digest to go with it) yields a fresh proposal rather
 * than executing, and a digest that does not verify — edited, foreign, or out of
 * its window — is refused rather than re-proposed, so a model cannot launder
 * edited arguments through a digest it was handed for something else, nor keep
 * an old approval alive by resending it.
 *
 * An expired digest is refused rather than silently re-proposed for the same
 * reason a mismatched one is: re-proposing would hand the caller a fresh digest
 * on a call that said `confirmed: true`, which reads to a model like the
 * confirmation was accepted. The refusal names the window instead, so the client
 * goes back through its own review.
 */
const screenWriteConfirmation = async (client: LunoraClient, proposal: ProposedWrite, confirmation: WriteConfirmation): Promise<ToolResult | undefined> => {
    if (!confirmation.confirmed || confirmation.actionDigest === undefined) {
        return actionRequired(proposal, await computeActionDigest(client, proposal));
    }

    const verdict = await verifyActionDigest(client, proposal, confirmation.actionDigest);

    if (verdict === "valid") {
        return undefined;
    }

    if (verdict === "expired") {
        return errorResult(
            `confirmation rejected: this actionDigest has expired. A confirmation is good for ${String(CONFIRMATION_TTL_MS / 60_000)} minutes from the proposal that issued it, so an approval cannot be replayed in a later session. Nothing was written. Call ${proposal.tool} again WITHOUT confirmed to get a fresh actionDigest, have it reviewed, then resubmit those same arguments with it.`,
        );
    }

    return errorResult(
        `confirmation rejected: the actionDigest does not match this call. A digest is bound to the exact tool, function path, arguments, shard key and idempotency key it was issued for, so any edit to the proposal invalidates it — and a digest from another deployment never matches. Nothing was written. Call ${proposal.tool} again WITHOUT confirmed to get a fresh actionDigest for the current arguments, have it reviewed, then resubmit those same arguments with it.`,
    );
};

export type { ProposedWrite, WriteConfirmation };
export { CONFIRMATION_TTL_MS, readConfirmation, screenWriteConfirmation, WRITE_CONFIRMATION_PROPERTIES };
