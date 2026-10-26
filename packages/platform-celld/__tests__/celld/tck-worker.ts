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
 * The platform suite's `SchedulerHost` legs run against `SchedulerDO` through
 * `@lunora/scheduler`'s `createSchedulerHost`, one scheduler cell per leg. Its
 * delivery is recorded rather than sent (see {@link TckScheduler}), so the
 * at-least-once leg sees celld fire the cell's alarm and drain the job.
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
import { ShardDO } from "@lunora/do";
import { CELLD_CAPABILITIES } from "@lunora/platform";
import type { ConformanceHost } from "@lunora/platform/conformance";
import { createShardDirectory } from "@lunora/platform-cloudflare";
import type { ShardNamespaceLike } from "@lunora/runtime";
import { createWorker } from "@lunora/runtime";
import type { ScheduleRecord } from "@lunora/scheduler";
import { createSchedulerHost, SchedulerDO } from "@lunora/scheduler";
import { defineLiveStream, httpAction, httpRouter, v } from "@lunora/server";
import type { EngineHostFactory } from "@lunora/shard-engine/conformance";

import { createCelldShardPlatform } from "../../src/celld-platform";
import type { BindingEnv } from "./tck-bindings";
import { consumeQueue, handleBindingRoute, recordCron } from "./tck-bindings";
import { createLegExpect } from "./tck-expect";
import type { Factories, LegContext, LegResult, SuiteName } from "./tck-legs";
import { collectLegs, describeFailure, LegSkipped } from "./tck-legs";

type Env = BindingEnv & {
    ECHO: unknown;
    LIVE_SHARD: ShardNamespaceLike;
    SCHEDULER: Parameters<typeof createSchedulerHost>[0]["namespace"];
    TCK: DurableObjectNamespace;
};

/** The KV key {@link TckScheduler} records a delivered job under. */
const dispatchedKey = (id: string): string => `tck:dispatched:${id}`;

/** The {@link TckScheduler} route that answers once a job has been dispatched. */
const DISPATCHED_ROUTE = "/tck/dispatched";

/**
 * The live stream an app declares with `defineLiveStream`. It declares only the
 * `tck:<name>` topic, so the leg can show a topic it did not subscribe to is never
 * delivered. Its connect and control routes are the shard's own handlers.
 */
const feed = defineLiveStream({
    id: "tck-feed",
    onSubscribe: ({ topic }) => topic === "tck",
    topics: { tck: { key: { name: v.string() }, payload: v.object({ n: v.number() }) } },
});

/** The worker's HTTP routes for the real live path: the stream plus a publish action. */
const buildLiveApp = () => {
    const app = httpRouter();

    app.get(feed.connectPath, feed.connect);
    app.post(feed.controlPath, feed.control);
    app.post(
        "/tck-live/publish",
        httpAction(async (ctx, request) => {
            const body: { data: unknown; topic: string } = await request.json();

            await ctx.live.publish({ __lunoraLive: feed.id, topic: body.topic }, body.data);

            return Response.json({ published: true });
        }),
    );

    return app;
};

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
    // A scheduler cell of its own per leg, so one leg's jobs never show in another's listing.
    const schedulerName = `tck-${crypto.randomUUID()}`;

    return {
        capabilities: CELLD_CAPABILITIES,
        cleanup: () => {
            // eslint-disable-next-line no-void -- `cleanup` is synchronous by contract; disarming is fire-and-forget
            void state.storage.deleteAlarm();
        },
        createSocket: mintSocket,
        directory: createShardDirectory(env.ECHO as Parameters<typeof createShardDirectory>[0]),
        // Same as Cloudflare: `runSerialized` is `blockConcurrencyWhile`, so
        // there is no "outside" a mutation inside one cell event to read from.
        isolatesByDispatch: true,
        // Resolves when the scheduler cell's alarm has fired and drained the job — the
        // dispatch itself answers, so a slow alarm is only bounded by the test timeout.
        awaitJobDispatched: async (id) => {
            const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName(schedulerName));
            const response = await stub.fetch(`https://scheduler${DISPATCHED_ROUTE}?id=${encodeURIComponent(id)}`);

            return response.ok;
        },
        kv: platform.kv,
        scheduler: createSchedulerHost({ instanceName: schedulerName, namespace: env.SCHEDULER }),
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
 * same socket delivers to a real network client, which `celld-tck.test.ts`
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

        return { message: describeFailure(error), status: "failed" };
    }
};

/**
 * Open SSE subscribers held by the `live` cell. A `/live/publish` fans out to
 * each one. Module-level, so it lives exactly as long as the cell does.
 */
const liveSubscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();

/**
 * `GET /live`: an SSE body the cell keeps open until the client cancels it.
 * The subscriber is registered inside `start`, so it is in place before the
 * response is returned to the node proxy.
 */
const liveConnect = (): Response => {
    const encoder = new TextEncoder();
    let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
        cancel() {
            if (subscriber !== undefined) {
                liveSubscribers.delete(subscriber);
            }
        },
        start(controller) {
            subscriber = controller;
            liveSubscribers.add(controller);
            controller.enqueue(encoder.encode(": connected\n\n"));
        },
    });

    return new Response(body, {
        headers: { "cache-control": "no-cache, no-transform", "content-type": "text/event-stream; charset=utf-8" },
    });
};

/** `POST /live/publish`: one single-line frame to every open subscriber. */
const livePublish = async (payload: string): Promise<Response> => {
    const frame = new TextEncoder().encode(`event: live\ndata: ${payload}\n\n`);

    for (const subscriber of liveSubscribers) {
        subscriber.enqueue(frame);
    }

    return Response.json({ delivered: liveSubscribers.size });
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

        if (url.pathname === "/live") {
            return liveConnect();
        }

        if (url.pathname === "/live/publish") {
            return livePublish(await request.text());
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

/**
 * The shard the live stream runs on: `ShardDO` itself, the class an app's
 * generated shard extends. Only the RPC table is stubbed, since the live routes
 * never dispatch through it.
 */
class TckShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- a dispatch stub has no instance state to reach for
    public handleRpc(functionPath: string): Promise<unknown> {
        return Promise.resolve({ functionPath });
    }
}

/**
 * `SchedulerDO` with its delivery recorded instead of sent. The real dispatch
 * POSTs to `LUNORA_ORIGIN_URL`, which `celld dev` on a free port cannot know
 * ahead of time; what the leg checks is the part celld owns — that the cell's
 * alarm fires and the drain hands the job to `dispatch` — so `dispatch` (the
 * hook `SchedulerDO` documents for this) writes the job id to KV and wakes the
 * `awaitJobDispatched` request parked on this cell.
 */
class TckScheduler extends SchedulerDO {
    /** The `awaitJobDispatched` calls parked on this cell, by job id. */
    private readonly waiters = new Map<string, () => void>();

    public override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname !== DISPATCHED_ROUTE) {
            return super.fetch(request);
        }

        const id = url.searchParams.get("id") ?? "";
        // Parked before the KV read: a dispatch landing during that read still
        // finds the waiter. The KV record covers the job that fired before this
        // request arrived (it is scheduled 30 ms out), even on a fresh instance.
        const dispatched = new Promise<void>((resolve) => {
            this.waiters.set(id, resolve);
        });

        if ((await (this.env as unknown as Env).KV.get(dispatchedKey(id))) === null) {
            await dispatched;
        }

        this.waiters.delete(id);

        return new Response("dispatched");
    }

    protected override async dispatch(record: ScheduleRecord): Promise<boolean> {
        await (this.env as unknown as Env).KV.put(dispatchedKey(record.id), "1");
        this.waiters.get(record.id)?.();

        return true;
    }
}

export { EchoCell, TckCell, TckScheduler, TckShard };
export { TckWorkflow, VectorCell } from "./tck-bindings";
export { ShardRegistryDO } from "@lunora/do";

// A Workers entry module: the runtime reads the handlers off the default export
// and each Durable Object class by name, so this file has to mix both.
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        // The live stream and its publish action go through `createWorker`, so
        // `ctx.live.publish` and the stream routes reach `TckShard` the way a
        // Lunora app's worker reaches its shard.
        if (url.pathname.startsWith("/live/tck-feed/") || url.pathname === "/tck-live/publish") {
            return createWorker({ httpRouter: buildLiveApp(), shardDO: env.LIVE_SHARD }).fetch(request, env, ctx);
        }

        if (url.pathname === "/transport") {
            return env.TCK.get(env.TCK.idFromName("transport")).fetch(request);
        }

        if (url.pathname === "/fleet") {
            return env.TCK.get(env.TCK.idFromName(url.searchParams.get("name") ?? "fleet")).fetch(request);
        }

        // Both routes name one cell, so a publish reaches the subscribers an open `/live` holds.
        if (url.pathname === "/live" || url.pathname === "/live/publish") {
            return env.TCK.get(env.TCK.idFromName("live")).fetch(request);
        }

        if (url.pathname.startsWith("/binding/")) {
            return Response.json(await handleBindingRoute(request, env));
        }

        if (url.pathname !== "/leg") {
            return new Response("not found", { status: 404 });
        }

        return env.TCK.get(env.TCK.newUniqueId()).fetch(request);
    },

    async queue(batch: MessageBatch, env: Env): Promise<void> {
        await consumeQueue(batch, env);
    },

    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
        await recordCron(controller, env);
    },
};
