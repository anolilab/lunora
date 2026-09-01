/**
 * `@lunora/server` re-declares the scheduler's job record by hand — twice: as
 * {@link ScheduledJob} (the `ctx.scheduler.list()` view) and as
 * {@link ScheduledFunctionDoc} (the `_scheduled_functions` system-table view) —
 * so the public ctx surface names its own types instead of re-exporting the
 * scheduler's. Nothing compared them, and both had drifted: `functionPath` was
 * declared REQUIRED while the producer omits it for a workflow-targeted job, and
 * `workflow` / `pool` / `retry` / `instanceName` were missing outright. An app
 * de-duplicating on `functionPath` therefore never matched a workflow job and
 * scheduled a second one on every run.
 *
 * `@lunora/scheduler` is already a dependency of this package, so the guard can
 * be a real type-level one: if either side moves, `true` stops being assignable
 * and `lint:types` fails here.
 */
import type { ScheduleRecord } from "@lunora/scheduler";
import { describe, expect, it } from "vitest";

import type { ScheduledFunctionDoc, ScheduledJob } from "../src/types";

/** `true` only when `A` and `B` are mutually assignable — i.e. the mirror has not drifted. */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("@lunora/scheduler record mirrors", () => {
    it("stay in lockstep with the real ScheduleRecord", () => {
        expect.assertions(1);

        const inLockstep: [
            // The ctx view is the whole record, field for field.
            Mutual<ScheduledJob, ScheduleRecord>,
            // The system-table view is a subset — `Pick` itself fails to compile if
            // it names a field the record no longer has.
            Mutual<ScheduledFunctionDoc, Pick<ScheduleRecord, keyof ScheduledFunctionDoc>>,
        ] = [true, true];

        expect(inLockstep).toHaveLength(2);
    });
});
