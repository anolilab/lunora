import { describe, expect, it } from "vitest";

import { ACCOUNT_CONVERGE_CONCURRENCY, BOX_CONVERGE_CONCURRENCY, createDeployPacer, pacingOf } from "../src/deploy/pacing";
import type { ConvergeScheduler } from "../src/deploy/scheduler";
import type { Placement } from "../src/targets/placement";

/** Deploy pacing per target: each converge spends the budget its placement names, and only that one. */

const WFP: Placement = { target: "cloudflare-wfp" };
const box = (id: string): Placement => {
    return { box: { id, slug: `b${id}` }, target: "celld-vps" };
};
const account = (id: string, accountId: string): Placement => {
    return { account: { accountId, id, workersSubdomain: "acme" }, target: "cloudflare-workers" };
};

/** A frozen clock whose sleeps never end: a scheduler out of tokens queues for good, so a test sees exactly what ran. */
const frozen = (): { now: () => number; sleep: () => Promise<void> } => {
    return {
        now: () => 0,
        sleep: () =>
            new Promise<void>(() => {
                // Never resolves.
            }),
    };
};

/** Submit `count` tasks that stay running until released; answers how many started. */
const hold = (scheduler: ConvergeScheduler, count: number): { release: () => void; started: () => number } => {
    let started = 0;
    const gates: (() => void)[] = [];

    for (let index = 0; index < count; index += 1) {
        scheduler
            .run(
                () =>
                    new Promise<void>((resolve) => {
                        started += 1;
                        gates.push(resolve);
                    }),
            )
            .catch(() => undefined);
    }

    return {
        release: () => {
            for (const gate of gates) {
                gate();
            }
        },
        started: () => started,
    };
};

describe(pacingOf, () => {
    it("paces cloudflare-wfp on the platform account, one budget for the whole cell", () => {
        expect(pacingOf(WFP)).toStrictEqual({ budget: "platform-account", key: "platform" });
    });

    it("paces cloudflare-workers on the connected Cloudflare account, keyed by the account itself", () => {
        expect(pacingOf(account("cfa_1", "a".repeat(32)))).toStrictEqual({ budget: "connected-account", key: `account:${"a".repeat(32)}` });
        // Two organizations that connected the same account share Cloudflare's limit for it.
        expect(pacingOf(account("cfa_2", "a".repeat(32))).key).toBe(pacingOf(account("cfa_1", "a".repeat(32))).key);
    });

    it("paces celld-vps per box, on no API budget", () => {
        expect(pacingOf(box("box_1"))).toStrictEqual({ budget: "box", key: "box:box_1" });
    });
});

describe(createDeployPacer, () => {
    it("hands every placement of one budget the same scheduler, and each budget its own", () => {
        const pacer = createDeployPacer();

        expect(pacer.schedulerFor(WFP)).toBe(pacer.schedulerFor({ target: "cloudflare-wfp" }));
        expect(pacer.schedulerFor(box("box_1"))).toBe(pacer.schedulerFor(box("box_1")));
        expect(pacer.schedulerFor(box("box_1"))).not.toBe(pacer.schedulerFor(box("box_2")));
        expect(pacer.schedulerFor(box("box_1"))).not.toBe(pacer.schedulerFor(WFP));
        expect(pacer.schedulerFor(account("cfa_1", "a".repeat(32)))).not.toBe(pacer.schedulerFor(WFP));
    });

    it("keeps cloudflare-wfp paced exactly as before: 1,200 converges per 5 minutes, six at a time", async () => {
        const pacer = createDeployPacer(frozen());
        const platform = pacer.schedulerFor(WFP);
        const running = hold(platform, 10);

        await Promise.resolve();

        expect(running.started()).toBe(ACCOUNT_CONVERGE_CONCURRENCY);

        running.release();

        // Spend the rest of the budget: of 1,300 more, 1,200 - 10 run and the remainder waits for the next token.
        let ran = 0;

        for (let index = 0; index < 1300; index += 1) {
            platform
                .run(() => {
                    ran += 1;

                    return Promise.resolve();
                })
                .catch(() => undefined);
        }

        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(ran + 10).toBe(1200);
    });

    it("never holds a box's or a connected account's converge behind an exhausted platform budget", async () => {
        const pacer = createDeployPacer(frozen());
        const platform = pacer.schedulerFor(WFP);

        // Exhaust the platform account's 1,200 tokens; one more cell converge then waits for good (the clock is frozen).
        await Promise.all(Array.from({ length: 1200 }, () => platform.run(() => Promise.resolve())));

        let waiting = true;

        platform
            .run(() => {
                waiting = false;

                return Promise.resolve();
            })
            .catch(() => undefined);

        await expect(pacer.schedulerFor(box("box_1")).run(() => Promise.resolve("box"))).resolves.toBe("box");
        await expect(pacer.schedulerFor(account("cfa_1", "b".repeat(32))).run(() => Promise.resolve("account"))).resolves.toBe("account");
        expect(waiting).toBe(true);
    });

    it("queues a box's converges past its concurrency instead of sending the session more jobs", async () => {
        const pacer = createDeployPacer(frozen());
        const running = hold(pacer.schedulerFor(box("box_1")), BOX_CONVERGE_CONCURRENCY + 3);
        const other = hold(pacer.schedulerFor(box("box_2")), 1);

        await Promise.resolve();

        expect(running.started()).toBe(BOX_CONVERGE_CONCURRENCY);
        // Another box is not queued behind this one.
        expect(other.started()).toBe(1);

        running.release();
        other.release();
    });

    it("drops idle schedulers of boxes and accounts, never the platform's or a busy one", async () => {
        const pacer = createDeployPacer();
        const platform = pacer.schedulerFor(WFP);
        const busy = pacer.schedulerFor(box("busy"));
        const running = hold(busy, 1);
        const first = pacer.schedulerFor(box("box_0"));

        for (let index = 1; index < 70; index += 1) {
            pacer.schedulerFor(box(`box_${String(index)}`));
        }

        expect(pacer.schedulerFor(WFP)).toBe(platform);
        expect(pacer.schedulerFor(box("busy"))).toBe(busy);
        // box_0 was idle when the pacer grew past its bound, so it was dropped and is built afresh.
        expect(pacer.schedulerFor(box("box_0"))).not.toBe(first);

        running.release();
        await Promise.resolve();
    });
});
