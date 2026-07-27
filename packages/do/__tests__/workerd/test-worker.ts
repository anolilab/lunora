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
import type { MutationDelta } from "@lunora/shard-engine";
import type { DatabaseWriterLike } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { DurableObject } from "cloudflare:workers";

import { SessionDO } from "../../src/session-do";
import type { ShardDOState } from "../../src/shard-do";
import { ShardDO } from "../../src/shard-do";
import messagesSchema from "../_helpers/messages-schema";

interface Env {
    ECHO: DurableObjectNamespace<TestEchoDO>;
    LUNORA_ALLOWED_ORIGINS?: string;
    SESSION: DurableObjectNamespace<TestSessionDO>;
    SHARD: DurableObjectNamespace<TestShardDO>;
    SYNC: DurableObjectNamespace<TestSyncDO>;
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

class TestShardDO extends DurableObject<Env> {
    public rpcResult: unknown = { ok: true };

    public lastRpcCall: { args: Record<string, unknown>; functionPath: string } | undefined;

    private readonly shard: ConcreteShard;

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

    /**
     * Deliver alarms to the shard. Without this override workerd has no alarm
     * handler to wake, so any alarm the host-contract suite (or the global-poll
     * loop) arms would surface as a runtime error instead of a dispatch.
     */
    public override alarm(): Promise<void> {
        return this.shard.alarm();
    }

    public broadcast(delta: MutationDelta): void {
        this.shard.broadcastDelta(delta);
    }
}

/**
 * A minimal Durable Object that echoes its own id.
 *
 * The `ShardDirectory` conformance tests need a dispatch target whose response
 * body is a pure function of *which* object was resolved — that is what makes
 * "the same shard key resolves to the same shard" an observable assertion
 * rather than a coincidence of two identical 404s.
 */
class TestEchoDO extends DurableObject<Env> {
    public override async fetch(request: Request): Promise<Response> {
        return new Response(`${new URL(request.url).pathname}:${this.ctx.id.toString()}`);
    }
}

/**
 * A real, sync-engine-capable `ShardDO` for the local-first poke protocol e2e.
 *
 * Unlike {@link ConcreteShard} (an RPC echo), this subclass runs migrations and
 * writes through a real `createShardCtxDb` writer inside the live Durable
 * Object, so the full pipeline executes against workerd's SQLite + the
 * Hibernation WebSocket API.
 *
 * The `messagesByChannel(channelId)` shape seeds the current membership on
 * `shape_subscribe` and each write pokes the membership diff. The
 * `messages:sendMutator` custom mutator orders a watermarked push (`clientId` +
 * numeric `clientSeq`) against `__client_watermark`, writes authoritatively, and
 * echoes the applied `lastMutationId` on the response.
 */
class ConcreteSyncShard extends ShardDO {
    private migrated = false;

    private writer: DatabaseWriterLike | undefined;

    public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        const writer = this.getWriter();

        switch (functionPath) {
            case "messages:remove": {
                await writer.delete(args["_id"] as string);

                break;
            }
            case "messages:send":
            case "messages:sendMutator": {
                await writer.insert(
                    "messages",
                    { _id: args["_id"], authorId: args["authorId"] ?? "u1", channelId: args["channelId"], text: args["text"] ?? "x" },
                    { allowExplicitId: true },
                );

                break;
            }
            default: {
                break;
            }
        }

        this.recordChangedTable("messages");

        return { id: args["_id"], ok: true };
    }

    // eslint-disable-next-line class-methods-use-this -- override classifies by `functionPath` alone, no instance state.
    protected override isCustomMutator(functionPath: string): boolean {
        return functionPath === "messages:sendMutator";
    }

    protected override resolveShape(
        name: string,
        args: Record<string, unknown>,
        identity?: { userId?: string },
    ): { effectiveWhere?: Record<string, unknown>; table: string } | undefined {
        this.ensureMigrated();

        // Identity-INDEPENDENT (relay-uniform): the where depends only on args, so
        // every caller resolves the same query — eligible for relay multicast.
        if (name === "messagesByChannel") {
            return { effectiveWhere: { channelId: args["channelId"] }, table: "messages" };
        }

        // Identity-DEPENDENT (non-uniform): scoped to the caller, so it must stay
        // owner-served and never be registered for relay multicast (plan 075 C2).
        if (name === "myInbox") {
            return { effectiveWhere: { authorId: identity?.userId ?? "anon" }, table: "messages" };
        }

        return undefined;
    }

    protected override ensureMigrated(): void {
        if (this.migrated) {
            return;
        }

        runShardMigrations(this.sql as Parameters<typeof runShardMigrations>[0], messagesSchema, { cdc: true });
        this.migrated = true;
    }

    private getWriter(): DatabaseWriterLike {
        this.ensureMigrated();
        this.writer ??= createShardCtxDb({
            broadcast: () => undefined,
            cdc: true,
            clock: () => 1_700_000_000_000,
            schema: messagesSchema,
            sql: this.sql as Parameters<typeof createShardCtxDb>[0]["sql"],
        });

        return this.writer;
    }
}

class TestSyncDO extends DurableObject<Env> {
    private readonly shard: ConcreteSyncShard;

    public constructor(context: DurableObjectState, env: Env) {
        super(context, env);
        this.shard = new ConcreteSyncShard(context as unknown as ShardDOState, env);
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

    /**
     * Accept-time tags of every live socket, for the durable-socket-id test.
     *
     * Exposed here because the property under test — that `ShardDO`'s upgrade
     * path accepts through `SocketHost` rather than calling
     * `state.acceptWebSocket` directly — is only observable from inside the DO.
     */
    public socketTags(): string[][] {
        return this.ctx.getWebSockets().map((ws) => this.ctx.getTags(ws));
    }
}

class TestSessionDO extends DurableObject<Env> {
    private readonly session: SessionDO;

    public constructor(context: DurableObjectState, env: Env) {
        super(context, env);
        this.session = new SessionDO(context, env);
    }

    public override fetch(request: Request): Promise<Response> {
        return this.session.fetch(request);
    }
}

const handler = {
    async fetch(_request: Request, _env: Env): Promise<Response> {
        return new Response("test-worker", { status: 200 });
    },
};

export default handler;
export { TestEchoDO, TestSessionDO, TestShardDO, TestSyncDO };
export type { Env };
