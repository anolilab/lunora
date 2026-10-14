import { describe, expect, it, vi } from "vitest";

import type { ControllerContext } from "../../src/core";
import { resolveContext } from "../../src/core";
import { createResourceController } from "../../src/core/create-resource-controller";

const makeContext = (): ControllerContext => resolveContext({ authClient: { getSession: vi.fn() }, nav: { navigate: vi.fn(), replace: vi.fn() } });

describe("createResourceController", () => {
    it("drops a slow answer for an earlier query when a faster one for a later query already landed", async () => {
        expect.assertions(1);

        // Two in-flight loads racing — the first (for "al") resolves AFTER the
        // second (for "alice"). Without a generation guard the slow answer for
        // the stale query would land last and overwrite the correct one.
        let releaseSlow: (() => void) | undefined;
        const slow = new Promise<void>((resolve) => {
            releaseSlow = resolve;
        });

        let calls = 0;
        const load = vi.fn(async () => {
            calls += 1;

            if (calls === 1) {
                await slow;

                return { items: ["al-result"] };
            }

            return { items: ["alice-result"] };
        });

        const controller = createResourceController(makeContext(), load, { autoLoad: false });

        const first = controller.refetch(); // "al"
        const second = controller.refetch(); // "alice", overlapping

        await second;
        releaseSlow?.();
        await first;

        expect(controller.getState().items).toStrictEqual(["alice-result"]);
    });

    it("nests a returned `extra` patch under `state.extra` instead of clobbering the store root", async () => {
        expect.assertions(2);

        const load = vi.fn(async () => {
            return { extra: { total: 42 }, items: [] };
        });

        const controller = createResourceController<never, { total?: number }>(makeContext(), load, { autoLoad: false, initialExtra: {} });

        await controller.refetch();

        expect(controller.getState().extra).toStrictEqual({ total: 42 });
        // The rest of the snapshot must survive the patch — a top-level
        // `store.update(patched)` would have overwritten `items`/`status` with
        // whatever keys happened to be in `extra`, not merged into `extra`.
        expect(controller.getState().status).toBe("success");
    });

    it("preserves existing extra keys a load's patch does not mention", async () => {
        expect.assertions(1);

        const load = vi.fn(async () => {
            return { extra: { total: 5 }, items: [] };
        });

        const controller = createResourceController<never, { search: string; total?: number }>(makeContext(), load, {
            autoLoad: false,
            initialExtra: { search: "ada" },
        });

        await controller.refetch();

        expect(controller.getState().extra).toStrictEqual({ search: "ada", total: 5 });
    });
});
