import { describe, expect, it } from "vitest";

import { createSocketHost } from "../src/cloudflare-host";

/**
 * The Cloudflare socket host's identity and ownership rules.
 *
 * The load-bearing property is that **the runtime socket IS the `SocketHandle`**.
 * This host used to return a `CloudflareSocketHandle` wrapper, which cost two
 * extra call frames per socket on every fan-out (+11-13% on whisper delivery at
 * 128 and 1024 subscribers) and created two objects for one socket — enumeration
 * handed out wrappers while `webSocketMessage`/`webSocketClose` hand back the
 * transport socket, so any per-socket `WeakMap` memo could key on either and
 * diverge.
 *
 * These tests pin the property that replaced it, because it is invisible in
 * ordinary use: everything still works if a wrapper creeps back, just slower and
 * with the identity split silently restored.
 *
 * The `getSockets` handle memo these tests used to cover is gone with the
 * wrapper. It existed only to avoid re-mapping N sockets to N wrappers per
 * broadcast; with nothing to map, `getSockets` reads through to the runtime,
 * which is both cheaper and impossible to serve stale.
 */

/** A hibernatable-socket double: the surface the host adapter touches. */
class FakeSocket {
    private attachment: unknown;

    // eslint-disable-next-line class-methods-use-this -- socket double: the adapter only needs the method to exist
    public close(): void {}

    public deserializeAttachment(): unknown {
        return this.attachment;
    }

    // eslint-disable-next-line class-methods-use-this -- socket double: the adapter only needs the method to exist
    public send(): void {}

    public serializeAttachment(value: unknown): void {
        this.attachment = value;
    }
}

/** A `DurableObjectState` double whose live socket set the test controls. */
const stateWith = (live: FakeSocket[]) => {
    const tags = new Map<FakeSocket, string[]>();

    return {
        acceptWebSocket(socket: FakeSocket, socketTags?: string[]) {
            tags.set(socket, socketTags ?? []);
            live.push(socket);
        },
        getTags: (socket: FakeSocket) => tags.get(socket) ?? [],
        // A FRESH array each call, the way workerd behaves.
        getWebSockets: (tag?: string) => (tag === undefined ? [...live] : live.filter((s) => (tags.get(s) ?? []).includes(tag))),
    };
};

describe("createSocketHost socket identity", () => {
    it("hands back the transport socket itself, not a wrapper", () => {
        expect.assertions(3);

        const live: FakeSocket[] = [];
        const host = createSocketHost(stateWith(live) as never);
        const socket = new FakeSocket();

        const handle = host.accept(socket);

        // All three routes to a socket must yield the SAME object. A wrapper
        // satisfies the `SocketHandle` type while failing every one of these, so
        // this is the assertion that keeps it out.
        expect(handle).toBe(socket);
        expect(host.getSockets()[0]).toBe(socket);
        expect(host.handleFor(socket)).toBe(socket);
    });

    it("gives enumeration and the runtime's own callbacks one identity", () => {
        expect.assertions(1);

        const live: FakeSocket[] = [];
        const host = createSocketHost(stateWith(live) as never);
        const socket = new FakeSocket();

        host.accept(socket);

        const resolved = host.handleFor(socket);

        // `webSocketMessage` receives the transport socket; fan-out iterates
        // `getSockets()`. When those were different objects, a per-socket memo
        // keyed on one could not see writes made through the other — the bug
        // `handleFor` existed to paper over.
        expect(resolved !== undefined && host.getSockets().includes(resolved)).toBe(true);
    });

    it("keeps a socket's id stable across calls and across a wake", () => {
        expect.assertions(2);

        const live: FakeSocket[] = [];
        const state = stateWith(live);
        const host = createSocketHost(state as never);
        const socket = new FakeSocket();

        const handle = host.accept(socket);
        const id = host.idFor(handle);

        expect(host.idFor(handle)).toBe(id);

        // A fresh host is the hibernation wake: new isolate, no in-memory state.
        // The id survives because it was minted into a durable accept-time tag,
        // which is what lets a rehydrated socket find its subscription again.
        expect(createSocketHost(state as never).idFor(handle)).toBe(id);
    });
});

describe("createSocketHost getSockets", () => {
    it("reads through to the runtime's live set", () => {
        expect.assertions(3);

        const live: FakeSocket[] = [];
        const host = createSocketHost(stateWith(live) as never);

        host.accept(new FakeSocket());
        host.accept(new FakeSocket());

        expect(host.getSockets()).toHaveLength(2);

        // The runtime drops a closed socket from its own array. With no memo in
        // front of it there is no staleness to invalidate — including the swap
        // case (one closes, one opens) that a length-keyed memo got wrong.
        live.pop();

        expect(host.getSockets()).toHaveLength(1);

        host.accept(new FakeSocket());

        expect(host.getSockets()).toHaveLength(2);
    });

    it("returns exactly the sockets carrying a tag", () => {
        expect.assertions(3);

        const live: FakeSocket[] = [];
        const host = createSocketHost(stateWith(live) as never);

        const a = host.accept(new FakeSocket(), undefined, ["room-a"]);
        const b = host.accept(new FakeSocket(), undefined, ["room-b"]);

        // Asserted by IDENTITY, not by count: both tags hold exactly one socket,
        // so a host that crossed them returns the right LENGTH and the wrong
        // SOCKET — a fan-out delivering room-a's frame to room-b.
        expect(host.getSockets("room-a")).toStrictEqual([a]);
        expect(host.getSockets("room-b")).toStrictEqual([b]);
        expect(host.getSockets()).toHaveLength(2);
    });
});

describe("createSocketHost handleFor ownership", () => {
    it("resolves a socket accepted before this wake without scanning the socket set", () => {
        expect.assertions(3);

        const live: FakeSocket[] = [];
        const base = stateWith(live);
        let scans = 0;
        const state = {
            ...base,
            getWebSockets: (tag?: string) => {
                scans += 1;

                return base.getWebSockets(tag);
            },
        };

        const accepted = new FakeSocket();

        // Accept through one host, then resolve through a FRESH one. That is the
        // hibernation wake: a new isolate and a socket the runtime hands straight
        // to `webSocketMessage`.
        createSocketHost(state as never).accept(accepted);

        const afterWake = createSocketHost(state as never);

        scans = 0;

        expect(afterWake.handleFor(accepted)).toBe(accepted);
        // Answering a question about ONE socket must not materialize and walk the
        // whole socket array — `webSocketMessage` asks it once per socket per wake.
        expect(scans).toBe(0);

        // A socket this host never accepted is still refused. Now that the handle
        // and the socket are one object, refusing is the only thing standing
        // between a foreign socket and being treated as a subscriber.
        expect(afterWake.handleFor(new FakeSocket())).toBeUndefined();
    });

    it("scans at most once for a socket that is not ours", () => {
        expect.assertions(3);

        const live: FakeSocket[] = [];
        const base = stateWith(live);
        let scans = 0;
        const state = {
            ...base,
            getWebSockets: (tag?: string) => {
                scans += 1;

                return base.getWebSockets(tag);
            },
        };
        const host = createSocketHost(state as never);

        host.accept(new FakeSocket());

        const stranger = new FakeSocket();

        scans = 0;

        // The runtime can hand back a socket this host never accepted — a whisper
        // sender in another pool, a relay peer. Concluding "not mine" costs a full
        // scan, so repeating it per frame is the expensive direction to get wrong.
        expect(host.handleFor(stranger)).toBeUndefined();
        expect(host.handleFor(stranger)).toBeUndefined();
        expect(scans).toBe(1);
    });

    it("lets a later accept win over a cached negative", () => {
        expect.assertions(2);

        const live: FakeSocket[] = [];
        const host = createSocketHost(stateWith(live) as never);
        const socket = new FakeSocket();

        expect(host.handleFor(socket)).toBeUndefined();

        // `accept` records a fallback id, which `handleFor` consults BEFORE the
        // negative set — so the stale "not ours" can never shadow it.
        host.accept(socket);

        expect(host.handleFor(socket)).toBe(socket);
    });

    it("does not let an id lookup launder a foreign socket into ownership", () => {
        expect.assertions(3);

        const live: FakeSocket[] = [];
        const host = createSocketHost(stateWith(live) as never);
        const stranger = new FakeSocket();

        expect(host.handleFor(stranger)).toBeUndefined();

        // `idFor` mints a fallback id for any socket. If that mint were recorded in
        // the same map `handleFor` treats as ownership evidence, this read would
        // silently promote a socket we refused a moment ago — turning a lookup into
        // a grant, for every socket host in the isolate.
        expect(host.idFor(stranger as never)).toBeDefined();
        expect(host.handleFor(stranger)).toBeUndefined();
    });

    it("answers ownership for a stream of unknown sockets without re-walking per call", () => {
        expect.assertions(23);

        const live: FakeSocket[] = [];
        let iterations = 0;
        // The runtime's array, instrumented: building the membership set iterates
        // it, so a count of 1 across many lookups is the memo doing its job.
        const instrumented = new Proxy(live, {
            get(target, key, receiver) {
                if (key === Symbol.iterator) {
                    iterations += 1;
                }

                return Reflect.get(target, key, receiver) as unknown;
            },
        });
        const host = createSocketHost({ acceptWebSocket() {}, getWebSockets: () => instrumented } as never);

        // Seeded directly, never through `accept` — the case this fallback exists
        // for, and the only one that reaches it.
        const seeded = new FakeSocket();

        live.push(seeded);

        expect(host.handleFor(seeded)).toBe(seeded);

        // DISTINCT sockets, each seen once. That is the shape `webSocketMessage`
        // actually produces on a fan-out — the sender rotates through a pool, so
        // the negative cache never hits and every frame reaches this path. Walking
        // the socket array here turned a question about ONE socket into
        // O(live sockets) per message.
        for (let index = 0; index < 20; index += 1) {
            expect(host.handleFor(new FakeSocket())).toBeUndefined();
        }

        expect(iterations).toBe(1);

        // A socket that joins later still resolves: the length change invalidates
        // the membership memo.
        const joined = new FakeSocket();

        live.push(joined);

        expect(host.handleFor(joined)).toBe(joined);
    });
});
