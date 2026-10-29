import { describe, expect, it } from "vitest";

import defineIdentityGuard from "./identity-guard";
import { platformAdmin } from "./platform-admin";

const next = (): Promise<string> => Promise.resolve("ran");

describe("platformAdmin", () => {
    it("runs the rest of the chain for an admin", async () => {
        expect.assertions(1);

        const gate = platformAdmin<{ isAdmin: boolean }>((context) => context.isAdmin);

        await expect(gate({ ctx: { isAdmin: true }, next: next as never })).resolves.toBe("ran");
    });

    it("refuses a caller the check rejects, before the handler runs", async () => {
        expect.assertions(1);

        const gate = platformAdmin<{ isAdmin: boolean }>((context) => context.isAdmin);

        await expect(gate({ ctx: { isAdmin: false }, next: next as never })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("accepts an asynchronous check", async () => {
        expect.assertions(1);

        const gate = platformAdmin<{ id: string }>(async (context) => context.id === "admin");

        await expect(gate({ ctx: { id: "guest" }, next: next as never })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});

describe("defineIdentityGuard", () => {
    it("returns the guard it is given, so the declaration has no runtime effect", () => {
        expect.assertions(1);

        const guard = (user: string, value: string): void => {
            if (value !== user) {
                throw new Error("not the caller");
            }
        };

        expect(defineIdentityGuard(guard)).toBe(guard);
    });
});
