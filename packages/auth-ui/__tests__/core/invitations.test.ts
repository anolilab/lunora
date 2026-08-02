import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthClient, AuthResponse, ControllerContext } from "../../src/core";
import { createAcceptInvitationController, resolveContext } from "../../src/core";

const ok = <T>(data: T): Promise<AuthResponse<T>> => Promise.resolve({ data, error: null });

/**
 * A signed-out session with a loaded invitation, ready to accept — the state
 * the bounce (`decide` inside `createAcceptInvitationController`) reads from.
 */
const makeContext = (
    redirectsSignIn: string,
): { context: ControllerContext; nav: { navigate: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn> } } => {
    const nav = { navigate: vi.fn(), replace: vi.fn() };
    const authClient = {
        getSession: vi.fn(() => ok(null)),
        organization: {
            acceptInvitation: vi.fn(() => ok({})),
            getInvitation: vi.fn(() => ok({ email: "invitee@example.com", id: "inv-1", organizationName: "Acme" })),
        },
    } as unknown as AuthClient;

    const context = resolveContext({ authClient, nav, redirects: { signIn: redirectsSignIn } });

    return { context, nav };
};

/**
 * The invitation sign-in bounce used to append `?redirectTo=…` blindly, which
 * mangles a `redirects.signIn` that already carries a query (`/auth?tab=sign-in`
 * → `/auth?tab=sign-in?redirectTo=…`) — the invitee signs in and the invitation
 * is lost (plan 278).
 */
describe("createAcceptInvitationController — sign-in bounce", () => {
    afterEach(() => {
        globalThis.history.pushState({}, "", "/");
    });

    it("merges redirectTo and email into a signIn path that already carries a query, without a second ?", async () => {
        expect.assertions(3);

        const { context, nav } = makeContext("/auth?tab=sign-in");

        globalThis.history.pushState({}, "", "/accept-invitation?invitationId=inv-1");

        const controller = createAcceptInvitationController(context, { invitationId: "inv-1" });

        await vi.waitFor(() => {
            if (controller.getState().loading) {
                throw new Error("still loading");
            }
        });

        await controller.actions.accept();

        expect(nav.replace).toHaveBeenCalledTimes(1);

        const [calledUrl] = nav.replace.mock.calls[0] as [string];

        expect(calledUrl.match(/\?/g)?.length).toBe(1);

        const parsed = new URL(calledUrl, "http://example.test");

        expect(Object.fromEntries(parsed.searchParams)).toStrictEqual({
            email: "invitee@example.com",
            redirectTo: "/accept-invitation?invitationId=inv-1",
            tab: "sign-in",
        });
    });

    it("still produces the pre-existing URL shape when redirects.signIn carries no query", async () => {
        expect.assertions(2);

        const { context, nav } = makeContext("/sign-in");

        globalThis.history.pushState({}, "", "/accept-invitation?invitationId=inv-1");

        const controller = createAcceptInvitationController(context, { invitationId: "inv-1" });

        await vi.waitFor(() => {
            if (controller.getState().loading) {
                throw new Error("still loading");
            }
        });

        await controller.actions.accept();

        const [calledUrl] = nav.replace.mock.calls[0] as [string];

        expect(calledUrl.startsWith("/sign-in?")).toBe(true);

        const parsed = new URL(calledUrl, "http://example.test");

        expect(Object.fromEntries(parsed.searchParams)).toStrictEqual({
            email: "invitee@example.com",
            redirectTo: "/accept-invitation?invitationId=inv-1",
        });
    });
});
