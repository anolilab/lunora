import { describe, expect, it } from "vitest";

import { SocketTableIndex } from "../src/socket-table-index";

const subs = (...ids: string[]): Record<string, { functionPath: string }> => Object.fromEntries(ids.map((id) => [id, { functionPath: `q:${id}` }]));

const memo = (...tables: string[]) => {
    return { generation: 0, lastJson: "[]", tables: new Set(tables) };
};

/** A socket indexed by one visit over a single `a` subscription reading `tables`. */
const indexedSocket = (index: SocketTableIndex, ...tables: string[]): object => {
    const socket = {};

    index.setMemo(socket, "a", memo(...tables));
    index.beginVisit(socket)(subs("a"));

    return socket;
};

describe(SocketTableIndex, () => {
    it("visits a socket only for a write to a table one of its memos read", () => {
        expect.assertions(3);

        const index = new SocketTableIndex();
        const socket = indexedSocket(index, "messages");

        expect(index.mayCare(socket, new Set(["messages"]))).toBe(true);
        expect(index.mayCare(socket, new Set(["users"]))).toBe(false);
        expect(index.mayCare({}, new Set(["users"]))).toBe(true);
    });

    it("widens an indexed socket on every memo write, so the index never under-covers", () => {
        expect.assertions(2);

        const index = new SocketTableIndex();
        const socket = indexedSocket(index, "messages");

        index.setMemo(socket, "b", memo("users"));

        expect(index.mayCare(socket, new Set(["users"]))).toBe(true);

        index.retable(socket, "a", new Set(["channels"]));

        expect(index.mayCare(socket, new Set(["channels"]))).toBe(true);
    });

    it("unindexes a socket on a wildcard memo, a resubscribe, or a visit over an unmemoized subscription", () => {
        expect.assertions(3);

        const index = new SocketTableIndex();
        const wildcard = indexedSocket(index, "messages");

        index.setMemo(wildcard, "b", memo("*"));

        expect(index.mayCare(wildcard, new Set(["users"]))).toBe(true);

        const resubscribed = indexedSocket(index, "messages");

        index.resubscribed(resubscribed, "a");

        expect(index.mayCare(resubscribed, new Set(["users"]))).toBe(true);

        const unmemoized = {};

        index.setMemo(unmemoized, "a", memo("messages"));
        index.beginVisit(unmemoized)(subs("a", "b"));

        expect(index.mayCare(unmemoized, new Set(["users"]))).toBe(true);
    });

    it("leaves a socket unindexed when a resubscribe lands mid-visit", () => {
        expect.assertions(1);

        const index = new SocketTableIndex();
        const socket = {};

        index.setMemo(socket, "a", memo("messages"));

        const finishVisit = index.beginVisit(socket);

        index.resubscribed(socket, "b");
        index.setMemo(socket, "b", memo("messages"));
        finishVisit(subs("a", "b"));

        expect(index.mayCare(socket, new Set(["users"]))).toBe(true);
    });
});
