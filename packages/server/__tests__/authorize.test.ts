import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { authorize } from "../src/authorize";

interface Context {
    user: { canManageTeamMembers: boolean };
}

/** Runs the gate, with a `next` that records the handler ran and resolves to the context, as the builder's `next` does. */
const runGate = (canManage: boolean, onNext: () => void = () => undefined) => {
    const ctx: Context = { user: { canManageTeamMembers: canManage } };

    return authorize<Context>((context) => context.user.canManageTeamMembers)({
        ctx,
        next: () => {
            onNext();

            return Promise.resolve(ctx);
        },
    });
};

describe("authorize", () => {
    it("runs the handler when the permission check passes", async () => {
        expect.assertions(1);

        await expect(runGate(true)).resolves.toMatchObject({ user: { canManageTeamMembers: true } });
    });

    it("throws FORBIDDEN without running the handler when the permission check fails", async () => {
        expect.assertions(3);

        let handlerRan = false;

        await expect(
            runGate(false, () => {
                handlerRan = true;
            }),
        ).rejects.toBeInstanceOf(LunoraError);
        await expect(runGate(false)).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(handlerRan).toBe(false);
    });

    it("awaits an async permission check before deciding", async () => {
        expect.assertions(1);

        const ctx: Context = { user: { canManageTeamMembers: true } };
        const gate = authorize<Context>(async (context) => {
            await Promise.resolve();

            return context.user.canManageTeamMembers;
        });

        await expect(gate({ ctx, next: () => Promise.resolve(ctx) })).resolves.toBe(ctx);
    });
});
