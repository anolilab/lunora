import { LunoraClient } from "@lunora/client";
import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { useAuthUsers } from "../src/use-admin-auth";
import type { MockSocket } from "./mock-socket";
import { createMockWebSocket } from "./mock-socket";

const settle = async (): Promise<void> => {
    for (let index = 0; index < 10; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- drains the macrotask queue one tick at a time
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    }
};

const List = (): ReactElement => {
    const { data, error } = useAuthUsers();

    if (error) {
        return <div>{`error:${error.message}`}</div>;
    }

    return <div>{data === undefined ? "loading" : data.map((row) => row.email).join(",")}</div>;
};

describe("useAuthUsers — cookie-session identity change", () => {
    it("drops admin A's user list when the cookie session switches to user B", async () => {
        expect.hasAssertions();

        // No bearer token is ever set: the session lives in a cookie, so the user
        // switch reaches the client only through `get-session`.
        const session: { user: string } = { user: "admin-A" };
        const fetchImpl = vi.fn<typeof fetch>(async (input) => {
            const url = input instanceof Request ? input.url : input.toString();

            if (url.includes("get-session")) {
                return Response.json({ user: { id: session.user } });
            }

            if (url.includes("/_lunora/admin/auth/users")) {
                if (session.user !== "admin-A") {
                    return Response.json({ error: { code: "FORBIDDEN", message: "not an admin" } }, { status: 403 });
                }

                return Response.json({ rows: [{ email: "user@corp.example", id: "u1" }], total: 1 });
            }

            return Response.json({ result: [] });
        });
        const sockets: MockSocket[] = [];
        const client = new LunoraClient({
            fetch: fetchImpl,
            reconnect: { initialDelayMs: 1, jitter: false, maxDelayMs: 1 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(sockets),
        });

        await act(async () => {
            await client.getCurrentUser();
        });

        const view = render(
            <LunoraProvider client={client}>
                <List />
            </LunoraProvider>,
        );

        await act(settle);

        expect(view.container.textContent).toBe("user@corp.example");

        session.user = "user-B";

        await act(async () => {
            await client.getCurrentUser();
            await settle();
        });

        expect(view.container.textContent).toBe("error:not an admin");

        client.close();
    });
});
