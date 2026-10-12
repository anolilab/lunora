/**
 * The hourly refresh of the dispatcher's stored plan records (plan 476). It runs
 * on the hourly tick, after the control plane's own code crons, so a suspension
 * or plan change they committed is picked up in the same invocation.
 *
 * INERT without the `PLAN_KV` binding, and without the admin token that the
 * in-process plan lookup needs: with either absent it returns before reading D1
 * or KV, and the dispatcher keeps refusing a control-plane outage on cold
 * isolates, as before. The binding is not declared in wrangler config yet; it
 * needs a real namespace id.
 *
 * Facts come from the control plane's own `/v1/tenants/plan`, reached in-process
 * the same way the build drain is, so a stored record is exactly what the
 * dispatcher would have been told. Scripts are the live deployments' scripts.
 */

import type { ExecutionContextLike, LunoraWorker } from "@lunora/runtime";

import type { ControlPlaneEnv } from "../control-plane-env";
import { readLiveDeployments } from "../fanout/live";
import type { PlanFacts } from "../plans/plan-facts";
import { normalizeFacts, toScriptFacts } from "../plans/plan-facts";
import { createKvPlanStore } from "../plans/plan-store-kv";
import { refreshPlanRecords } from "../plans/plan-writer";
import readJson from "../read-json";

/** Scripts checked per hourly tick. Each costs a KV read at least, so a larger fleet is walked over several hours. */
export const PLAN_RECORDS_PER_TICK = 1000;

export const PLAN_FACTS_URL = "https://control-plane.internal/v1/tenants/plan";

/**
 * One tick's share of the scripts. A scheduled invocation has a subrequest and
 * CPU budget, and every script costs a KV read at least, so a large fleet is
 * walked in slices: the start moves by one slice per hour, over the names in
 * sorted order, so every script is visited once per `ceil(n / size)` hours and
 * no tail is starved. A fleet within one slice is visited whole, every hour.
 */
export const planRecordSlice = (scriptNames: ReadonlyArray<string>, hourIndex: number, size: number): string[] => {
    const sorted = scriptNames.toSorted((a, b) => a.localeCompare(b));

    if (sorted.length <= size) {
        return sorted;
    }

    const start = (((hourIndex * size) % sorted.length) + sorted.length) % sorted.length;

    return Array.from({ length: size }, (_, index) => sorted[(start + index) % sorted.length] ?? "");
};

/**
 * The current facts for one script, read from the control plane's own lookup. A
 * non-OK answer, or a body without a plan, throws: the writer counts that as a
 * failure and keeps the record, where a missing plan would otherwise read as "delete".
 */
export const factsFromControlPlane =
    (env: ControlPlaneEnv, context: ExecutionContextLike, worker: Pick<LunoraWorker, "fetch">) =>
    async (scriptName: string): Promise<PlanFacts> => {
        const response = await worker.fetch(
            new Request(`${PLAN_FACTS_URL}?script=${encodeURIComponent(scriptName)}`, {
                headers: { authorization: `Bearer ${env.LUNORA_ADMIN_TOKEN ?? ""}` },
            }),
            env,
            context,
        );

        if (!response.ok) {
            throw new Error(`plan lookup for ${scriptName} answered ${String(response.status)}`);
        }

        // The dispatcher and the sweep read one answer, so one parser decides what is a valid plan.
        const facts = toScriptFacts(await readJson<unknown>(response));

        if (facts === undefined) {
            throw new TypeError(`plan lookup for ${scriptName} answered an unrecognised plan`);
        }

        return normalizeFacts(facts);
    };

/** Refresh every live script's stored record. Inert, with no D1 or KV read, unless both `PLAN_KV` and the admin token are set. */
export const sweepPlanRecords = async (env: ControlPlaneEnv, context: ExecutionContextLike, worker: Pick<LunoraWorker, "fetch">): Promise<void> => {
    if (!env.PLAN_KV || !env.LUNORA_ADMIN_TOKEN) {
        return;
    }

    const live = await readLiveDeployments(env);
    const scriptNames = [...new Set(live.map((row) => row.scriptName))];
    const now = Date.now();
    const outcome = await refreshPlanRecords(planRecordSlice(scriptNames, Math.floor(now / 3_600_000), PLAN_RECORDS_PER_TICK), {
        facts: factsFromControlPlane(env, context, worker),
        now: () => Date.now(),
        store: createKvPlanStore(env.PLAN_KV),
    });

    if (outcome.failed.length > 0) {
        console.warn(`[plans] ${String(outcome.failed.length)} stored plan record(s) not refreshed this tick; the next tick retries them`);
    }
};
