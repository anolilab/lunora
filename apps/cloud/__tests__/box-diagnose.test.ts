import type { DeployJob } from "@lunora/hostd/protocol";
import { HOSTD_PROTOCOL_LIMITS } from "@lunora/hostd/protocol";
import { describe, expect, it } from "vitest";

import { createDiagnoseCollector, DIAGNOSE_TIMEOUT_MS } from "../src/boxes/diagnose";
import { fleetsAfterJob, normaliseFleets } from "../src/boxes/fleets";
import type { BoxSession } from "../src/boxes/session-client";
import { handleBoxDiagnoseRoute } from "../src/deploy/routes/boxes";
import type { RouterEnv } from "../src/deploy/routes/shared";
import readJson from "./_helpers/read-json";
import { fakeSessionNamespace } from "./support/box-session-fakes";

/** Box diagnostics and fleets (plan 458 W9): the capped diagnose answer, the route that runs it, and the fleet bookkeeping. */

const diagnoseRequest = (body: unknown): Request => new Request("https://cloud.test/v1/boxes/diagnose", { body: JSON.stringify(body), method: "POST" });

const contextAnswering = (mutation: () => Promise<unknown>) => {
    const calls: Record<string, unknown>[] = [];

    return {
        calls,
        context: {
            runAction: () => Promise.reject(new Error("unused")),
            runMutation: (_reference: unknown, args: Record<string, unknown> = {}) => {
                calls.push(args);

                return mutation();
            },
            runQuery: () => Promise.reject(new Error("unused")),
        } as NonNullable<RouterEnv["__lunoraCtx"]>,
    };
};

/** A session whose `dispatch` prints `lines` and answers `outcome`, recording what it was asked. */
const sessionPrinting = (lines: string[], outcome: Awaited<ReturnType<BoxSession["dispatch"]>>) => {
    const dispatched: { boxId: string; job: unknown; timeoutMs?: number }[] = [];

    return {
        dispatched,
        namespace: fakeSessionNamespace((boxId) => {
            return {
                dispatch: (job, options) => {
                    dispatched.push({ boxId, job, timeoutMs: options?.timeoutMs });

                    for (const line of lines) {
                        options?.onProgress?.(line);
                    }

                    return Promise.resolve(outcome);
                },
            };
        }),
    };
};

describe(createDiagnoseCollector, () => {
    it("keeps every line within the caps, in order", () => {
        const collector = createDiagnoseCollector();

        collector.add("{");
        collector.add("}");

        expect(collector.finish({ ok: true })).toStrictEqual({ ok: true, output: ["{", "}"], truncated: false });
    });

    it("stops at the line cap and the byte cap, and says it did", () => {
        const byLines = createDiagnoseCollector({ maxBytes: 1000, maxLines: 2 });

        for (const line of ["a", "b", "c"]) {
            byLines.add(line);
        }

        expect(byLines.finish({ ok: true })).toStrictEqual({ ok: true, output: ["a", "b"], truncated: true });

        const byBytes = createDiagnoseCollector({ maxBytes: 8, maxLines: 100 });

        // "abc\n" + "ä€\n" is 4 + 6 bytes: the second line does not fit, nor does anything after it.
        for (const line of ["abc", "ä€", "d"]) {
            byBytes.add(line);
        }

        expect(byBytes.finish({ ok: true })).toStrictEqual({ ok: true, output: ["abc"], truncated: true });
    });

    it("bounds a box that never stops printing to one frame's worth by default", () => {
        const collector = createDiagnoseCollector();
        const line = "x".repeat(HOSTD_PROTOCOL_LIMITS.maxLineBytes - 1);

        for (let index = 0; index < 1000; index += 1) {
            collector.add(line);
        }

        const report = collector.finish({ ok: true });

        expect(report.truncated).toBe(true);
        expect(report.output.join("\n").length).toBeLessThanOrEqual(HOSTD_PROTOCOL_LIMITS.maxFrameBytes);
    });

    it("carries the failure of a job that did not finish, with what arrived before it", () => {
        const collector = createDiagnoseCollector();

        collector.add("celld: ok");

        expect(collector.finish({ error: { code: "JOB_TIMEOUT", message: "slow" }, ok: false })).toStrictEqual({
            error: { code: "JOB_TIMEOUT", message: "slow" },
            ok: false,
            output: ["celld: ok"],
            truncated: false,
        });
    });
});

describe("the diagnose route, POST /v1/boxes/diagnose", () => {
    it("authorizes under the caller's session, then runs diagnose on the box and answers its output", async () => {
        const { calls, context } = contextAnswering(() => Promise.resolve({ slug: "bslug000001" }));
        const { dispatched, namespace } = sessionPrinting(['{"ok":', "true}"], { ok: true });

        const response = await handleBoxDiagnoseRoute(diagnoseRequest({ id: "box_1", organizationId: "org_1" }), {
            __lunoraCtx: context,
            BOX_SESSION: namespace,
        });

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await expect(readJson(response)).resolves.toStrictEqual({ ok: true, output: ['{"ok":', "true}"], truncated: false });
        expect(calls).toStrictEqual([{ id: "box_1", organizationId: "org_1" }]);
        expect(dispatched).toStrictEqual([{ boxId: "box_1", job: { kind: "diagnose" }, timeoutMs: DIAGNOSE_TIMEOUT_MS }]);
    });

    it("answers a job that failed with its error and what arrived before it", async () => {
        const { context } = contextAnswering(() => Promise.resolve({ slug: "bslug000001" }));
        const { namespace } = sessionPrinting([], { error: { code: "BOX_OFFLINE", message: "the box is not connected" }, ok: false });

        const response = await handleBoxDiagnoseRoute(diagnoseRequest({ id: "box_1", organizationId: "org_1" }), {
            __lunoraCtx: context,
            BOX_SESSION: namespace,
        });

        await expect(readJson(response)).resolves.toStrictEqual({
            error: { code: "BOX_OFFLINE", message: "the box is not connected" },
            ok: false,
            output: [],
            truncated: false,
        });
    });

    it("runs nothing on the box when the caller may not diagnose it", async () => {
        const refusal = Object.assign(new Error("forbidden"), { code: "FORBIDDEN", status: 403 });
        const { context } = contextAnswering(() => Promise.reject(refusal));
        const { dispatched, namespace } = sessionPrinting([], { ok: true });

        const response = await handleBoxDiagnoseRoute(diagnoseRequest({ id: "box_1", organizationId: "org_1" }), {
            __lunoraCtx: context,
            BOX_SESSION: namespace,
        });

        expect(response.status).toBe(403);
        expect(dispatched).toStrictEqual([]);
    });

    it("refuses a body without the box and its organization, and a control plane with no box sessions", async () => {
        const { calls, context } = contextAnswering(() => Promise.resolve({}));
        const { namespace } = sessionPrinting([], { ok: true });

        await expect(handleBoxDiagnoseRoute(diagnoseRequest({ id: "box_1" }), { __lunoraCtx: context, BOX_SESSION: namespace })).resolves.toMatchObject({
            status: 400,
        });
        await expect(handleBoxDiagnoseRoute(diagnoseRequest({ id: "box_1", organizationId: "org_1" }), { __lunoraCtx: context })).resolves.toMatchObject({
            status: 503,
        });
        expect(calls).toStrictEqual([]);
    });
});

describe("box fleets", () => {
    const deploy: DeployJob = { alias: "web", crons: [], deploymentId: "dep_2", kind: "deploy", releaseUrl: "https://cloud.test/r", vars: {} };

    it("keeps one entry per alias, sorted, within the protocol's fleet cap", () => {
        const many = Array.from({ length: HOSTD_PROTOCOL_LIMITS.maxFleets + 5 }, (_, index) => {
            return { alias: `a${String(index).padStart(4, "0")}`, state: "running" as const };
        });

        expect(
            normaliseFleets([
                { alias: "b", state: "stopped" },
                { alias: "a", state: "running" },
                { alias: "b", deploymentId: "dep_1", state: "running" },
            ]),
        ).toStrictEqual([
            { alias: "a", state: "running" },
            { alias: "b", deploymentId: "dep_1", state: "running" },
        ]);
        expect(normaliseFleets(many)).toHaveLength(HOSTD_PROTOCOL_LIMITS.maxFleets);
    });

    it("runs a deployed alias, restarts a reloaded one and drops a destroyed one — on success only", () => {
        const fleets = [{ alias: "web", deploymentId: "dep_1", state: "failed" as const }];

        expect(fleetsAfterJob(fleets, deploy, { ok: true })).toStrictEqual([{ alias: "web", deploymentId: "dep_2", state: "running" }]);
        expect(fleetsAfterJob(fleets, { alias: "web", kind: "reload" }, { ok: true })).toStrictEqual([
            { alias: "web", deploymentId: "dep_1", state: "running" },
        ]);
        expect(fleetsAfterJob(fleets, { alias: "web", deleteData: false, kind: "destroy" }, { ok: true })).toStrictEqual([]);
        expect(fleetsAfterJob(fleets, deploy, { error: { code: "X", message: "no" }, ok: false })).toBeUndefined();
        expect(fleetsAfterJob(fleets, { kind: "diagnose" }, { ok: true })).toBeUndefined();
    });
});
