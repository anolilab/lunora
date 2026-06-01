/**
 * Test entry-point Worker for the `@cloudflare/vitest-pool-workers` Miniflare
 * runtime.
 *
 * The pool boots this worker inside a real `workerd` process. Our tests then
 * use `cloudflare:test`'s `env`, `runInDurableObject`, and `runDurableObjectAlarm`
 * helpers to drive the DOs declared below.
 *
 * The previous revision installed a `toShardState` adapter that flipped the
 * legacy `state.serializeAttachment(ws, value)` shape onto the runtime-native
 * `ws.serializeAttachment(value)` API. Now that `ShardDO` itself calls the
 * runtime API directly the adapter is gone and `DurableObjectState` is
 * passed straight through — structurally compatible with `ShardDOState`.
 */
import { DurableObject } from "cloudflare:workers";

import { SessionDO } from "../../src/session-do.js";
import type { ShardDOState } from "../../src/shard-do.js";
import { ShardDO } from "../../src/shard-do.js";
import type { MutationDelta } from "../../src/types.js";

export interface Env {
    CIRRUS_ALLOWED_ORIGINS?: string;
    SESSION: DurableObjectNamespace<TestSessionDO>;
    SHARD: DurableObjectNamespace<TestShardDO>;
}

export class TestShardDO extends DurableObject<Env> {
    private readonly shard: ConcreteShard;

    public rpcResult: unknown = { ok: true };

    public lastRpcCall: { args: Record<string, unknown>; functionPath: string } | undefined;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.shard = new ConcreteShard(ctx as unknown as ShardDOState, env, this);
    }

    public override fetch(request: Request): Promise<Response> {
        return this.shard.fetch(request);
    }

    public override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        return this.shard.webSocketMessage(ws, message);
    }

    public override webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
        return this.shard.webSocketClose(ws, code, reason, wasClean);
    }

    public broadcast(delta: MutationDelta): void {
        this.shard.broadcastDelta(delta);
    }
}

class ConcreteShard extends ShardDO {
    constructor(
        state: ShardDOState,
        env: unknown,
        private readonly outer: TestShardDO,
    ) {
        super(state, env);
    }

    public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        this.outer.lastRpcCall = { functionPath, args };

        return this.outer.rpcResult;
    }

    public override broadcastDelta(delta: MutationDelta): void {
        super["broadcastDelta"](delta);
    }
}

export class TestSessionDO extends DurableObject<Env> {
    private readonly session: SessionDO;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.session = new SessionDO(ctx, env);
    }

    public override fetch(request: Request): Promise<Response> {
        return this.session.fetch(request);
    }
}

export default {
    async fetch(_request: Request, _env: Env): Promise<Response> {
        return new Response("test-worker", { status: 200 });
    },
};
