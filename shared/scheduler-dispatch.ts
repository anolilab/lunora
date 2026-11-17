/**
 * The auth rules and path constants for the scheduler dispatch endpoint, shared by
 * `@lunora/runtime` (the Worker's `handleSchedulerDispatch`) and
 * `@lunora/platform-node` (the in-process dispatch route).
 *
 * One definition on purpose: a copy that drifts would let one host accept a
 * credential the other refuses, or fail to refuse a reserved RPC path.
 *
 * Like `shared/constant-time-equal.ts`, this is deliberately **not** a package.
 * Consumers import it by relative path and the bundler inlines it, so keep it
 * genuinely zero-dependency (relative imports only). It returns booleans and
 * leaves throwing to each caller, which keeps `@lunora/errors` out of here.
 */

import { constantTimeEqual } from "./constant-time-equal";
import { signCanonical } from "./hmac-url";

/** The path `@lunora/dispatch` and `@lunora/scheduler` POST to on the app origin. */
const SCHEDULER_DISPATCH_PATH = "/_lunora/scheduler/dispatch";

/**
 * The reserved cross-shard relation reader's function-path prefix. A literal, not
 * an import, so no host has to depend on `@lunora/do` to recognise it.
 */
const RELATION_FUNCTION_PREFIX = "__lunora_relation__:";

/**
 * True for a `__lunora_relation__:*` function path. That reader answers with raw,
 * RLS-blind rows and is reachable only through the fan-out path, so any surface that
 * turns a function path into a single-shard dispatch must refuse it.
 */
const isReservedRelationFunctionPath = (functionPath: string): boolean => functionPath.startsWith(RELATION_FUNCTION_PREFIX);

/** `@lunora/agent`'s public run-start mutation. A literal, so no host depends on that package. */
const AGENT_RUN_FUNCTION_PATH = "agents:agentRun";

/**
 * True for an `agents:agentRun` call bound anywhere but the default shard (a fan-out
 * passes `undefined`). Its in-flight check reads the agent thread table, which the loop
 * writes on the default shard, and a shard DO can neither tell that it is not the default
 * nor read the default from inside a mutation, so every host refuses the call up front.
 */
const isAgentRunOffDefaultShard = (functionPath: string, shardKey: string | undefined, defaultShardKey: string): boolean =>
    functionPath === AGENT_RUN_FUNCTION_PATH && shardKey !== defaultShardKey;

/** The refusal message for {@link isAgentRunOffDefaultShard}. */
const AGENT_RUN_OFF_DEFAULT_SHARD_MESSAGE = `\`${AGENT_RUN_FUNCTION_PATH}\` runs on the default shard only, where agent threads live; to run an agent's tools on another shard, start it from a mutation on that shard with \`ctx.agents.<name>.run\``;

/**
 * Admin bearer check: `Authorization: Bearer <token>` compared in constant time.
 * An absent or empty `expected` token never authenticates.
 */
const checkBearerToken = (request: Request, expected: string | undefined): boolean => {
    if (!expected || expected.length === 0) {
        return false;
    }

    const authorization = request.headers.get("authorization");

    if (!authorization) {
        return false;
    }

    const [scheme, ...rest] = authorization.split(" ");

    if (scheme?.toLowerCase() !== "bearer") {
        return false;
    }

    return constantTimeEqual(expected, rest.join(" ").trim());
};

interface SchedulerDispatchCredentials {
    /** The admin bearer token, used when no signature is presented. */
    adminToken: string | undefined;
    /** The scheduler HMAC secret. When set, a request carrying a signature is verified against it. */
    schedulerSecret: string | undefined;
    /** Epoch-millisecond clock for the signature window. Defaults to `Date.now`. */
    now?: () => number;
}

/** The HMAC over {@link schedulerDispatchCanonical}, sent by the scheduler. */
const SCHEDULER_SIGNATURE_HEADER = "x-lunora-scheduler-signature";

/** The epoch-millisecond timestamp the signature was computed at, as a base-10 integer. */
const SCHEDULER_TIMESTAMP_HEADER = "x-lunora-scheduler-timestamp";

/**
 * How far a signature's timestamp may sit from the receiver's clock. Wide enough for
 * clock skew between the scheduler and the worker, narrow enough that a captured
 * request stops working within minutes.
 */
const SCHEDULER_SIGNATURE_TOLERANCE_MS = 5 * 60_000;

interface SchedulerDispatchSignatureInput {
    body: string;
    /** The `x-lunora-identity` header value as the receiver sees it. Absent counts as empty. */
    identity?: string;
    timestamp: number;
    /** The `x-lunora-userid` header value as the receiver sees it. Absent counts as empty. */
    userId?: string;
}

/**
 * The exact string the HMAC covers. The forwarded identity headers are part of it because
 * the receiver hands them to the shard with system privileges; a signature that leaves them
 * out would let anyone holding one signed request attach any identity to it. The body is
 * last so no field can be shifted into it.
 */
const schedulerDispatchCanonical = (input: SchedulerDispatchSignatureInput): string =>
    ["v1", String(input.timestamp), input.userId ?? "", input.identity ?? "", input.body].join("\n");

/** Sign a scheduler dispatch: the HMAC of {@link schedulerDispatchCanonical}. */
const signSchedulerDispatch = (secret: string, input: SchedulerDispatchSignatureInput): Promise<string> =>
    signCanonical(secret, schedulerDispatchCanonical(input));

/**
 * Authenticate a scheduler dispatch request.
 *
 * A signature the scheduler computed when both the header and the secret are present
 * wins. It covers the timestamp header, the forwarded identity headers and the raw
 * body, and it is refused outside {@link SCHEDULER_SIGNATURE_TOLERANCE_MS}. Otherwise
 * the admin bearer is the credential. The caller must pass the body text before any
 * parsing. Returns `false` (never throws) so the caller picks its own error code.
 */
const verifySchedulerDispatch = async (request: Request, rawBody: string, credentials: SchedulerDispatchCredentials): Promise<boolean> => {
    const signature = request.headers.get(SCHEDULER_SIGNATURE_HEADER);
    const { schedulerSecret } = credentials;

    if (signature !== null && signature.length > 0 && schedulerSecret !== undefined && schedulerSecret.length > 0) {
        const timestampHeader = request.headers.get(SCHEDULER_TIMESTAMP_HEADER);

        if (timestampHeader === null || !/^\d+$/u.test(timestampHeader)) {
            return false;
        }

        const timestamp = Number(timestampHeader);

        if (!Number.isSafeInteger(timestamp) || Math.abs((credentials.now ?? Date.now)() - timestamp) > SCHEDULER_SIGNATURE_TOLERANCE_MS) {
            return false;
        }

        const expected = await signSchedulerDispatch(schedulerSecret, {
            body: rawBody,
            identity: request.headers.get("x-lunora-identity") ?? undefined,
            timestamp,
            userId: request.headers.get("x-lunora-userid") ?? undefined,
        });

        return constantTimeEqual(expected, signature);
    }

    return checkBearerToken(request, credentials.adminToken);
};

export type { SchedulerDispatchCredentials, SchedulerDispatchSignatureInput };
export {
    AGENT_RUN_FUNCTION_PATH,
    AGENT_RUN_OFF_DEFAULT_SHARD_MESSAGE,
    checkBearerToken,
    isAgentRunOffDefaultShard,
    isReservedRelationFunctionPath,
    RELATION_FUNCTION_PREFIX,
    SCHEDULER_DISPATCH_PATH,
    SCHEDULER_SIGNATURE_HEADER,
    SCHEDULER_SIGNATURE_TOLERANCE_MS,
    SCHEDULER_TIMESTAMP_HEADER,
    schedulerDispatchCanonical,
    signSchedulerDispatch,
    verifySchedulerDispatch,
};
