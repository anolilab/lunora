import { describe, expect, it, vi } from "vitest";

import type { AuthClient, AuthResponse, ControllerContext } from "../../src/core";
import { resolveContext } from "../../src/core";
import { createOrganizationLogoController } from "../../src/core/organization-logo";

const ok = <T>(data: T): Promise<AuthResponse<T>> => Promise.resolve({ data, error: null });

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A `File` whose `type` is deliberately empty, the way some pickers hand one back. */
const fileWithBytes = (bytes: number[], name = "upload"): File => new File([new Uint8Array(bytes)], name, { type: "" });

const makeContext = (upload: (file: File) => Promise<string>): ControllerContext => {
    const authClient = {
        getSession: vi.fn(),
        organization: { update: vi.fn(() => ok({ status: true })) },
    } as unknown as AuthClient;

    return resolveContext({ authClient, avatar: { upload }, nav: { navigate: vi.fn(), replace: vi.fn() } });
};

/**
 * `createOrganizationLogoController` carried the exact predicate that
 * `avatar.ts` was explicitly fixed for: a `File` with an empty `type` skipped
 * the accept-list check entirely (plan 260).
 */
describe("createOrganizationLogoController — empty-MIME sniff", () => {
    it("rejects a file with an empty type and non-image bytes, without uploading", async () => {
        expect.assertions(2);

        const upload = vi.fn(async () => "https://cdn.test/logo.png");
        const controller = createOrganizationLogoController(makeContext(upload));

        await controller.actions.upload(fileWithBytes([0x00, 0x01, 0x02, 0x03], "not-an-image"));

        expect(controller.getState().status).toBe("error");
        expect(upload).not.toHaveBeenCalled();
    });

    it("accepts a real PNG whose type is empty, via magic-byte sniff", async () => {
        expect.assertions(2);

        const upload = vi.fn(async () => "https://cdn.test/logo.png");
        const controller = createOrganizationLogoController(makeContext(upload));

        await controller.actions.upload(fileWithBytes(PNG_MAGIC, "photo"));

        expect(upload).toHaveBeenCalledTimes(1);
        expect(controller.getState().status).toBe("success");
    });

    it("still rejects a declared type outside the accept list, empty type or not", async () => {
        expect.assertions(1);

        const upload = vi.fn(async () => "https://cdn.test/logo.png");
        const controller = createOrganizationLogoController(makeContext(upload));

        await controller.actions.upload(new File([new Uint8Array(PNG_MAGIC)], "logo.svg", { type: "image/svg+xml" }));

        expect(controller.getState().status).toBe("error");
    });
});
