import { describe, expect, it, vi } from "vitest";

import type { AuthClient, AuthResponse, ControllerContext } from "../../src/core";
import { createOrganizationSettingsController, createPasskeysController, resolveContext } from "../../src/core";

const ok = <T>(data: T = null as T): Promise<AuthResponse<T>> => Promise.resolve({ data, error: null });

const stubClient = (overrides: Record<string, unknown> = {}): AuthClient =>
    ({
        organization: {
            getFullOrganization: vi.fn(() => ok({ id: "org-1", logo: "https://cdn/logo.png", name: "Acme", slug: "acme" })),
            update: vi.fn(() => ok({ id: "org-1" })),
        },
        passkey: {
            addPasskey: vi.fn(() => ok({ id: "pk-2" })),
            deletePasskey: vi.fn(() => ok({ status: true })),
            listUserPasskeys: vi.fn(() => ok([{ id: "pk-1", name: "MacBook" }])),
            updatePasskey: vi.fn(() => ok({ id: "pk-1", name: "Work laptop" })),
        },
        ...overrides,
    }) as unknown as AuthClient;

const makeContext = (authClient: AuthClient): ControllerContext => resolveContext({ authClient, nav: { navigate: vi.fn(), replace: vi.fn() } });

const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};

describe("createPasskeysController", () => {
    it("lists passkeys, then adds / renames / removes and refetches", async () => {
        expect.assertions(5);

        const client = stubClient();
        const controller = createPasskeysController(makeContext(client));

        await flush();

        expect(controller.getState().items).toStrictEqual([{ id: "pk-1", name: "MacBook" }]);

        await controller.actions.add("  Work laptop  ");

        expect(client.passkey.addPasskey).toHaveBeenCalledWith({ name: "Work laptop" });

        await controller.actions.rename("pk-1", "Renamed");

        expect(client.passkey.updatePasskey).toHaveBeenCalledWith({ id: "pk-1", name: "Renamed" });

        await controller.actions.remove("pk-1");

        expect(client.passkey.deletePasskey).toHaveBeenCalledWith({ id: "pk-1" });
        // 1 initial load + 3 post-mutation refetches.
        expect(client.passkey.listUserPasskeys).toHaveBeenCalledTimes(4);
    });

    it("adds without a name when none is given", async () => {
        expect.assertions(1);

        const client = stubClient();
        const controller = createPasskeysController(makeContext(client), { autoLoad: false });

        await controller.actions.add("   ");

        expect(client.passkey.addPasskey).toHaveBeenCalledWith(undefined);
    });

    it("treats a dismissed WebAuthn prompt as a cancellation, not an error", async () => {
        expect.assertions(2);

        const client = stubClient({
            passkey: {
                addPasskey: vi.fn(() => Promise.resolve(undefined)),
                deletePasskey: vi.fn(() => ok({ status: true })),
                listUserPasskeys: vi.fn(() => ok([])),
                updatePasskey: vi.fn(() => ok({})),
            },
        });
        const controller = createPasskeysController(makeContext(client), { autoLoad: false });

        await controller.actions.add("Phone");

        expect(controller.getState().error).toBeUndefined();
        expect(controller.getState().status).not.toBe("error");
    });

    it("surfaces a failed add on the resource error", async () => {
        expect.assertions(1);

        const client = stubClient({
            passkey: {
                addPasskey: vi.fn(() => Promise.resolve({ data: null, error: { message: "not allowed" } })),
                deletePasskey: vi.fn(() => ok({ status: true })),
                listUserPasskeys: vi.fn(() => ok([])),
                updatePasskey: vi.fn(() => ok({})),
            },
        });
        const controller = createPasskeysController(makeContext(client), { autoLoad: false });

        await controller.actions.add("Phone");

        expect(controller.getState().error).toBe("not allowed");
    });
});

describe("createOrganizationSettingsController", () => {
    it("seeds the fields from the loaded organization", async () => {
        expect.assertions(4);

        const controller = createOrganizationSettingsController(makeContext(stubClient()));

        expect(controller.getState().loading).toBe(true);

        await flush();

        expect(controller.getState().loading).toBe(false);
        expect(controller.getState().fields.name.value).toBe("Acme");
        expect(controller.getState().fields.slug.value).toBe("acme");
    });

    it("returns a stable snapshot between changes", async () => {
        expect.assertions(2);

        const controller = createOrganizationSettingsController(makeContext(stubClient()));

        await flush();

        // React's useSyncExternalStore re-renders forever if getState() is a new
        // object each call.
        expect(controller.getState()).toBe(controller.getState());

        const before = controller.getState();

        controller.actions.setField("name", "Beta");

        expect(controller.getState()).not.toBe(before);
    });

    it("submits the trimmed fields and drops an empty logo", async () => {
        expect.assertions(2);

        const client = stubClient();
        const controller = createOrganizationSettingsController(makeContext(client), { organizationId: "org-9" });

        await flush();

        controller.actions.setField("name", "  Beta  ");
        controller.actions.setField("logo", "   ");
        await controller.actions.submit();

        expect(client.organization.update).toHaveBeenCalledWith({
            data: { logo: undefined, name: "Beta", slug: "acme" },
            organizationId: "org-9",
        });
        expect(controller.getState().status).toBe("success");
    });

    it("validates that name and slug are present", async () => {
        expect.assertions(3);

        const client = stubClient();
        const controller = createOrganizationSettingsController(makeContext(client), { autoLoad: false });

        await controller.actions.submit();

        expect(controller.getState().status).toBe("error");
        expect(controller.getState().fields.name.error).toBeDefined();
        expect(client.organization.update).not.toHaveBeenCalled();
    });
});
