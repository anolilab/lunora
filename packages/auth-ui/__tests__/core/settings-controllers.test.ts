import { describe, expect, it, vi } from "vitest";

import type { AuthClient, AuthResponse, AuthSession, ControllerContext } from "../../src/core";
import {
    createChangeEmailController,
    createChangePasswordController,
    createDeleteAccountController,
    createProfileController,
    createSessionsController,
    resolveContext,
    signOut,
} from "../../src/core";

const ok = <T>(data: T = null as T): Promise<AuthResponse<T>> => Promise.resolve({ data, error: null });
const fail = (message: string): Promise<AuthResponse<never>> => Promise.resolve({ data: null, error: { message, status: 400 } });

const sessions: AuthSession[] = [
    { id: "s1", token: "tok-1", userAgent: "Chrome" },
    { id: "s2", token: "tok-2", userAgent: "Safari" },
];

const stubClient = (overrides: Partial<Record<string, unknown>> = {}): AuthClient =>
    ({
        changeEmail: vi.fn(() => ok({ status: true })),
        changePassword: vi.fn(() => ok({ status: true })),
        deleteUser: vi.fn(() => ok({ status: true })),
        listSessions: vi.fn(() => ok(sessions)),
        revokeOtherSessions: vi.fn(() => ok({ status: true })),
        revokeSession: vi.fn(() => ok({ status: true })),
        signOut: vi.fn(() => ok({ success: true })),
        updateUser: vi.fn(() => ok({ status: true })),
        ...overrides,
    }) as unknown as AuthClient;

const makeContext = (
    authClient: AuthClient,
): {
    context: ControllerContext;
    nav: { navigate: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn> };
    onSessionChange: ReturnType<typeof vi.fn>;
} => {
    const nav = { navigate: vi.fn(), replace: vi.fn() };
    const onSessionChange = vi.fn();
    const context = resolveContext({ authClient, nav, onSessionChange, redirects: { afterSignOut: "/bye", signIn: "/sign-in" } });

    return { context, nav, onSessionChange };
};

/** Let the resource controller's auto-load microtask settle. */
const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
};

describe("createProfileController", () => {
    it("prefills the name and updates it", async () => {
        expect.assertions(2);

        const client = stubClient();
        const { context } = makeContext(client);
        const controller = createProfileController(context, { initialName: "Ada" });

        expect(controller.getState().fields.name.value).toBe("Ada");

        controller.actions.setField("name", "Ada Lovelace");
        await controller.actions.submit();

        expect(client.updateUser as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ image: undefined, name: "Ada Lovelace" });
    });

    it("prefills from the session when the caller seeds nothing", async () => {
        expect.assertions(3);

        const getSession = vi.fn(() => ok({ user: { image: "https://img.test/a.png", name: "Grace" } }));
        const client = stubClient({ getSession });
        const { context } = makeContext(client);
        const controller = createProfileController(context);

        // The engine owns the loading flag while the session is in flight.
        expect(controller.getState().loading).toBe(true);

        // Plain throw, not an `expect` — `waitFor` retries its callback, and a
        // retried assertion would inflate the `expect.assertions` count.
        await vi.waitFor(() => {
            if (controller.getState().loading) {
                throw new Error("still loading");
            }
        });

        expect(controller.getState().fields.name.value).toBe("Grace");
        expect(controller.getState().fields.image.value).toBe("https://img.test/a.png");
    });

    it("does not read the session when the caller seeds a value", async () => {
        expect.assertions(2);

        const getSession = vi.fn(() => ok({ user: { name: "Grace" } }));
        const client = stubClient({ getSession });
        const { context } = makeContext(client);
        const controller = createProfileController(context, { initialName: "Ada" });

        expect(controller.getState().fields.name.value).toBe("Ada");
        // Seeding is an override, not a default the session then clobbers — a
        // caller passing a live session value would otherwise fight the prefill.
        expect(getSession).not.toHaveBeenCalled();
    });
});

describe("createChangeEmailController", () => {
    it("requests an email change and reports the confirmation", async () => {
        expect.assertions(2);

        const client = stubClient();
        const { context } = makeContext(client);
        const controller = createChangeEmailController(context);

        controller.actions.setField("newEmail", "new@b.co");
        await controller.actions.submit();

        expect(controller.getState().status).toBe("success");
        expect(client.changeEmail as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.objectContaining({ newEmail: "new@b.co" }));
    });
});

describe("createChangePasswordController", () => {
    it("rejects a mismatched confirmation", async () => {
        expect.assertions(1);

        const { context } = makeContext(stubClient());
        const controller = createChangePasswordController(context);

        controller.actions.setField("currentPassword", "oldpass12");
        controller.actions.setField("newPassword", "newpass123" /* gitleaks:allow */);
        controller.actions.setField("confirmPassword", "different99");
        await controller.actions.submit();

        expect(controller.getState().fields.confirmPassword.error).toBeDefined();
    });

    it("changes the password and revokes other sessions", async () => {
        expect.assertions(1);

        const client = stubClient();
        const { context } = makeContext(client);
        const controller = createChangePasswordController(context);

        controller.actions.setField("currentPassword", "oldpass12");
        controller.actions.setField("newPassword", "newpass123" /* gitleaks:allow */);
        controller.actions.setField("confirmPassword", "newpass123" /* gitleaks:allow */);
        await controller.actions.submit();

        expect(client.changePassword as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({
            currentPassword: "oldpass12",
            newPassword: "newpass123" /* gitleaks:allow */,
            revokeOtherSessions: true,
        });
    });
});

describe("createDeleteAccountController", () => {
    it("deletes the account and redirects to the sign-out target", async () => {
        expect.assertions(2);

        const client = stubClient();
        const { context, nav } = makeContext(client);
        const controller = createDeleteAccountController(context);

        controller.actions.setField("password", "secret1234");
        await controller.actions.submit();

        expect(client.deleteUser as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ password: "secret1234" });
        expect(nav.replace).toHaveBeenCalledWith("/bye");
    });
});

describe("createSessionsController", () => {
    it("loads sessions, then revokes one and refetches", async () => {
        expect.assertions(3);

        const client = stubClient();
        const { context } = makeContext(client);
        const controller = createSessionsController(context);

        await flush();

        expect(controller.getState().items).toHaveLength(2);

        await controller.actions.revoke("tok-1");

        expect(client.revokeSession as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ token: "tok-1" });
        // refetch runs after the mutation (listSessions called twice: load + refetch).
        expect((client.listSessions as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("surfaces a load error", async () => {
        expect.assertions(2);

        const client = stubClient({ listSessions: vi.fn(() => fail("nope")) });
        const { context } = makeContext(client);
        const controller = createSessionsController(context);

        await flush();

        expect(controller.getState().error).toBe("nope");
        expect(controller.getState().loading).toBe(false);
    });

    it("revokes all other sessions", async () => {
        expect.assertions(1);

        const client = stubClient();
        const { context } = makeContext(client);
        const controller = createSessionsController(context, { autoLoad: false });

        await controller.actions.revokeOthers();

        expect(client.revokeOtherSessions as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    });
});

describe("signOut", () => {
    it("signs out, signals the change, and redirects", async () => {
        expect.assertions(3);

        const client = stubClient();
        const { context, nav, onSessionChange } = makeContext(client);

        await signOut(context);

        expect(client.signOut as ReturnType<typeof vi.fn>).toHaveBeenCalled();
        expect(onSessionChange).toHaveBeenCalledTimes(1);
        expect(nav.replace).toHaveBeenCalledWith("/bye");
    });
});
