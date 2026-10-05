/**
 * The job runner's locks: one job per alias, and an `upgrade` — which
 * restarts every child — strictly alone: it waits for the jobs already
 * running, and every job that arrives while it runs waits for it.
 */
import { describe, expect, it } from "vitest";

import type { IsolationReport } from "../../src/daemon/isolation";
import type { JobContext } from "../../src/daemon/jobs";
import { JobRunner } from "../../src/daemon/jobs";
import { silentLogger } from "../../src/daemon/log";
import type { HostdState } from "../../src/daemon/state";
import type { Supervisor } from "../../src/daemon/supervisor";
import type { BoxMessage, HostdJob, ResultMessage } from "../../src/wire/types";

/** A promise the test settles by hand. */
const gate = (): { open: () => void; promise: Promise<void> } => {
    let open = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
        open = resolve;
    });

    return { open, promise };
};

const flush = async (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 20);
    });

/** A runner whose `reload` blocks on `restartGate` and whose `upgrade` blocks on `upgradeGate`, recording what started. */
const runnerWith = () => {
    const started: string[] = [];
    const sent: BoxMessage[] = [];
    let restartGate = gate();
    let upgradeGate = gate();
    const state: HostdState = { fleets: { app: { internalPort: 20_001, publicPort: 20_000, state: "running", updatedAt: 0 } }, version: 1 };
    const supervisor = {
        caddyOutput: [],
        isolation: { caddy: { prefix: [] }, fleet: { prefix: [] } },
        isRunning: () => true,
        outputOf: () => [],
        restartFleet: async (alias: string) => {
            started.push(`reload ${alias}`);
            await restartGate.promise;
        },
        waitHealthy: async () => undefined,
    } as unknown as Supervisor;
    const context = {
        applyEdge: async () => undefined,
        config: { boxId: "box_1", hostname: "b.example" },
        credentials: () => {
            return {};
        },
        dropRoutes: () => undefined,
        isolation: { problems: [], startsFleets: true, status: "enforced" } satisfies IsolationReport,
        logger: silentLogger,
        saveState: () => undefined,
        signedFetch: async () => new Response(null, { status: 404 }),
        state,
        supervisor,
        upgrade: async () => {
            started.push("upgrade");
            await upgradeGate.promise;
        },
    } as unknown as JobContext;
    const runner = new JobRunner(context, (message) => {
        sent.push(message);

        return true;
    });
    let counter = 0;
    const submit = (job: HostdJob): string => {
        counter += 1;

        const jobId = `job_${String(counter)}`;

        runner.submit({ job, jobId, type: "job" });

        return jobId;
    };
    const resultOf = (jobId: string): ResultMessage | undefined =>
        sent.find((message): message is ResultMessage => message.type === "result" && message.jobId === jobId);

    return {
        openRestart: () => {
            restartGate.open();
            restartGate = gate();
        },
        openUpgrade: () => {
            upgradeGate.open();
            upgradeGate = gate();
        },
        resultOf,
        runner,
        sent,
        started,
        submit,
    };
};

const UPGRADE: HostdJob = { kind: "upgrade", manifestUrl: "https://cloud.example/v1/hostd/releases/r/manifest", releaseId: "r" };

describe("the job runner's locks", () => {
    it("starts an upgrade only once the jobs already running have finished", async () => {
        expect.assertions(3);

        const box = runnerWith();
        const reload = box.submit({ alias: "app", kind: "reload" });

        await flush();
        box.submit(UPGRADE);
        await flush();

        expect(box.started).toStrictEqual(["reload app"]);

        box.openRestart();
        await flush();

        expect(box.resultOf(reload)).toMatchObject({ ok: true });
        expect(box.started).toStrictEqual(["reload app", "upgrade"]);

        box.openUpgrade();
        await box.runner.idle();
    });

    it("holds every job that arrives while an upgrade runs, a diagnose included, until it ends", async () => {
        expect.assertions(5);

        const box = runnerWith();
        const upgrade = box.submit(UPGRADE);

        await flush();

        const reload = box.submit({ alias: "app", kind: "reload" });
        const diagnose = box.submit({ kind: "diagnose" });

        await flush();

        expect(box.started).toStrictEqual(["upgrade"]);
        expect(box.sent.filter((message) => message.type === "progress" && message.jobId === diagnose)).toStrictEqual([]);

        box.openUpgrade();
        await flush();
        box.openRestart();
        await box.runner.idle();

        // Nothing of the diagnose went out before the upgrade's result.
        const frames = box.sent.map((message) => ("jobId" in message ? `${message.type} ${message.jobId}` : message.type));

        expect(box.started).toStrictEqual(["upgrade", "reload app"]);
        expect(frames.indexOf(`result ${upgrade}`)).toBeLessThan(frames.findIndex((frame) => frame.endsWith(diagnose)));
        expect([upgrade, reload].map((jobId) => box.resultOf(jobId)?.ok)).toStrictEqual([true, true]);
    });

    it("runs one upgrade at a time", async () => {
        expect.assertions(2);

        const box = runnerWith();

        box.submit(UPGRADE);
        box.submit(UPGRADE);
        await flush();

        expect(box.started).toStrictEqual(["upgrade"]);

        box.openUpgrade();
        await flush();

        expect(box.started).toStrictEqual(["upgrade", "upgrade"]);

        box.openUpgrade();
        await box.runner.idle();
    });
});
