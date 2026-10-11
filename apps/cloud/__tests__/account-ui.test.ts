import { describe, expect, it, vi } from "vitest";

import type { AuthUIConfig } from "../lunora/auth-ui/core/config";
import { resolveContext } from "../lunora/auth-ui/core/config";
import { createDeleteAccountController } from "../lunora/auth-ui/core/delete-account";
import { accountExportErrorMessage, accountExportFilename } from "../src/client/account-export";

describe(accountExportFilename, () => {
    it("dates the file in UTC", () => {
        expect.assertions(1);

        expect(accountExportFilename(new Date("2026-10-11T23:30:00-05:00"))).toBe("lunora-account-export-2026-10-12.json");
    });
});

describe(accountExportErrorMessage, () => {
    it("shows the route's own error", () => {
        expect.assertions(1);

        expect(accountExportErrorMessage(401, JSON.stringify({ error: "not signed in" }))).toBe("not signed in");
    });

    it("shows a plain-text body as is", () => {
        expect.assertions(1);

        expect(accountExportErrorMessage(502, " upstream unavailable\n")).toBe("upstream unavailable");
    });

    it.each([
        ["an empty body", ""],
        ["JSON without an error", JSON.stringify({ message: "nope" })],
        ["an empty error", JSON.stringify({ error: " " })],
        ["an HTML error page", "<!doctype html><title>500</title>"],
    ])("falls back to the status for %s", (_label, body) => {
        expect.assertions(1);

        expect(accountExportErrorMessage(500, body)).toBe("could not export your data (HTTP 500)");
    });
});

describe("delete-account card", () => {
    it("shows the server's refusal for the sole owner of an organization", async () => {
        expect.assertions(3);

        const message = "You are the only owner of Acme Dev. Transfer ownership or delete the organization before deleting your account.";
        const deleteUser = vi.fn<(input: { password: string }) => Promise<unknown>>(async () => {
            return { data: null, error: { code: "SOLE_ORGANIZATION_OWNER", message, status: 400 } };
        });
        const replace = vi.fn<(to: string) => void>();
        const config = { authClient: { deleteUser }, nav: { navigate: vi.fn<(to: string) => void>(), replace } } as unknown as AuthUIConfig;
        const controller = createDeleteAccountController(resolveContext(config));

        controller.actions.setField("password", "typed-by-the-user");
        await controller.actions.submit();

        expect(controller.getState().formError).toBe(message);
        expect(deleteUser).toHaveBeenCalledWith({ password: "typed-by-the-user" });
        expect(replace).not.toHaveBeenCalled();
    });
});
