/**
 * The TCK worker `celld dev` runs: both conformance suites, executed inside
 * real celld cells through `createCelldShardPlatform`.
 *
 * `GET /leg` runs one leg — named by its `suite` (platform or engine) and
 * `index` query parameters, see `tck-legs.ts` — inside a brand-new cell, so SQL tables, sockets and alarms
 * from one leg never bleed into the next, and answers
 * `{ status: "passed" | "failed" | "skipped", message? }`.
 *
 * `GET /transport` (a WebSocket upgrade) is the socket leg the suites cannot
 * run from inside a cell: a real network client on a hibernation-accepted
 * socket, through the celld host's `SocketHost`.
 *
 * `/fleet?name=…` reads (GET) or writes (PUT, body as value) one key in the
 * named cell through the celld host's `ShardKvStore` — the probe the
 * multi-node test (`celld-fleet.test.ts`) drives from different nodes.
 *
 * The hosts are built the way `@lunora/do`'s workerd harnesses build them —
 * through the composition root, over the cell's genuine `DurableObjectState` —
 * so this run covers the celld adapters AND their assembly, against celld's
 * own SQLite, alarms and hibernation API rather than a double.
 */
import type { ConformanceHost } from "@lunora/platform/conformance";
import { createShardDirectory } from "@lunora/platform-cloudflare";
import type { EngineHostFactory } from "@lunora/shard-engine/conformance";

import { createCelldShardPlatform } from "../../src/celld-platform";
import { createLegExpect } from "./tck-expect";
import type { Factories, LegContext, SuiteName } from "./tck-legs";
import { collectLegs, LegSkipped } from "./tck-legs";

type Env = { ECHO: unknown; TCK: DurableObjectNamespace };

type LegResult = { message?: string; status: "failed" | "passed" | "skipped" };

/** The cell the running leg executes in; set around each body. */
let current: { env: Env; pairs: WebSocket[]; state: DurableObjectState } | undefined;

/**
 * The real `WebSocket.prototype.send`, restored after every leg (see
 * `recordSends`). Held as its property descriptor so the method is never
 * detached from a receiver.
 */
const nativeSend = Object.getOwnPropertyDescriptor(WebSocket.prototype, "send");

const restoreSend = (): void => {
    if (nativeSend !== undefined) {
        Object.defineProperty(WebSocket.prototype, "send", nativeSend);
    }
};

const inScope = (): NonNullable<typeof current> => {
    if (current === undefined) {
        throw new Error("no cell in scope — the conformance body ran outside a TCK cell");
    }

    return current;
};

/** Mint a socket the host can accept; the client end stays referenced for the leg. */
const mintSocket = (): WebSocket => {
    const pair = new WebSocketPair();

    inScope().pairs.push(pair[0]);

    return pair[1];
};

const createPlatformHost = (): ConformanceHost => {
    const { env, state } = inScope();
    const platform = createCelldShardPlatform(state);

    return {
        cleanup: () => {
            // eslint-disable-next-line no-void -- `cleanup` is synchronous by contract; disarming is fire-and-forget
            void state.storage.deleteAlarm();
        },
        createSocket: mintSocket,
        directory: createShardDirectory(env.ECHO as Parameters<typeof createShardDirectory>[0]),
        // Same as Cloudflare: `runSerialized` is `blockConcurrencyWhile`, so
        // there is no "outside" a mutation inside one cell event to read from.
        isolatesByDispatch: true,
        kv: platform.kv,
        shard: platform.shard,
        socket: platform.sockets,
    };
};

/**
 * Record every frame the host sends, keyed by the host's own socket id.
 *
 * The workerd harness reads frames off the client end of a `WebSocketPair`.
 * That does not work on celld: a frame sent through a socket accepted with
 * `acceptWebSocket` is never delivered to a peer inside the same cell (the
 * same socket delivers to a real network client, which `celld-tck.celld.test.ts`
 * asserts separately). So this harness observes the frames where the host
 * hands them to the transport instead. Patching the prototype, not the minted
 * instance, matters: `getWebSockets(tag)` can hand back a different object for
 * the same socket, and a fan-out goes through that one.
 */
const recordSends = (idFor: (socket: unknown) => string | undefined): Map<string, string[]> => {
    const frames = new Map<string, string[]>();

    Object.defineProperty(WebSocket.prototype, "send", {
        ...nativeSend,
        value(this: WebSocket, data: unknown): void {
            const id = idFor(this);

            if (id !== undefined && typeof data === "string") {
                frames.set(id, [...(frames.get(id) ?? []), data]);
            }

            Reflect.apply(nativeSend?.value as (data: unknown) => void, this, [data]);
        },
    });

    return frames;
};

const createEngineHost: EngineHostFactory = () => {
    const { state } = inScope();
    const { shard, sockets } = createCelldShardPlatform(state);
    const frames = recordSends((socket) => {
        const handle = sockets.handleFor(socket);

        return handle === undefined ? undefined : sockets.idFor(handle);
    });

    return {
        close: restoreSend,
        createSocket: mintSocket,
        host: shard,
        readFrames: (socket) => frames.get(sockets.idFor(socket)) ?? [],
        sockets,
    };
};

const factories: Factories = { engine: createEngineHost, platform: createPlatformHost };

const runLeg = async (suite: SuiteName, index: number): Promise<LegResult> => {
    const { expect, verify } = createLegExpect();
    const leg = collectLegs(suite, factories, expect)[index];

    if (leg === undefined) {
        return { message: `no leg ${String(index)} in the ${suite} suite`, status: "failed" };
    }

    const context: LegContext = {
        skip: (reason) => {
            throw new LegSkipped(reason);
        },
    };

    try {
        await leg.body(context);
        verify();

        return { status: "passed" };
    } catch (error) {
        if (error instanceof LegSkipped) {
            return { message: error.message, status: "skipped" };
        }

        return { message: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error), status: "failed" };
    }
};

/** The cell every leg runs in, and the cell `/transport` clients connect to. */
class TckCell {
    public constructor(
        private readonly state: DurableObjectState,
        private readonly env: Env,
    ) {}

    public async fetch(request: Request): Promise<Response> {
        if (request.headers.get("upgrade") === "websocket") {
            return this.acceptTransport();
        }

        const url = new URL(request.url);

        if (url.pathname === "/fleet") {
            return this.fleetProbe(request);
        }

        const suite = url.searchParams.get("suite") as SuiteName;
        const index = Number(url.searchParams.get("index"));

        current = { env: this.env, pairs: [], state: this.state };

        try {
            return Response.json(await runLeg(suite, index));
        } finally {
            current = undefined;
            restoreSend();
        }
    }

    /**
     * Echo a client's frame back and fan it out to every socket in the room,
     * each through the host: the echo proves a woken cell can send on the socket
     * it was handed, the fan-out that `getSockets(tag)` finds hibernated peers,
     * and the id in each frame that `idFor` survives the wake.
     */
    public async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
        const { sockets } = createCelldShardPlatform(this.state);
        const handle = sockets.handleFor(socket);
        const text = typeof message === "string" ? message : `<${String(message.byteLength)} bytes>`;

        if (handle === undefined) {
            socket.close(1011, "socket not known to the host");

            return;
        }

        handle.send(`echo:${sockets.idFor(handle)}:${text}`);

        for (const peer of sockets.getSockets("room")) {
            peer.send(`fanout:${text}`);
        }
    }

    private async fleetProbe(request: Request): Promise<Response> {
        const { kv } = createCelldShardPlatform(this.state);

        if (request.method === "PUT") {
            await kv.put("value", await request.text());

            return new Response("stored");
        }

        return new Response((await kv.get<string>("value")) ?? "");
    }

    private acceptTransport(): Response {
        const { sockets } = createCelldShardPlatform(this.state);
        const pair = new WebSocketPair();
        const handle = sockets.accept(pair[1], { joined: Date.now() }, ["room"]);

        handle.send(`welcome:${sockets.idFor(handle)}`);

        return new Response(null, { status: 101, webSocket: pair[0] });
    }
}

/** The `ShardDirectory` target: answers with its own id, so two resolves of one key compare equal. */
class EchoCell {
    public constructor(private readonly state: DurableObjectState) {}

    public async fetch(request: Request): Promise<Response> {
        return new Response(`${new URL(request.url).pathname}:${this.state.id.toString()}`);
    }
}

export { EchoCell, TckCell };

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/transport") {
            return env.TCK.get(env.TCK.idFromName("transport")).fetch(request);
        }

        if (url.pathname === "/fleet") {
            return env.TCK.get(env.TCK.idFromName(url.searchParams.get("name") ?? "fleet")).fetch(request);
        }

        if (url.pathname !== "/leg") {
            return new Response("not found", { status: 404 });
        }

        return env.TCK.get(env.TCK.newUniqueId()).fetch(request);
    },
};
