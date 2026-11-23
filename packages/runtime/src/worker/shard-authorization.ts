import { RELAY_NAME_INFIX } from "../../../../shared/relay-name";
import { REPLICA_NAME_INFIX } from "../../../../shared/replica-name";
import { LunoraError } from "../errors";
import type { ResolvedIdentity } from "../identity-resolvers";
import type { WorkerRuntimeContext } from "./context";

/** The slice of an RPC envelope the authorization gate reads. */
interface AuthorizableEnvelope {
    fanOut?: FanOutTarget;
    functionPath: string;
    shardKey?: string;
}

interface FanOutTarget {
    table: string;
}

/**
 * Narrow an app-supplied authorization verdict to an exact `true`.
 *
 * SECURITY: every `WorkerOptions` gate below (`authorizeShard`,
 * `authorizeFanOut`, `adminGate`) is DECLARED to answer a boolean, but it is app
 * code and untyped JavaScript reaches it — `catch`-less `as` casts too. The
 * canonical mistake is `authorize: async ({ request }) => verifySignedUrl(url,
 * secret)` with `.valid` forgotten: it hands back `{ valid: false }`, a DENIAL
 * that is TRUTHY, and a `if (!allowed)` test then grants. Awaiting into `unknown`
 * and comparing to `true` means a broken gate can only ever deny.
 */
const grants = async (verdict: unknown): Promise<boolean> => (await verdict) === true;

/**
 * Per-shard authorization for a client-originated request, shared by the
 * RPC, REST, `serverQuery`, and WebSocket-upgrade paths: run
 * `authorizeShard` when configured (403 `FORBIDDEN_SHARD` on deny);
 * otherwise a non-default shard is default-denied via
 * {@link WorkerRuntimeContext.guardUnauthenticatedShardAccess}.
 *
 * Server-initiated dispatch does not call this — see
 * {@link WorkerOptions.authorizeShard} for why.
 *
 * `isAdmin` marks a request that already presented an admin credential. It
 * skips the TENANT policy — `authorizeShard` and the no-callback
 * default-deny — for the reason {@link WorkerOptions.authorizeShard}
 * documents: an admin request carries an admin bearer, not an end-user
 * session, so it resolves to a `null` identity that the recommended gate
 * (`identity?.userId !== undefined`) cannot distinguish from an anonymous
 * end user and denies. The reserved-name refusal below is NOT skipped: an
 * admin credential does not make `foo::relay::0` a well-formed shard key.
 */
const assertShardAuthorized = async (
    context: WorkerRuntimeContext,
    identity: ResolvedIdentity | null,
    shardKey: string,
    isAdmin = false,
    functionPath?: string,
): Promise<void> => {
    // `::relay::` / `::replica::` are RESERVED: only the runtime mints those
    // names, and a DO reads its own name to learn its role. A client-supplied
    // key carrying either infix therefore addresses a DO that believes it is
    // another shard's relay or replica — and this is the one gate every
    // client-originated key crosses (RPC, REST, `serverQuery`, WS upgrade), so
    // it is refused here rather than at each mint site. Ahead of
    // `authorizeShard`: the name is malformed whatever the policy says.
    if (shardKey.includes(RELAY_NAME_INFIX) || shardKey.includes(REPLICA_NAME_INFIX)) {
        throw new LunoraError("Forbidden shard", { code: "FORBIDDEN_SHARD", status: 403 });
    }

    if (isAdmin) {
        return;
    }

    if (context.authorizeShard) {
        const allowed = await grants(context.authorizeShard({ functionPath, identity, shardKey }));

        if (!allowed) {
            throw new LunoraError("Forbidden shard", { code: "FORBIDDEN_SHARD", status: 403 });
        }
    } else if (shardKey !== context.defaultShard) {
        context.guardUnauthenticatedShardAccess("shard");
    }
};

/**
 * Run the per-shard / fan-out authorization gate for an RPC envelope. Throws
 * a 403 `LunoraError` when the caller is not authorized. Fan-out is a
 * privileged op: when `authorizeShard` is set but `authorizeFanOut` is not,
 * fan-out is default-denied rather than silently allowed.
 */
// Fan-out authorization, extracted from `authorizeRpcEnvelope` to keep that
// function's cognitive complexity within budget. Fan-out envelopes target
// every live shard for the table (no client-named shardKey), so the per-shard
// gate cannot authorize them — `authorizeFanOut` gates fan-out at the table
// level, and the reserved `__lunora_relation__:*` read is always default-denied
// without it.
const authorizeFanOutEnvelope = async (
    context: WorkerRuntimeContext,
    fanOut: FanOutTarget,
    functionPath: string,
    identity: ResolvedIdentity | null,
): Promise<void> => {
    if (context.authorizeFanOut) {
        const allowed = await grants(context.authorizeFanOut(identity, fanOut.table, functionPath));

        if (!allowed) {
            throw new LunoraError("Forbidden fan-out", { code: "FORBIDDEN_FANOUT", status: 403 });
        }

        return;
    }

    if (functionPath.startsWith("__lunora_relation__:")) {
        // SECURITY: the reserved `__lunora_relation__:*` fan-out reads RAW,
        // RLS-blind rows from every shard (reverse cross-backend relations)
        // and — unlike `__lunora_admin__:*` — carries no DO-level token
        // backstop. So it must NEVER fall into the warn-and-allow open-posture
        // branch below: that would hand any caller a function-less full-table
        // dump across all shards. Default-deny it whenever `authorizeFanOut` is
        // absent, independent of `authorizeShard` (enabling reverse
        // cross-backend relations REQUIRES configuring `authorizeFanOut`).
        throw new LunoraError("reverse cross-backend relation reads (`__lunora_relation__:*`) require `authorizeFanOut` to be configured on the worker", {
            code: "FORBIDDEN_FANOUT",
            status: 403,
        });
    }

    if (context.authorizeShard) {
        // `authorizeShard` is configured but `authorizeFanOut` is not. Fan-out
        // is a privileged op (it bypasses the per-shard gate by design), so
        // default-deny instead of silently letting any authenticated caller
        // enumerate every shard for the table.
        throw new LunoraError("Fan-out requires `authorizeFanOut` to be configured on the worker when `authorizeShard` is set", {
            code: "FORBIDDEN_FANOUT",
            status: 403,
        });
    }

    // Neither callback configured: fan-out is default-denied unless the
    // operator explicitly opted into unauthenticated access.
    context.guardUnauthenticatedShardAccess("fan-out");
};

const authorizeRpcEnvelope = async (context: WorkerRuntimeContext, envelope: AuthorizableEnvelope, identity: ResolvedIdentity | null): Promise<void> => {
    // First, ahead of the fan-out branch below: every transport (RPC, batch, REST,
    // `serverQuery`, auth dispatch) funnels through here, and a fan-out reaches shards
    // a single-shard check never sees.
    context.assertAgentRunOnDefaultShard(envelope.functionPath, envelope.fanOut ? undefined : (envelope.shardKey ?? context.defaultShard));

    // Reserved admin RPCs (`__lunora_admin__:*`, single-shard) are privileged
    // operator calls authorized by the shard DO's admin-bearer gate
    // (`isAdminAuthorized`), NOT by the per-tenant `authorizeShard` callback —
    // an admin request carries an admin bearer, not an end-user session, so it
    // resolves to a `null` identity and `authorizeShard(null, …)` would
    // default-deny it. Skip the tenant gate so the request reaches the DO,
    // which is the real authority (and rejects a bad/absent bearer with its
    // own 403). Without this, ANY app that configures `authorizeShard` (the
    // recommended secure posture) would 403 every admin RPC — mail-capture,
    // recordAuthEvent, and the whole Studio admin surface — before it ever
    // reached the DO. A fan-out envelope with this prefix is NOT exempted: it
    // falls through to the fan-out branch below and is default-denied.
    if (!envelope.fanOut && envelope.functionPath.startsWith("__lunora_admin__:")) {
        return;
    }

    // Per-shard authorization runs after identity resolution and before the
    // request is forwarded. Fan-out routes through the table-level gate;
    // single-shard dispatch goes through `authorizeShard`.
    if (envelope.fanOut) {
        await authorizeFanOutEnvelope(context, envelope.fanOut, envelope.functionPath, identity);

        return;
    }

    // No per-shard gate and the caller named a non-default shard:
    // default-denied unless unauthenticated shard access is opted in.
    await assertShardAuthorized(context, identity, envelope.shardKey ?? context.defaultShard, false, envelope.functionPath);
};

export type { AuthorizableEnvelope };
export { assertShardAuthorized, authorizeRpcEnvelope, grants };
