/**
 * `@lunora/shard-engine`'s contract suite, run against the real Cloudflare host
 * in workerd.
 *
 * The sibling run in `packages/shard-engine` uses the platform reference host.
 * This one is the same suite over a genuine `DurableObjectState` — real SQLite,
 * real hibernatable sockets, real `acceptWebSocket` tagging. Anything the
 * reference host lets pass because it is in-memory (a memo keyed on a handle
 * that turns out not to be identity-stable, a frame that never leaves the
 * socket) fails here instead.
 *
 * Mechanics mirror `cloudflare-host.workerd.test.ts`: the suite's `it` is
 * injected, so every body runs inside `runInDurableObject`, and the host is
 * built through the composition root (`createShardPlatform`) rather than the
 * individual adapters — so a wiring mistake in the root fails here too.
 */
import type { SocketHandle } from "@lunora/platform";
import { createShardPlatform } from "@lunora/platform-cloudflare";
import type { EngineHostFactory } from "@lunora/shard-engine/conformance";
import { defineEngineContractSuite } from "@lunora/shard-engine/conformance";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The `DurableObjectState` of the object the current test body runs inside.
 * Set by the `it` wrapper immediately before the body, read by the factory the
 * suite calls from within it.
 */
let currentState: DurableObjectState | undefined;

/**
 * Client ends of the sockets minted for the running test, keyed by the id the
 * host issued for the server end.
 *
 * Two jobs. Holding the client end keeps the runtime from tearing the accepted
 * server end down mid-test. Reading its `received` buffer is how `readFrames`
 * answers — on a real transport the only observer of a `send` is the peer.
 */
// eslint-disable-next-line vitest/require-hook -- module-scope test state, reset per test by the `it` wrapper rather than by a hook (the suite owns the hooks)
let peers = new Map<SocketHandle, { received: string[]; ws: WebSocket }>();

/** The most recently minted peer, awaiting the id its server end is about to get. */
let pendingPeer: { received: string[]; ws: WebSocket } | undefined;

const createEngineHost: EngineHostFactory = () => {
    const state = currentState;

    if (state === undefined) {
        throw new Error("no DurableObjectState in scope — the conformance body ran outside runInDurableObject");
    }

    const platform = createShardPlatform(state);
    const { sockets } = platform;

    return {
        cleanup: undefined,
        createSocket: () => {
            const pair = new WebSocketPair();

            // Only mint here. Accepting the client end marks the pair as used,
            // and `state.acceptWebSocket` then refuses the server end — so the
            // client side is opened in the `accept` wrapper below, once the host
            // has taken its end.
            pendingPeer = { received: [], ws: pair[0] };

            return pair[1];
        },
        host: platform.shard,
        readFrames: async (socket) => {
            // A `send` reaches the peer through an event, so yield until the
            // runtime has actually delivered what is already queued. Reading
            // synchronously would report an empty buffer for a frame that did
            // leave the socket — a false failure that looks exactly like a
            // delivery bug.
            await scheduler.wait(0);

            return peers.get(socket)?.received ?? [];
        },
        // `accept` is wrapped rather than passed through so the peer minted by
        // `createSocket` can be keyed on the handle the host issues — the suite
        // knows sockets only by their handle, and the handle is the only thing
        // that links the two ends.
        //
        // Keyed on the handle OBJECT, not on an id: the Cloudflare host returns
        // the transport socket as the handle, so the object the suite holds is
        // the same one the runtime hands to `webSocketMessage`. A wrapping host
        // would still work here — one handle per socket is the contract either
        // way — but object keying is what proves the identity did not split.
        sockets: {
            ...sockets,
            accept: (socket, attachment, tags) => {
                const handle = sockets.accept(socket, attachment, tags);

                if (pendingPeer !== undefined) {
                    const peer = pendingPeer;

                    peer.ws.addEventListener("message", (event) => {
                        if (typeof event.data === "string") {
                            peer.received.push(event.data);
                        }
                    });
                    peer.ws.accept();
                    peers.set(handle, peer);
                    pendingPeer = undefined;
                }

                return handle;
            },
        },
    };
};

/**
 * `it`, but the body runs inside a fresh Durable Object. Each test gets its own
 * object so SQL tables and sockets from one never bleed into the next.
 */
const itInDurableObject = ((name: string, body: () => Promise<void> | void) => {
    // The assertions live in the injected suite's bodies, not here — this
    // wrapper only supplies the Durable Object context they run in.
    // eslint-disable-next-line vitest/expect-expect, vitest/require-top-level-describe, vitest/prefer-expect-assertions, sonarjs/assertions-in-tests -- generic test-runner adapter; `defineEngineContractSuite` owns the describe blocks and the assertions
    it(name, async () => {
        const stub = env.SHARD.get(env.SHARD.newUniqueId());

        await runInDurableObject(stub, async (_instance, state) => {
            currentState = state;

            try {
                await body();
            } finally {
                currentState = undefined;
                peers = new Map();
                pendingPeer = undefined;
            }
        });
    });
}) as unknown as typeof it;

// eslint-disable-next-line vitest/require-hook -- `defineEngineContractSuite` *is* the suite: it registers describe/it blocks at module scope, which is exactly where they belong
defineEngineContractSuite("cloudflare (@lunora/do)", createEngineHost, { describe, expect, it: itInDurableObject });
