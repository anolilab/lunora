import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The terminal runtime is replaced so the app can be made to end at a chosen
// moment relative to `TasksView`'s effect. Only `render` is stubbed; every
// component and hook stays real, and the "mounted" mode renders through
// `@visulima/tui`'s own test renderer so the effects really run.
const state = vi.hoisted(() => {
    return { mount: false };
});

vi.mock(import("@visulima/tui"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("@visulima/tui")>();
    const { render: testRender } = await import("@visulima/tui/test");

    const render = (element: ReactElement) => {
        if (!state.mount) {
            // Ends without ever mounting the view: the same observable state as
            // an interrupt landing before the passive effect runs.
            return {
                exit: () => {},
                unmount: () => {},
                waitUntilExit: async () => {
                    throw new Error("terminal went away");
                },
            };
        }

        const instance = testRender(element);

        return {
            ...instance,
            // Mounted (so the chain started), then torn down while a task is
            // still in flight — the real Ctrl-C shape.
            waitUntilExit: async () => {
                await new Promise((resolve) => {
                    setTimeout(resolve, 10);
                });

                throw new Error("interrupted");
            },
        };
    };

    // `runInkApp` only ever touches `waitUntilExit` and `unmount`. The cast
    // stands in for the dozen other members of the real terminal `Instance`
    // (`rootNode`, `rerender`, `clear`, …) that a headless test never reaches;
    // implementing them would be inventing behaviour nothing calls.
    return { ...actual, render: render as unknown as typeof actual.render };
});

const { tuiTasks } = await import("../../src/util/tui-prompts");

/** Run `body` with the interactive branch forced on — off a TTY `tuiTasks` never renders at all. */
const asTty = async <T>(body: () => Promise<T>): Promise<T> => {
    const previous = process.stdin.isTTY;

    process.stdin.isTTY = true;

    try {
        return await body();
    } finally {
        process.stdin.isTTY = previous;
    }
};

/** Settle `promise` to its message, or `"hung"` if it has not settled within `ms`. */
const settleOrHang = async (promise: Promise<unknown>, ms: number): Promise<unknown> =>
    await Promise.race([
        promise.then(
            () => "resolved",
            (error: unknown) => (error instanceof Error ? error.message : "rejected"),
        ),
        new Promise((resolve) => {
            setTimeout(resolve, ms, "hung");
        }),
    ]);

describe("tuiTasks settlement wait", () => {
    afterEach(() => {
        state.mount = false;
    });

    it("does not hang when the app ends before the task chain starts", async () => {
        expect.assertions(2);

        // `@visulima/tui` attaches its Ctrl-C listener in a LAYOUT effect while
        // `TasksView` starts the chain in a PASSIVE one, so an interrupt can end
        // the app in between — and then nothing ever calls `onSettle`. The wait
        // on the error path was unconditional, so the CLI waited forever instead
        // of surfacing the interrupt.
        let ran = false;

        const outcome = await asTty(async () =>
            settleOrHang(
                tuiTasks(
                    [
                        {
                            label: "copy",
                            run: async () => {
                                ran = true;
                            },
                        },
                    ],
                    { end: "done", start: "working…" },
                ),
                500,
            ),
        );

        expect(outcome).toBe("terminal went away");
        // Nothing started, so there was nothing to wait for.
        expect(ran).toBe(false);
    });

    it("still waits for an in-flight task when the chain did start", async () => {
        expect.assertions(2);

        // The guard the wait exists for, and which the fix above must not
        // remove: the running task cannot be interrupted, so the caller must not
        // be handed back control until it stops touching the disk. `lunora init`
        // otherwise removed the partially-created project and the still-running
        // copy re-created it.
        state.mount = true;

        let finished = false;

        const outcome = await asTty(async () =>
            settleOrHang(
                tuiTasks(
                    [
                        {
                            label: "copy",
                            run: async () => {
                                await new Promise((resolve) => {
                                    setTimeout(resolve, 120);
                                });

                                finished = true;
                            },
                        },
                    ],
                    { end: "done", start: "working…" },
                ),
                2000,
            ),
        );

        expect(outcome).toBe("interrupted");
        // The rethrow waited for the in-flight write to finish.
        expect(finished).toBe(true);
    });
});
