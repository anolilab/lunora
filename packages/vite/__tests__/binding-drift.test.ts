import type { DiscoveryCache } from "@lunora/config";
import { createDiscoveryCache } from "@lunora/config";
import { describe, expect, it, vi } from "vitest";

import type { BindingDriftNotifierOptions } from "../src/binding-drift";
import { BINDING_DRIFT_SETTLE_MS, createBindingDriftNotifier } from "../src/binding-drift";

/** A hand-driven timer: `fire` runs the one scheduled callback, if a save left one, and answers its promise. */
const manualSchedule = (): { delays: number[]; fire: () => Promise<void>; schedule: NonNullable<BindingDriftNotifierOptions["schedule"]> } => {
    let scheduled: (() => Promise<void>) | undefined;
    const delays: number[] = [];

    return {
        delays,
        fire: async () => {
            const run = scheduled;

            scheduled = undefined;
            await run?.();
        },
        schedule: (run, ms) => {
            scheduled = run;
            delays.push(ms);

            return () => {
                if (scheduled === run) {
                    scheduled = undefined;
                }
            };
        },
    };
};

/** A scan that answers `current()` through the cache, as the real one memoises its source scan. */
const memoisedScan =
    (current: () => string[]): NonNullable<BindingDriftNotifierOptions["pending"]> =>
    async ({ cache }: { cache: DiscoveryCache }) =>
        cache.memo("scan", current);

const setup = (scan: NonNullable<BindingDriftNotifierOptions["pending"]>, isSuppressed: () => boolean = () => false) => {
    const timer = manualSchedule();
    const warn = vi.fn<(message: string) => void>();
    const notifier = createBindingDriftNotifier({
        cache: createDiscoveryCache(),
        isSuppressed,
        pending: scan,
        project: { projectRoot: "/app", schemaDir: "lunora" },
        schedule: timer.schedule,
        warn,
    });

    return { notifier, settle: timer.fire, timer, warn };
};

describe(createBindingDriftNotifier, () => {
    it("lets a save that has not settled yet cancel the scan an earlier one scheduled, and drop the one it is running", async () => {
        expect.assertions(2);

        const answers: ((labels: string[]) => void)[] = [];
        const { notifier, settle, warn } = setup(
            async () =>
                await new Promise<string[]>((resolve) => {
                    answers.push(resolve);
                }),
        );

        notifier.noteSave();
        const running = settle();

        notifier.noteSave();
        // A later save arrives; codegen will call noteSave once it settles.
        notifier.invalidate();
        await settle();

        answers[0]?.(["QUEUE_ORDERS (Queue)"]);
        await running;

        // The second save's scan never started, and the first one's answer was dropped.
        expect(answers).toHaveLength(1);
        expect(warn).not.toHaveBeenCalled();
    });

    it("drops a scan that a later save overtook, so a removed binding is never announced", async () => {
        expect.assertions(2);

        const answers: ((labels: string[]) => void)[] = [];
        const { notifier, settle, warn } = setup(
            async () =>
                await new Promise<string[]>((resolve) => {
                    answers.push(resolve);
                }),
        );

        notifier.noteSave();
        const first = settle();

        // The developer removes the queue while the first scan is still reading.
        notifier.noteSave();
        const second = settle();

        answers[1]?.([]);
        await second;
        answers[0]?.(["QUEUE_ORDERS (Queue)"]);
        await first;

        expect(answers).toHaveLength(2);
        expect(warn).not.toHaveBeenCalled();
    });

    it("scans once per settled burst of saves, not once per save", async () => {
        expect.assertions(3);

        const scan = vi.fn<NonNullable<BindingDriftNotifierOptions["pending"]>>(async () => ["QUEUE_ORDERS (Queue)"]);
        const { notifier, settle, timer, warn } = setup(scan);

        // Autosave while typing `defineQueue("orders")`.
        notifier.noteSave();
        notifier.noteSave();
        notifier.noteSave();
        await settle();

        expect(timer.delays).toStrictEqual([BINDING_DRIFT_SETTLE_MS, BINDING_DRIFT_SETTLE_MS, BINDING_DRIFT_SETTLE_MS]);
        expect(scan).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("lists the whole pending set when it gains a label, drops one that went away, and stays quiet when nothing is new", async () => {
        expect.assertions(4);

        const answers = [["QUEUE_O (Queue)"], ["QUEUE_ORDERS (Queue)"], ["QUEUE_ORDERS (Queue)", "KV (KV namespace)"], ["KV (KV namespace)"]];
        const { notifier, warn } = setup(async () => answers.shift() ?? []);

        // One scan per settled save, in order.
        await notifier.check();
        await notifier.check();
        await notifier.check();
        await notifier.check();

        const lines = warn.mock.calls.map(([message]) => message);

        expect(lines).toHaveLength(3);
        expect(lines[1]).toContain("QUEUE_ORDERS (Queue) — not in the running worker yet. Restart the dev server to write it");
        expect(lines[1]).not.toContain("QUEUE_O (Queue)");
        expect(lines[2]).toContain("QUEUE_ORDERS (Queue), KV (KV namespace) — not in the running worker yet. Restart the dev server to write them");
    });

    it("says nothing when a restart starts while the scan is running", async () => {
        expect.assertions(1);

        let restarting = false;
        const { notifier, warn } = setup(
            async () => {
                restarting = true;

                return ["QUEUE_ORDERS (Queue)"];
            },
            () => restarting,
        );

        await notifier.check();

        expect(warn).not.toHaveBeenCalled();
    });

    it("rescans after a save rather than answering from the last save's memo", async () => {
        expect.assertions(1);

        let declared: string[] = [];
        const { notifier, settle, warn } = setup(memoisedScan(() => declared));

        notifier.noteSave();
        await settle();

        declared = ["QUEUE_ORDERS (Queue)"];
        notifier.noteSave();
        await settle();

        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("cancels a scheduled scan on dispose", async () => {
        expect.assertions(1);

        const scan = vi.fn<NonNullable<BindingDriftNotifierOptions["pending"]>>(async () => ["QUEUE_ORDERS (Queue)"]);
        const { notifier, settle } = setup(scan);

        notifier.noteSave();
        notifier.dispose();
        await settle();

        expect(scan).not.toHaveBeenCalled();
    });
});
