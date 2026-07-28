import { describe, expect, it, vi } from "vitest";

import type { AuthClient, AuthResponse, ControllerContext } from "../../src/core";
import { createMembersController, createOrganizationsController, createTwoFactorSetupController, resolveContext } from "../../src/core";

const ok = <T>(data: T = null as T): Promise<AuthResponse<T>> => Promise.resolve({ data, error: null });

const fullOrg = {
    id: "org-1",
    invitations: [{ email: "invitee@b.co", id: "inv-1", role: "member", status: "pending" }],
    members: [{ id: "m-1", role: "owner", user: { email: "owner@b.co" } }],
    name: "Acme",
};

const stubClient = (overrides: Partial<Record<string, unknown>> = {}): AuthClient =>
    ({
        organization: {
            cancelInvitation: vi.fn(() => ok({ status: true })),
            create: vi.fn(() => ok({ id: "org-2", name: "New" })),
            delete: vi.fn(() => ok({ status: true })),
            getFullOrganization: vi.fn(() => ok(fullOrg)),
            inviteMember: vi.fn(() => ok({ id: "inv-2" })),
            list: vi.fn(() => ok([{ id: "org-1", name: "Acme", slug: "acme" }])),
            removeMember: vi.fn(() => ok({ status: true })),
            setActive: vi.fn(() => ok({ id: "org-1" })),
            updateMemberRole: vi.fn(() => ok({ id: "m-1" })),
        },
        twoFactor: {
            disable: vi.fn(() => ok({ status: true })),
            enable: vi.fn(() => ok({ backupCodes: ["aaa", "bbb"], totpURI: "otpauth://totp/x" })),
            verifyTotp: vi.fn(() => ok({ user: { email: "a@b.co" } })),
        },
        ...overrides,
    }) as unknown as AuthClient;

const makeContext = (authClient: AuthClient): ControllerContext => resolveContext({ authClient, nav: { navigate: vi.fn(), replace: vi.fn() } });

const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
};

describe("createOrganizationsController", () => {
    it("loads organizations, then creates / switches / removes and refetches", async () => {
        expect.assertions(4);

        const client = stubClient();
        const controller = createOrganizationsController(makeContext(client));

        await flush();

        expect(controller.getState().items).toHaveLength(1);

        await controller.actions.create("New", "new");

        expect(client.organization.create as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ name: "New", slug: "new" });

        await controller.actions.setActive("org-1");

        expect(client.organization.setActive as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ organizationId: "org-1" });

        await controller.actions.remove("org-1");

        expect(client.organization.delete as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ organizationId: "org-1" });
    });
});

describe("createMembersController", () => {
    it("loads members + invitations from the active organization", async () => {
        expect.assertions(2);

        const controller = createMembersController(makeContext(stubClient()));

        await flush();

        expect(controller.getState().members).toHaveLength(1);
        expect(controller.getState().invitations).toHaveLength(1);
    });

    it("invites, updates a role, removes a member, and cancels an invitation", async () => {
        expect.assertions(4);

        const client = stubClient();
        const controller = createMembersController(makeContext(client), { autoLoad: false });

        await controller.actions.invite("new@b.co", "admin");

        expect(client.organization.inviteMember as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ email: "new@b.co", role: "admin" });

        await controller.actions.updateRole("m-1", "admin");

        expect(client.organization.updateMemberRole as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ memberId: "m-1", role: "admin" });

        await controller.actions.removeMember("m-1");

        expect(client.organization.removeMember as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ memberIdOrEmail: "m-1" });

        await controller.actions.cancelInvitation("inv-1");

        expect(client.organization.cancelInvitation as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ invitationId: "inv-1" });
    });
});

describe("createTwoFactorSetupController", () => {
    it("walks start -> verify (URI + backup codes) -> enabled", async () => {
        expect.assertions(5);

        const client = stubClient();
        const controller = createTwoFactorSetupController(makeContext(client));

        // start: password required.
        await controller.actions.enable();

        expect(controller.getState().password.error).toBeDefined();

        controller.actions.setPassword("secret1234");
        await controller.actions.enable();

        expect(controller.getState().step).toBe("verify");
        expect(controller.getState().totpUri).toBe("otpauth://totp/x");
        expect(controller.getState().backupCodes).toStrictEqual(["aaa", "bbb"]);

        controller.actions.setCode("123456");
        await controller.actions.verify();

        expect(controller.getState().step).toBe("enabled");
    });

    it("disables and resets to the start step", async () => {
        expect.assertions(2);

        const client = stubClient();
        const controller = createTwoFactorSetupController(makeContext(client));

        controller.actions.setPassword("secret1234");
        await controller.actions.disable();

        expect(client.twoFactor.disable as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ password: "secret1234" });
        expect(controller.getState().step).toBe("start");
    });
});
