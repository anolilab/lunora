/**
 * Integration test worker for `@cirrus/client`.
 *
 * Boots the real `@cirrus/runtime` (HTTP routing + shard forwarding) on top of
 * a real `ShardDO` (WebSocket Hibernation API + SQLite-in-DO). The test uses
 * `SELF.fetch` against this worker to exercise `CirrusClient` end-to-end.
 *
 * `TestShardDO` is a thin subclass that captures the most recent RPC call and
 * lets the test trigger a broadcast — that's the contract `CirrusClient`
 * actually depends on (function dispatch + delta fan-out).
 */
import type { MutationDelta, ShardDOState } from "@cirrus/do";
import { ShardDO } from "@cirrus/do";
import { createWorker } from "@cirrus/runtime";
import { DurableObject } from "cloudflare:workers";

export interface Env {
    SHARD: DurableObjectNamespace<TestShardDO>;
}

export class TestShardDO extends DurableObject<Env> {
    private readonly shard: ConcreteShard;

    public rpcResult: unknown = null;

    public lastRpcCall: { args: Record<string, unknown>; functionPath: string } | undefined;

    public constructor(context: DurableObjectState, env: Env) {
        super(context, env);
        this.shard = new ConcreteShard(context as unknown as ShardDOState, env, this);
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
    public constructor(
        state: ShardDOState,
        env: unknown,
        private readonly outer: TestShardDO,
    ) {
        super(state, env);
    }

    public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        this.outer.lastRpcCall = { args, functionPath };

        return this.outer.rpcResult;
    }

    public override broadcastDelta(delta: MutationDelta): void {
        super["broadcastDelta"](delta);
    }
}

export default {
    async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
        const runtime = createWorker({ shardDO: env.SHARD as never });

        return runtime.fetch(request, env, context);
    },
};
