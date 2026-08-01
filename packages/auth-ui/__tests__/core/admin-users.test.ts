import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthClient, AuthResponse, ControllerContext } from "../../src/core";
import { resolveContext } from "../../src/core";
import { createAdminUsersController } from "../../src/core/admin-users";

const ok = <T>(data: T): Promise<AuthResponse<T>> => Promise.resolve({ data, error: null });

const stubClient = (listUsers: AuthClient["admin"]["listUsers"]): AuthClient =>
    ({
        admin: {
            banUser: vi.fn(),
            impersonateUser: vi.fn(),
            listUsers,
            removeUser: vi.fn(),
            setRole: vi.fn(),
            stopImpersonating: vi.fn(),
            unbanUser: vi.fn(),
        },
        getSession: vi.fn(),
    }) as unknown as AuthClient;

const makeContext = (client: AuthClient): ControllerContext => resolveContext({ authClient: client, nav: { navigate: vi.fn(), replace: vi.fn() } });

afterEach(() => {
    vi.useRealTimers();
});

describe("createAdminUsersController", () => {
    it("reports `total` readable at `state.extra.total` after a load", async () => {
        expect.assertions(1);

        const client = stubClient(vi.fn(() => ok({ total: 7, users: [{ id: "u1" }] })));
        const controller = createAdminUsersController(makeContext(client));

        await controller.actions.refetch();

        expect(controller.getState().extra.total).toBe(7);
    });

    it("debounces setSearch so a listUsers call fires once per burst of keystrokes, not per keystroke", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const listUsers = vi.fn(() => ok({ total: 0, users: [] }));
        const client = stubClient(listUsers);
        const controller = createAdminUsersController(makeContext(client), { autoLoad: false });

        void controller.actions.setSearch("a");
        void controller.actions.setSearch("al");
        void controller.actions.setSearch("ali");

        // The field itself stays controlled through the debounce window.
        expect(controller.getState().extra.search).toBe("ali");

        await vi.advanceTimersByTimeAsync(400);

        expect(listUsers).toHaveBeenCalledTimes(1);
    });

    it("drops a slow answer for a stale prefix once a faster answer for the current search has landed", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        let releaseAl: ((value: AuthResponse<{ total?: number; users: { id: string }[] }>) => void) | undefined;
        const alPromise = new Promise<AuthResponse<{ total?: number; users: { id: string }[] }>>((resolve) => {
            releaseAl = resolve;
        });

        let call = 0;
        const listUsers = vi.fn(() => {
            call += 1;

            // The first request ("al") hangs; the second ("alice") answers
            // immediately — the exact ordering that lets a slow prefix answer
            // overwrite a fast full-query answer without a generation guard.
            return call === 1 ? alPromise : ok({ total: 1, users: [{ id: "alice-1" }] });
        });
        const client = stubClient(listUsers);
        const controller = createAdminUsersController(makeContext(client), { autoLoad: false });

        void controller.actions.setSearch("al");
        await vi.advanceTimersByTimeAsync(300);

        void controller.actions.setSearch("alice");
        await vi.advanceTimersByTimeAsync(300);

        releaseAl?.({ data: { total: 1, users: [{ id: "al-1" }] }, error: null });
        await Promise.resolve();
        await Promise.resolve();

        expect(controller.getState().items.map((user) => user.id)).toStrictEqual(["alice-1"]);
    });
});
