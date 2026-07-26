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
