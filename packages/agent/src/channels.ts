/* eslint-disable n/no-unsupported-features/node-builtins -- workerd provides the Web Crypto global (`crypto.subtle`); agent code runs in Workers, never under Node */

/**
 * `@lunora/agent/channels` — start a durable agent run from a verified inbound
 * webhook (Slack / GitHub / Discord), the HTTP cousin of `@lunora/agent/inbound`
 * (email). Mount `dispatchAgentChannel(...)` on an HTTP route; it verifies the
 * channel's signature over the RAW body, offers the parsed event to each agent's
 * `onInbound.map` mapper, and starts a durable run for the first agent that
 * claims it.
 *
 * SECURITY — a webhook payload is untrusted and a run dispatches privileged.
 * Trust is established ONLY by the per-channel signature check (Slack HMAC over
 * `v0:timestamp:body`, GitHub HMAC over the body, Discord Ed25519 over
 * `timestamp+body`). A request that fails verification is rejected `401` and
 * never reaches a mapper. Payload fields are spoofable relative to each other and
 * MUST NOT be used for trust; derive the run `owner` from the verified channel
 * identity (the workspace/installation the secret belongs to), never from an
 * arbitrary payload field. The started run has no request identity — its tools
 * run RLS-bypassed under the `owner` the mapper sets.
 */
import { LunoraError } from "@lunora/errors";
import { isDuplicateInstanceError } from "@lunora/workflow";

import { BRANCH_MARKER_REJECTION, hasBranchMarker } from "../../../shared/branch-marker";
import { fnv1a64Hex } from "../../../shared/fnv1a";
import type { AgentChannelRun, AgentDefinition, AgentInboundChannelKind, AgentWorkflowBindingLike, InboundChannelEvent } from "./types";

/** Max age (seconds) of a signed request before it is rejected as a replay. */
const DEFAULT_TIMESTAMP_TOLERANCE = 300;

/** Matches any non-hex character (hoisted so it isn't recompiled per call). */
const NON_HEX = /[^0-9a-f]/iu;

const encoder = new TextEncoder();

/** UTF-8 encode into a fresh `ArrayBuffer`-backed view (satisfies Web Crypto's `BufferSource`). */
const utf8 = (value: string): Uint8Array<ArrayBuffer> => new Uint8Array(encoder.encode(value));

/** Decode a hex string to bytes; throws on odd length or a non-hex digit. */
const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => {
    if (hex.length % 2 !== 0 || NON_HEX.test(hex)) {
        throw new LunoraError("BAD_REQUEST", "@lunora/agent: malformed hex signature");
    }

    const bytes = new Uint8Array(hex.length / 2);

    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }

    return bytes;
};

/** Constant-time HMAC-SHA256 verify (`crypto.subtle.verify` compares internally). */
const verifyHmacSha256 = async (secret: string, message: string, signatureHex: string): Promise<boolean> => {
    try {
        const key = await crypto.subtle.importKey("raw", utf8(secret), { hash: "SHA-256", name: "HMAC" }, false, ["verify"]);

        return await crypto.subtle.verify("HMAC", key, hexToBytes(signatureHex), utf8(message));
    } catch {
        return false;
    }
};

/** Whether `timestampSeconds` is within `tolerance` of `nowSeconds` (replay guard). */
const isFreshTimestamp = (timestampSeconds: number, nowSeconds: number, tolerance: number): boolean =>
    Number.isFinite(timestampSeconds) && Math.abs(nowSeconds - timestampSeconds) <= tolerance;

/**
 * Verify a Slack request signature (`x-slack-signature` = `v0=` + HMAC over
 * `v0:timestamp:body`), rejecting a stale timestamp to bound replay. `now` is
 * injectable for deterministic tests (defaults to the wall clock).
 * @experimental
 */
const verifySlack = async (options: {
    body: string;
    now?: number;
    signature: string | undefined;
    signingSecret: string;
    timestamp: string | undefined;
    tolerance?: number;
}): Promise<boolean> => {
    const { body, now = Date.now() / 1000, signature, signingSecret, timestamp, tolerance = DEFAULT_TIMESTAMP_TOLERANCE } = options;

    if (!signature || !timestamp || !signature.startsWith("v0=")) {
        return false;
    }

    if (!isFreshTimestamp(Number(timestamp), now, tolerance)) {
        return false;
    }

    return verifyHmacSha256(signingSecret, `v0:${timestamp}:${body}`, signature.slice("v0=".length));
};

/**
 * Verify a GitHub webhook signature (`x-hub-signature-256` = `sha256=` + HMAC over the body).
 * @experimental
 */
const verifyGithub = async (options: { body: string; secret: string; signature: string | undefined }): Promise<boolean> => {
    const { body, secret, signature } = options;

    if (!signature?.startsWith("sha256=")) {
        return false;
    }

    return verifyHmacSha256(secret, body, signature.slice("sha256=".length));
};

/**
 * Verify a Discord interaction signature: Ed25519 over `timestamp + body`,
 * `x-signature-ed25519` (hex) against the application's `publicKey` (hex).
 * @experimental
 */
const verifyDiscord = async (options: { body: string; publicKey: string; signature: string | undefined; timestamp: string | undefined }): Promise<boolean> => {
    const { body, publicKey, signature, timestamp } = options;

    if (!signature || !timestamp) {
        return false;
    }

    try {
        const key = await crypto.subtle.importKey("raw", hexToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);

        return await crypto.subtle.verify({ name: "Ed25519" }, key, hexToBytes(signature), utf8(timestamp + body));
    } catch {
        return false;
    }
};

/**
 * One agent wired into the inbound channel HTTP handler.
 * @experimental
 */
interface AgentChannelTarget {
    /** The agent definition — only its `onInbound` config is read. */
    agent: Pick<AgentDefinition, "onInbound">;
    /** The `AGENT_*` Workflow binding name (off `env`) that starts a run. */
    binding: string;
}

/**
 * The HTTP handler `dispatchAgentChannel` returns — mount it on a webhook route.
 * @experimental
 */
type InboundChannelHandler = (request: Request, env: Record<string, unknown>) => Promise<Response>;

/** Detect the channel from the request's signature headers (route-agnostic). */
const detectChannel = (headers: Headers): AgentInboundChannelKind | undefined => {
    if (headers.has("x-slack-signature")) {
        return "slack";
    }

    if (headers.has("x-hub-signature-256")) {
        return "github";
    }

    if (headers.has("x-signature-ed25519")) {
        return "discord";
    }

    return undefined;
};

/** Resolve a channel target's verification secret from `env` (an env-var name or a resolver). */
const resolveSecret = (secret: string | ((env: Record<string, unknown>) => string | undefined), env: Record<string, unknown>): string | undefined => {
    if (typeof secret === "function") {
        return secret(env);
    }

    const value = env[secret];

    return typeof value === "string" ? value : undefined;
};

/** Verify a request's signature for the detected channel against the target's secret. */
const verifyChannel = async (channel: AgentInboundChannelKind, secret: string, headers: Headers, body: string): Promise<boolean> => {
    switch (channel) {
        case "discord": {
            return verifyDiscord({
                body,
                publicKey: secret,
                signature: headers.get("x-signature-ed25519") ?? undefined,
                timestamp: headers.get("x-signature-timestamp") ?? undefined,
            });
        }
        case "github": {
            return verifyGithub({ body, secret, signature: headers.get("x-hub-signature-256") ?? undefined });
        }
        case "slack": {
            return verifySlack({
                body,
                signature: headers.get("x-slack-signature") ?? undefined,
                signingSecret: secret,
                timestamp: headers.get("x-slack-request-timestamp") ?? undefined,
            });
        }
        default: {
            return false;
        }
    }
};

/** A Discord PING (interaction type 1) must be answered with a PONG; `undefined` when not a PING. */
const discordPongResponse = (channel: AgentInboundChannelKind, body: string): Response | undefined => {
    if (channel !== "discord") {
        return undefined;
    }

    try {
        if ((JSON.parse(body) as { type?: number }).type === 1) {
            return Response.json({ type: 1 });
        }
    } catch {
        // Not JSON — fall through; the mapper will decide.
    }

    return undefined;
};

/** The eligible targets for a channel, paired with their resolved `onInbound` config. */
type EligibleTarget = { config: NonNullable<AgentDefinition["onInbound"]>; target: AgentChannelTarget };

/** A bare `200 OK` — the provider's "delivered, do not redeliver" acknowledgement. */
const ack = (): Response => new Response(undefined, { status: 200 });

/**
 * A stable per-delivery id for idempotent dispatch: GitHub's `X-GitHub-Delivery`
 * header, else Slack's `event_id` / Discord's interaction `id` from the (already
 * verified) body. `undefined` when none is present.
 */
const deliveryId = (channel: AgentInboundChannelKind, headers: Headers, body: string): string | undefined => {
    if (channel === "github") {
        return headers.get("x-github-delivery") ?? undefined;
    }

    try {
        const parsed = JSON.parse(body) as { event_id?: unknown; id?: unknown };
        const raw = channel === "slack" ? parsed.event_id : parsed.id;

        return typeof raw === "string" ? raw : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Start the run for a claimed event, idempotently. A provider redelivery carries
 * the SAME delivery id, and Cloudflare Workflows rejects a duplicate instance id
 * — so a redelivery acks `200` (already handled) instead of starting a second
 * run. Only a *duplicate-instance* rejection is acked; any other `create()`
 * failure (service error, quota, bad binding) is rethrown so the handler returns
 * non-2xx and the provider redelivers rather than the event being lost. When no
 * usable delivery id is available (absent, or sanitized to empty), falls back to
 * a non-idempotent create.
 */
const startChannelRun = async (
    workflow: AgentWorkflowBindingLike,
    run: AgentChannelRun,
    channel: AgentInboundChannelKind,
    id: string | undefined,
): Promise<Response> => {
    // `run` derives from an inbound channel webhook mapper — reject the reserved
    // workflow branch-marker key at this trust boundary before it ever reaches
    // `create()`. Thrown (not acked): a forged marker must not be reported as
    // handled, or the provider would never redeliver it once the bug is fixed.
    if (hasBranchMarker(run)) {
        throw new LunoraError("BAD_REQUEST", `@lunora/agent: inbound channel run params ${BRANCH_MARKER_REJECTION}`);
    }

    // An absent or empty id gives no dedup key. Otherwise hash the RAW id: the
    // hex digest is always instance-id-safe and fixed-length (`<channel>-` + 16
    // chars, well under Cloudflare's 100-character cap) while keeping the whole id
    // significant, where sanitize-then-truncate discarded everything past the
    // cutoff. FNV-1a is a checksum, not a cryptographic hash — an attacker who
    // can choose a delivery id can find a collision — so the integrity of this
    // key rests on the upstream signature verification of the id, not on the
    // digest; against ACCIDENTAL collision between honest ids, 64 bits is
    // ample.
    if (id === undefined || id === "") {
        await workflow.create({ params: run });

        return ack();
    }

    try {
        await workflow.create({ id: `${channel}-${fnv1a64Hex(id)}`, params: run });
    } catch (error) {
        if (isDuplicateInstanceError(error)) {
            return ack();
        }

        // A transient/config failure — NOT a redelivery. Surface it so the
        // handler answers non-2xx and the provider retries the delivery.
        throw error;
    }

    return ack();
};

/**
 * Build an HTTP handler that starts a durable agent run from a verified inbound
 * webhook. The channel is detected from the signature headers; EACH eligible
 * target is verified against ITS OWN secret before its mapper is offered the
 * event (so one app's valid signature can't trigger another app's agent), and
 * the first target that both verifies and claims starts a run on its Workflow
 * binding. Returns `401` when NO target's signature verifies, `200` on a claim
 * (or a Discord PONG), `204` when a verified event is declined by every mapper,
 * and `400` for an unrecognized webhook.
 * @experimental
 */
const dispatchAgentChannel =
    (targets: ReadonlyArray<AgentChannelTarget>): InboundChannelHandler =>
    async (request, env) => {
        const body = await request.text();
        const channel = detectChannel(request.headers);

        if (channel === undefined) {
            return new Response("Unrecognized webhook", { status: 400 });
        }

        // Only agents configured for THIS channel are eligible.
        const eligible = targets
            .map((target) => {
                return { config: target.agent.onInbound, target };
            })
            .filter((entry): entry is EligibleTarget => entry.config?.channel === channel);

        const event: InboundChannelEvent = { channel, headers: request.headers, json: (): unknown => JSON.parse(body), rawBody: body };
        let verifiedAny = false;

        for (const { config, target } of eligible) {
            const secret = resolveSecret(config.secret, env);

            // eslint-disable-next-line no-await-in-loop -- per-target signature check, ordered first-match-wins
            if (secret === undefined || !(await verifyChannel(channel, secret, request.headers, body))) {
                continue;
            }

            verifiedAny = true;

            // Discord PING → PONG, but only once the request's signature verified.
            const pong = discordPongResponse(channel, body);

            if (pong) {
                return pong;
            }

            // eslint-disable-next-line no-await-in-loop -- see above
            const run = await config.map(event);

            // A mapper returns null/undefined to decline; a run is always an object.
            if (!run) {
                continue;
            }

            const workflow = env[target.binding] as AgentWorkflowBindingLike | undefined;

            if (!workflow || typeof workflow.create !== "function") {
                throw new LunoraError(
                    "INTERNAL",
                    `@lunora/agent: no Workflow binding "${target.binding}" on env for an inbound-channel agent — run codegen/dev so wrangler.jsonc declares it`,
                );
            }

            // eslint-disable-next-line no-await-in-loop -- single dispatch then return; never iterates past the first claim
            return await startChannelRun(workflow, run satisfies AgentChannelRun, channel, deliveryId(channel, request.headers, body));
        }

        // No target's secret verified ⇒ unauthenticated; a verified-but-declined event is a 204.
        return verifiedAny ? new Response(undefined, { status: 204 }) : new Response("Invalid signature", { status: 401 });
    };

export type { AgentChannelTarget, InboundChannelHandler };
export type { InboundChannelEvent } from "./types";
export { dispatchAgentChannel, verifyDiscord, verifyGithub, verifySlack };
