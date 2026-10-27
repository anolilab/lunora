import { describe, expect, it } from "vitest";

import { decodeBearerProtocol, LUNORA_WS_PROTOCOL } from "../../../shared/ws-bearer-protocol";
import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

const fnRef = (path: string): FunctionReference => {
    return { __lunoraRef: path };
};

interface Opened {
    options?: unknown;
    protocols: string[] | undefined;
    url: string;
}

/** A WebSocket double that only records how it was constructed. */
const recordingWebSocket = (opened: Opened[]): typeof WebSocket =>
    class {
        public readyState = 0;

        public constructor(url: string, protocols?: string[], options?: unknown) {
            opened.push({ options, protocols, url });
        }

        // eslint-disable-next-line class-methods-use-this -- an inert socket double: only the constructor arguments matter
        public addEventListener(): void {}

        // eslint-disable-next-line class-methods-use-this -- an inert socket double: only the constructor arguments matter
        public close(): void {}

        // eslint-disable-next-line class-methods-use-this -- an inert socket double: only the constructor arguments matter
        public removeEventListener(): void {}

        // eslint-disable-next-line class-methods-use-this -- an inert socket double: only the constructor arguments matter
        public send(): void {}
    } as unknown as typeof WebSocket;

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

    it("offers the bearer from getWebSocketImpl to the client's own host only, keeping later arguments", () => {
        expect.assertions(2);

        const opened: Opened[] = [];
        const client = clientWith(true, "tok", opened);
        const WebSocketImpl = client.getWebSocketImpl() as unknown as new (url: string, protocols?: string[], options?: unknown) => WebSocket;
        // A socket naming its own subprotocols keeps them; another host never sees the bearer.
        const sockets = [
            new WebSocketImpl("ws://app.test/_lunora/voice/support?threadKey=t1", undefined, { headers: { "x-app": "1" } }),
            new WebSocketImpl("ws://app.test/_lunora/voice/support", ["chat.v2"]),
            new WebSocketImpl("wss://elsewhere.example/socket"),
        ];

        client.close();

        expect(sockets).toHaveLength(3);
        expect(opened.map((entry) => [decodeBearerProtocol(entry.protocols?.[1] ?? ""), entry.protocols, entry.options])).toStrictEqual([
            ["tok", expect.any(Array), { headers: { "x-app": "1" } }],
            [undefined, ["chat.v2"], undefined],
            [undefined, undefined, undefined],
        ]);
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
