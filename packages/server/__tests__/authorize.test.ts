import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { authorize } from "../src/authorize";

interface Context {
    user: { canManageTeamMembers: boolean };
}

const callAuthorized = (canManage: boolean, handler: () => string) =>
    authorize<Context>((ctx) => ctx.user.canManageTeamMembers)({
        ctx: { user: { canManageTeamMembers: canManage } },
        next: () => handler(),
    });

describe("authorize", () => {
    it("runs the handler when the permission check passes", async () => {
        expect.assertions(1);

        await expect(callAuthorized(true, () => "ran")).resolves.toBe("ran");
    });

    it("throws FORBIDDEN without running the handler when the permission check fails", async () => {
        expect.assertions(3);

        let handlerRan = false;

        await expect(
            callAuthorized(false, () => {
                handlerRan = true;

                return "ran";
            }),
        ).rejects.toBeInstanceOf(LunoraError);
        await expect(callAuthorized(false, () => "ran")).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(handlerRan).toBe(false);
    });

    it("awaits an async permission check before deciding", async () => {
        expect.assertions(1);

        const gate = authorize<Context>(async (ctx) => {
            await Promise.resolve();

            return ctx.user.canManageTeamMembers;
        });

        await expect(gate({ ctx: { user: { canManageTeamMembers: true } }, next: () => "ran" })).resolves.toBe("ran");
    });
});
