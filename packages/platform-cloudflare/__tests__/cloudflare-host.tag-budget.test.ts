import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { createSocketHost } from "../src/cloudflare-host";

/**
 * The Cloudflare socket host reserves one `acceptWebSocket` tag slot for its
 * own identity tag (`lunora-socket:<uuid>`, see `cloudflare-host.ts`'s
 * `ID_TAG_PREFIX`), so Cloudflare's documented cap of 10 tags / 256 characters
 * per tag (developers.cloudflare.com/durable-objects/api/state/) becomes a
 * caller-visible budget of 9 usable tags. These tests pin that the adapter
 * enforces the budget itself — with an actionable `LunoraError` naming the
 * counts — rather than letting the provider throw about a combined list that
 * blames a tag the caller never supplied.
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

/** A `DurableObjectState` double that records every `acceptWebSocket` call so a rejected accept can be asserted never to have reached it. */
const stateRecordingAccepts = () => {
    const calls: string[][] = [];

    return {
        acceptWebSocket(_socket: FakeSocket, socketTags?: string[]) {
            calls.push(socketTags ?? []);
        },
        calls,
        getTags: () => [] as string[],
        getWebSockets: () => [] as FakeSocket[],
    };
};

describe("createSocketHost accept-time tag budget", () => {
    it("accepts 9 caller tags — acceptWebSocket receives 10 with the id tag first", () => {
        expect.assertions(3);

        const state = stateRecordingAccepts();
        const host = createSocketHost(state as never);
        const nineTags = Array.from({ length: 9 }, (_unused, index) => `tag-${String(index)}`);

        host.accept(new FakeSocket(), undefined, nineTags);

        expect(state.calls).toHaveLength(1);
        expect(state.calls[0]).toHaveLength(10);
        expect(state.calls[0]?.[0]?.startsWith("lunora-socket:")).toBe(true);
    });

    it("rejects 10 caller tags with SOCKET_TAG_BUDGET_EXCEEDED — acceptWebSocket is never called", () => {
        expect.assertions(4);

        const state = stateRecordingAccepts();
        const host = createSocketHost(state as never);
        const tenTags = Array.from({ length: 10 }, (_unused, index) => `tag-${String(index)}`);

        let thrown: unknown;

        try {
            host.accept(new FakeSocket(), undefined, tenTags);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(LunoraError);
        expect((thrown as LunoraError).code).toBe("SOCKET_TAG_BUDGET_EXCEEDED");
        expect((thrown as LunoraError).message).toContain("10");
        expect(state.calls).toHaveLength(0);
    });

    it("rejects a single over-length tag with SOCKET_TAG_BUDGET_EXCEEDED — acceptWebSocket is never called", () => {
        expect.assertions(3);

        const state = stateRecordingAccepts();
        const host = createSocketHost(state as never);
        const tooLong = "x".repeat(257);

        let thrown: unknown;

        try {
            host.accept(new FakeSocket(), undefined, [tooLong]);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(LunoraError);
        expect((thrown as LunoraError).code).toBe("SOCKET_TAG_BUDGET_EXCEEDED");
        expect(state.calls).toHaveLength(0);
    });

    it("accepts a 256-character tag (the boundary) without throwing", () => {
        expect.assertions(1);

        const state = stateRecordingAccepts();
        const host = createSocketHost(state as never);
        const exactly256 = "x".repeat(256);

        expect(() => host.accept(new FakeSocket(), undefined, [exactly256])).not.toThrow();
    });

    it("leaves a zero-tag accept unchanged", () => {
        expect.assertions(2);

        const state = stateRecordingAccepts();
        const host = createSocketHost(state as never);

        host.accept(new FakeSocket());

        expect(state.calls).toHaveLength(1);
        expect(state.calls[0]).toHaveLength(1);
    });
});
