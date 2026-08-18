/**
 * `@lunora/server` re-declares this package's `ctx.workflows` surface by hand
 * (`packages/server/src/types.ts`) so the main API package needs no dependency on
 * `@lunora/workflow`. Nothing else compares the two: they live in separate
 * api-snapshots, and codegen narrows `ctx.workflows` to *this* package's
 * `WorkflowHandle` as soon as an app declares a workflow, so the mirror is only
 * exercised by apps with zero workflows — it can rot for a long time unseen.
 *
 * These are type-level assertions: if either side moves, `true` stops being
 * assignable to the check type and `lint:types` fails here. The runtime `expect`
 * only exists so the file is a test rather than an unused-symbol lint error.
 */
import type {
    WorkflowCreateOptions as ServerCreateOptions,
    WorkflowEventDefinition as ServerEventDefinition,
    WorkflowHandle as ServerHandle,
    WorkflowInstance as ServerInstance,
    Workflows as ServerWorkflows,
    WorkflowStatusResult as ServerStatusResult,
} from "@lunora/server";
import { describe, expect, it } from "vitest";

import type { WorkflowCreateOptions, WorkflowEventDefinition, WorkflowHandle, WorkflowInstanceLike, Workflows, WorkflowStatusResult } from "../src/types";

/** `true` only when `A` and `B` are mutually assignable — i.e. the mirror has not drifted. */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("@lunora/server ctx.workflows mirror", () => {
    it("stays in lockstep with @lunora/workflow's types", () => {
        expect.assertions(1);

        const inLockstep: [
            Mutual<WorkflowCreateOptions, ServerCreateOptions>,
            Mutual<WorkflowEventDefinition, ServerEventDefinition>,
            Mutual<WorkflowHandle, ServerHandle>,
            Mutual<WorkflowInstanceLike, ServerInstance>,
            Mutual<WorkflowStatusResult, ServerStatusResult>,
            Mutual<Workflows, ServerWorkflows>,
        ] = [true, true, true, true, true, true];

        expect(inLockstep).toHaveLength(6);
    });
});
