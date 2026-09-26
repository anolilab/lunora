import type { FunctionReference, Preloaded } from "@lunora/client";
import { LunoraClient } from "@lunora/client";
import { QueryClient } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import usePreloadedQuery from "../src/use-preloaded-query";
import useQuery from "../src/use-query";
import type { MockSocket } from "./mock-socket";
import { createMockWebSocket } from "./mock-socket";

/**
 * A sign-out or user switch must take the previous user's rows off screen. The
 * client blanks every live subscription with `undefined` when it retires the
 * previous identity; TanStack ignores `setQueryData(key, undefined)`, so the
 * React cache kept serving them — to the next person at a shared computer.
 */

const mine: FunctionReference = { __lunoraRef: "messages:mine" };

const ROWS: Record<string, { _id: string; text: string }[]> = {
    "Bearer jwt-A": [{ _id: "a1", text: "A-secret" }],
    "Bearer jwt-B": [{ _id: "b1", text: "B-secret" }],
};

/** The server: each bearer reads its own rows, and no bearer is refused. */
const server = vi.fn<typeof fetch>(async (_input, init) => {
    const rows = ROWS[new Headers(init?.headers).get("authorization") ?? ""];

    if (rows === undefined) {
        return Response.json({ error: { code: "UNAUTHENTICATED", message: "sign in" } }, { status: 401 });
    }

    return Response.json({ result: rows });
});

/** Reconnect at once, so the socket an identity change bounces is replaced within `settle()`. */
const FAST_RECONNECT = { initialDelayMs: 1, jitter: false, maxDelayMs: 1 } as const;

const settle = async (): Promise<void> => {
    for (let index = 0; index < 10; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- drain promise ticks in order
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    }
};

/** Every value the view rendered, in order. */
const renders: string[] = [];

const View = (): ReactElement => {
    const rows = useQuery(mine, {}) as { text: string }[] | undefined;
    const text = rows === undefined ? "(none)" : rows.map((row) => row.text).join(",");

    renders.push(text);

    return <div>{text}</div>;
};

/** Open the newest socket and answer each subscribe frame it carries with `rows`. */
const serve = async (sockets: MockSocket[], rows: unknown): Promise<void> => {
    const socket = sockets.at(-1);

    await act(async () => {
        socket?.open();
        await settle();
    });

    await act(async () => {
        for (const frame of socket?.sent ?? []) {
            if (frame.type === "subscribe") {
                socket?.receive({ cursor: 1, data: rows, id: frame.id, type: "data" });
            }
        }

        await settle();
    });
};

/** Open the newest socket and refuse each subscribe frame it carries. */
const refuse = async (sockets: MockSocket[]): Promise<void> => {
    const socket = sockets.at(-1);

    await act(async () => {
        socket?.open();
        await settle();
    });

    await act(async () => {
        for (const frame of socket?.sent ?? []) {
            if (frame.type === "subscribe") {
                socket?.receive({ error: { code: "UNAUTHENTICATED", message: "sign in" }, id: frame.id, type: "error" });
            }
        }

        await settle();
    });
};

const signedInAsA = async (sockets: MockSocket[]): Promise<{ client: LunoraClient; screen: HTMLElement }> => {
    const client = new LunoraClient({ fetch: server, reconnect: FAST_RECONNECT, url: "https://app.example", WebSocket: createMockWebSocket(sockets) });

    client.setAuthToken("jwt-A", "user-A");

    const view = render(
        <LunoraProvider client={client}>
            <View />
        </LunoraProvider>,
    );

    await serve(sockets, ROWS["Bearer jwt-A"]);

    return { client, screen: view.container };
};

/** What SSR rendered for user A. */
const PRELOADED_FOR_A: Preloaded<{ text: string }[]> = {
    __lunoraPreloaded: true,
    args: {},
    functionPath: "messages:mine",
    value: [{ text: "A-secret" }],
};

const PreloadedView = (): ReactElement => {
    const rows = usePreloadedQuery(PRELOADED_FOR_A) as { text: string }[] | undefined;

    return <div>{rows === undefined ? "(none)" : rows.map((row) => row.text).join(",")}</div>;
};

describe("useQuery across an identity change", () => {
    afterEach(() => {
        renders.length = 0;
    });

    it("never shows user A's rows once user B is signed in", async () => {
        expect.assertions(4);

        const sockets: MockSocket[] = [];
        const { client, screen } = await signedInAsA(sockets);

        expect(screen.textContent).toBe("A-secret");

        const switchedAt = renders.length;

        await act(async () => {
            client.setAuthToken("jwt-B", "user-B");
            await settle();
        });

        // Between the switch and B's first frame, the screen holds nothing.
        expect(screen.textContent).toBe("(none)");

        await serve(sockets, ROWS["Bearer jwt-B"]);

        const afterSwitch = renders.slice(switchedAt);

        expect(afterSwitch.filter((text) => text.includes("A-secret"))).toStrictEqual([]);
        expect(afterSwitch.at(-1)).toBe("B-secret");

        client.close();
    });

    it("shows nothing, not user A's rows, when the signed-out resubscribe is refused", async () => {
        expect.assertions(2);

        const sockets: MockSocket[] = [];
        const { client, screen } = await signedInAsA(sockets);
        const switchedAt = renders.length;

        await act(async () => {
            client.setAuthToken(null);
            await settle();
        });

        await refuse(sockets);

        const afterSwitch = renders.slice(switchedAt);

        expect(afterSwitch.filter((text) => text.includes("A-secret"))).toStrictEqual([]);
        expect(screen.textContent).toBe("(none)");

        client.close();
    });

    it("does not serve user A's rows from the cache to a query user B mounts later", async () => {
        expect.assertions(2);

        const sockets: MockSocket[] = [];
        const client = new LunoraClient({ fetch: server, reconnect: FAST_RECONNECT, url: "https://app.example", WebSocket: createMockWebSocket(sockets) });

        client.setAuthToken("jwt-A", "user-A");

        // One provider for the whole test: the TanStack cache outlives the view.
        const Shell = ({ show }: { show: boolean }): ReactElement => <LunoraProvider client={client}>{show ? <View /> : <div />}</LunoraProvider>;
        const view = render(<Shell show />);

        await serve(sockets, ROWS["Bearer jwt-A"]);

        // A navigates away. The entry stays cached for `gcTime`.
        view.rerender(<Shell show={false} />);

        await act(async () => {
            client.setAuthToken("jwt-B", "user-B");
            await settle();
        });

        const remountedAt = renders.length;

        view.rerender(<Shell show />);
        await serve(sockets, ROWS["Bearer jwt-B"]);

        const afterRemount = renders.slice(remountedAt);

        expect(afterRemount.filter((text) => text.includes("A-secret"))).toStrictEqual([]);
        expect(afterRemount.at(-1)).toBe("B-secret");

        client.close();
    });

    it("keeps clearing a QueryClient the app retains while the provider is unmounted", async () => {
        expect.assertions(2);

        const sockets: MockSocket[] = [];
        const client = new LunoraClient({ fetch: server, reconnect: FAST_RECONNECT, url: "https://app.example", WebSocket: createMockWebSocket(sockets) });
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 0, staleTime: Number.POSITIVE_INFINITY } } });

        client.setAuthToken("jwt-A", "user-A");

        const Shell = ({ show }: { show: boolean }): ReactElement =>
            show ? (
                <LunoraProvider client={client} queryClient={queryClient}>
                    <View />
                </LunoraProvider>
            ) : (
                <div />
            );
        const view = render(<Shell show />);

        await serve(sockets, ROWS["Bearer jwt-A"]);

        // The whole provider goes away; the app keeps its QueryClient.
        view.rerender(<Shell show={false} />);

        await act(async () => {
            client.setAuthToken("jwt-B", "user-B");
            await settle();
        });

        const remountedAt = renders.length;

        view.rerender(<Shell show />);
        await serve(sockets, ROWS["Bearer jwt-B"]);

        const afterRemount = renders.slice(remountedAt);

        expect(afterRemount.filter((text) => text.includes("A-secret"))).toStrictEqual([]);
        expect(afterRemount.at(-1)).toBe("B-secret");

        client.close();
    });

    it("stops falling back to user A's preloaded value once user B is signed in", async () => {
        expect.assertions(2);

        const sockets: MockSocket[] = [];
        const client = new LunoraClient({ fetch: server, reconnect: FAST_RECONNECT, url: "https://app.example", WebSocket: createMockWebSocket(sockets) });

        client.setAuthToken("jwt-A", "user-A");

        const view = render(
            <LunoraProvider client={client}>
                <PreloadedView />
            </LunoraProvider>,
        );

        expect(view.container.textContent).toBe("A-secret");

        await act(async () => {
            client.setAuthToken("jwt-B", "user-B");
            await settle();
        });

        expect(view.container.textContent).toBe("(none)");

        client.close();
    });

    it("does not show user A's preloaded value to a component that remounts after user B signs in", async () => {
        expect.assertions(2);

        const sockets: MockSocket[] = [];
        const client = new LunoraClient({ fetch: server, reconnect: FAST_RECONNECT, url: "https://app.example", WebSocket: createMockWebSocket(sockets) });

        client.setAuthToken("jwt-A", "user-A");

        const Shell = ({ show }: { show: boolean }): ReactElement => <LunoraProvider client={client}>{show ? <PreloadedView /> : <div />}</LunoraProvider>;
        const view = render(<Shell show />);

        expect(view.container.textContent).toBe("A-secret");

        view.rerender(<Shell show={false} />);

        await act(async () => {
            client.setAuthToken("jwt-B", "user-B");
            await settle();
        });

        view.rerender(<Shell show />);

        expect(view.container.textContent).not.toContain("A-secret");

        client.close();
    });
});
