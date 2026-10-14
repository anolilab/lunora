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
}

/**
 * Authenticate a scheduler dispatch request.
 *
 * A signature the scheduler computed over the exact `rawBody` wins when both the
 * header and the secret are present. Otherwise the admin bearer is the credential.
 * The HMAC covers the raw bytes, so the caller must pass the body text before any
 * parsing. Returns `false` (never throws) so the caller picks its own error code.
 */
const verifySchedulerDispatch = async (request: Request, rawBody: string, credentials: SchedulerDispatchCredentials): Promise<boolean> => {
    const signature = request.headers.get("x-lunora-scheduler-signature");
    const { schedulerSecret } = credentials;

    if (signature !== null && signature.length > 0 && schedulerSecret !== undefined && schedulerSecret.length > 0) {
        return constantTimeEqual(await signCanonical(schedulerSecret, rawBody), signature);
    }

    return checkBearerToken(request, credentials.adminToken);
};

export type { SchedulerDispatchCredentials };
export { checkBearerToken, isReservedRelationFunctionPath, RELATION_FUNCTION_PREFIX, SCHEDULER_DISPATCH_PATH, verifySchedulerDispatch };
