import { describe, expect, it } from "vitest";

import { createSocketHost } from "../src/cloudflare-host";

/**
 * The `getSockets` handle memo.
 *
 * `getSockets` is the fan-out hot path, so it caches the mapped handle array and
 * validates it in O(1) instead of re-mapping every call. Validity rests on one
 * argument: a socket can only ENTER through `accept` (which bumps a generation)
 * and can only LEAVE by closing (which shortens the runtime's array), so an
 * unchanged generation AND an unchanged length together mean an unchanged set.
 *
 * These tests exist because that argument has one non-obvious case — a close and
 * an accept between two reads, where the length comes back equal and only the
 * generation reveals the change. A memo keyed on length alone passes every other
 * test here and silently serves a stale socket forever.
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
        // A FRESH array each call, the way workerd behaves — so a memo cannot
        // rely on reference equality of the runtime's own result.
        getWebSockets: (tag?: string) => (tag === undefined ? [...live] : live.filter((s) => (tags.get(s) ?? []).includes(tag))),
    };
};

describe("createSocketHost getSockets memo", () => {
    it("returns a stable handle array while the socket set is unchanged", () => {
        expect.assertions(2);

        const live: FakeSocket[] = [];
        const host = createSocketHost(stateWith(live) as never);

        host.accept(new FakeSocket());
        host.accept(new FakeSocket());

        const first = host.getSockets();
        const second = host.getSockets();

        // Same array instance: the whole point is that a fan-out does not
        // re-map N sockets on every broadcast.
        expect(second).toBe(first);
        expect(first).toHaveLength(2);
    });

    it("re-maps after an accept, so a new socket is never missed", () => {
        expect.assertions(2);

        const live: FakeSocket[] = [];
        const host = createSocketHost(stateWith(live) as never);

        host.accept(new FakeSocket());

        const before = host.getSockets();

        host.accept(new FakeSocket());

        const after = host.getSockets();

        expect(after).not.toBe(before);
        expect(after).toHaveLength(2);
    });

    it("re-maps after a close, so a gone socket is never served", () => {
        expect.assertions(1);

        const live: FakeSocket[] = [];
        const host = createSocketHost(stateWith(live) as never);

        host.accept(new FakeSocket());
        host.accept(new FakeSocket());
        host.getSockets();

        // The runtime drops a closed socket from its own array.
        live.pop();

        expect(host.getSockets()).toHaveLength(1);
    });

    it("re-maps when a close and an accept leave the count unchanged", () => {
        expect.assertions(3);

        const live: FakeSocket[] = [];
        const host = createSocketHost(stateWith(live) as never);

        host.accept(new FakeSocket());
        host.accept(new FakeSocket());

        const before = host.getSockets();
        const beforeIds = before.map((handle) => handle.id);

        // The swap: one socket closes, another is accepted. Length comes back to
        // 2, so ONLY the generation distinguishes this from "nothing happened".
        live.pop();
        host.accept(new FakeSocket());

        const after = host.getSockets();

        expect(after).toHaveLength(2);
        expect(after).not.toBe(before);
        // The departed socket's handle is gone and the new one is present.
        expect(after.map((handle) => handle.id)).not.toStrictEqual(beforeIds);
    });

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
        // hibernation wake: a new isolate, empty handle cache, and a socket the
        // runtime hands straight to `webSocketMessage`. Resolving it through the
        // cache is the easy path; this is the one that used to scan.
        createSocketHost(state as never).accept(accepted);

        const afterWake = createSocketHost(state as never);

        scans = 0;

        expect(afterWake.handleFor(accepted)).toBeDefined();
        // Answering a question about ONE socket must not materialize and walk the
        // whole socket array — `webSocketMessage` asks it once per socket per wake.
        expect(scans).toBe(0);

        // A socket this host never accepted is still refused.
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

        // `accept` populates the handle cache, which `handleFor` consults BEFORE
        // the negative set — so the stale "not ours" can never shadow it.
        const handle = host.accept(socket);

        expect(host.handleFor(socket)?.id).toBe(handle.id);
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

        expect(host.handleFor(seeded)).toBeDefined();

        // DISTINCT sockets, each seen once. That is the shape `webSocketMessage`
        // actually produces on a fan-out — the sender rotates through a pool, so
        // neither the handle cache nor the negative cache ever hits and every
        // frame reaches this path. Walking the socket array here turned a question
        // about ONE socket into O(live sockets) per message.
        for (let index = 0; index < 20; index += 1) {
            expect(host.handleFor(new FakeSocket())).toBeUndefined();
        }

        expect(iterations).toBe(1);

        // A socket that joins later still resolves: the length change invalidates
        // the memo, exactly as it does for the handle array.
        const joined = new FakeSocket();

        live.push(joined);

        expect(host.handleFor(joined)).toBeDefined();
    });

    it("memoizes each tag independently", () => {
        expect.assertions(3);

        const live: FakeSocket[] = [];
        const host = createSocketHost(stateWith(live) as never);

        const a = host.accept(new FakeSocket(), undefined, ["room-a"]);
        const b = host.accept(new FakeSocket(), undefined, ["room-b"]);

        // Asserted by IDENTITY, not by count: both tags hold exactly one socket,
        // so a memo shared across tags returns the right LENGTH and the wrong
        // SOCKET — a fan-out delivering room-a's frame to room-b.
        expect(host.getSockets("room-a").map((handle) => handle.id)).toStrictEqual([a.id]);
        expect(host.getSockets("room-b").map((handle) => handle.id)).toStrictEqual([b.id]);

        const byId = (left: string, right: string): number => left.localeCompare(right);

        expect(
            host
                .getSockets()
                .map((handle) => handle.id)
                .toSorted(byId),
        ).toStrictEqual([a.id, b.id].toSorted(byId));
    });
});
