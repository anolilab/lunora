/**
 * Test entry-point Worker for the bearer-gated WebSocket suite.
 *
 * `LUNORA_WS_BEARER` is a deployment setting, and the shared test worker runs
 * ungated, so the gate is booted here as its own project. The binding is supplied
 * by the vitest config, not by this file.
 */
import { DurableObject } from "cloudflare:workers";

import type { ShardDOState } from "../../../src/shard-do";
import { ShardDO } from "../../../src/shard-do";

class GatedShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- test double: this shard serves sockets only, never an RPC
    public override async handleRpc(): Promise<unknown> {
        return null;
    }
}

class GatedShardDO extends DurableObject {
    private readonly shard: GatedShard;

    public constructor(context: DurableObjectState, env: Cloudflare.Env) {
        super(context, env);
        this.shard = new GatedShard(context as unknown as ShardDOState, env);
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
}

const handler = {
    async fetch(): Promise<Response> {
        return new Response("ws-gate test worker", { status: 200 });
    },
};

export default handler;
export { GatedShardDO };
