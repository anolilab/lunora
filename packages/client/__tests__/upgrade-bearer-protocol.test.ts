import { describe, expect, it } from "vitest";

import { decodeBearerProtocol, LUNORA_WS_PROTOCOL } from "../../../shared/ws-bearer-protocol";
import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

const fnRef = (path: string): FunctionReference => {
    return { __lunoraRef: path };
};

interface Opened {
    protocols: string[] | undefined;
    url: string;
}

/** A WebSocket double that only records how it was constructed. */
const recordingWebSocket = (opened: Opened[]): typeof WebSocket =>
    /* eslint-disable class-methods-use-this -- an inert socket double: only the constructor arguments matter. */
    class {
        public readyState = 0;

        public constructor(url: string, protocols?: string[]) {
            opened.push({ protocols, url });
        }

        public addEventListener(): void {}

        public close(): void {}

        public removeEventListener(): void {}

        public send(): void {}
    } as unknown as typeof WebSocket;
/* eslint-enable class-methods-use-this */

const clientWith = (authTokenOnUpgrade: boolean, token: string, opened: Opened[]): LunoraClient => {
    const client = new LunoraClient({
        authTokenOnUpgrade,
        fetch: async () => Response.json(null),
        heartbeatIntervalMs: 0,
        persistence: false,
        url: "http://app.test",
        WebSocket: recordingWebSocket(opened),
    });

    client.setAuthToken(token);

    return client;
};

const openWith = (authTokenOnUpgrade: boolean, token: string): Opened => {
    const opened: Opened[] = [];
    const client = clientWith(authTokenOnUpgrade, token, opened);

    client.subscribe(fnRef("todos.list"), {}, () => undefined);
    client.close();

    expect(opened).toHaveLength(1);

    return opened[0] as Opened;
};

describe("lunoraClient — bearer on the WebSocket upgrade", () => {
    it("offers the bearer as a lunora.bearer subprotocol, never in the URL", () => {
        expect.assertions(5);

        const token = "header.payload.sig-_";
        const { protocols, url } = openWith(true, token);

        expect(protocols?.[0]).toBe(LUNORA_WS_PROTOCOL);
        expect(decodeBearerProtocol(protocols?.[1] ?? "")).toBe(token);
        expect(url).not.toContain(token);
        // Every character is a valid RFC 7230 token char, as Sec-WebSocket-Protocol requires.
        expect(protocols?.[1]).toMatch(/^[\w.-]+$/u);
    });

    it("offers no subprotocol when the bearer does not ride the upgrade", () => {
        expect.assertions(2);

        expect(openWith(false, "tok").protocols).toBeUndefined();
    });

    it("offers the bearer on a defineWebSocket route, which the worker's upgrade handler answers", () => {
        expect.assertions(2);

        const opened: Opened[] = [];
        const client = clientWith(true, "tok", opened);

        client.connectWebSocket("/chat", { onMessage: () => undefined });
        client.close();

        expect(opened).toHaveLength(1);
        expect(decodeBearerProtocol(opened[0]?.protocols?.[1] ?? "")).toBe("tok");
    });

    it("offers no subprotocol on the scheduled-jobs socket, whose 101 selects none", () => {
        expect.assertions(3);

        const opened: Opened[] = [];
        const client = clientWith(true, "tok", opened);

        client.subscribeScheduledJobs(() => undefined);
        client.close();

        expect(opened).toHaveLength(1);
        expect(opened[0]?.url).toContain("/_lunora/admin/scheduled/ws");
        expect(opened[0]?.protocols).toBeUndefined();
    });
});
