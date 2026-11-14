import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorProcedureProtection, LintContext } from "../src";
import { fromServerSchema } from "../src";
import actionWithoutErrorHandling from "../src/lints/static/action-without-error-handling";
import adminRouteWithoutGuard from "../src/lints/static/admin-route-without-guard";
import aiRunWithoutLogging from "../src/lints/static/ai-run-without-logging";
import aiUnboundedGenerationPublic from "../src/lints/static/ai-unbounded-generation-public";
import containerLongSleepAfter from "../src/lints/static/container-long-sleep-after";
import containerOversizedInstance from "../src/lints/static/container-oversized-instance";
import containerPublicInternet from "../src/lints/static/container-public-internet";
import cronEveryMinute from "../src/lints/static/cron-every-minute";
import errorWithoutCatalog from "../src/lints/static/error-without-catalog";
import insertManyUnsafeUserData from "../src/lints/static/insert-many-unsafe-user-data";
import policyReferencesUnknownTable from "../src/lints/static/policy-references-unknown-table";
import privilegedFanoutFromPublicProcedure from "../src/lints/static/privileged-fanout-from-public-procedure";
import procedureWithoutStructuredEvent from "../src/lints/static/procedure-without-structured-event";
import publicMutationWithoutRatelimit from "../src/lints/static/public-mutation-without-ratelimit";
import queueWithoutDlq from "../src/lints/static/queue-without-dlq";
import rlsUncoveredTable from "../src/lints/static/rls-uncovered-table";
import shapeTargetsGlobalTable from "../src/lints/static/shape-targets-global-table";
import shapeUnknownTable from "../src/lints/static/shape-unknown-table";
import signupMutationWithoutDisposableGating from "../src/lints/static/signup-mutation-without-disposable-gating";
import userCreatingMutationWithoutCaptcha from "../src/lints/static/user-creating-mutation-without-captcha";
import workflowUnused from "../src/lints/static/workflow-unused";
import type { Lint } from "../src/types";

/*
 * Each declaration-level finding copies the `file` and `line` its evidence row carries
 * (recorded by codegen at the declaring statement), so a suppression can match it by location.
 * One case per lint: the row's location appears in the finding's metadata, and nothing else changes.
 */

const schema = fromServerSchema(
    defineSchema({
        channels: defineTable({ name: v.string() }),
        users: defineTable({ email: v.string() }).global(),
    }),
);

/** A fully unprotected public mutation; spread overrides vary one fact at a time. */
const procedure = (overrides: Partial<AdvisorProcedureProtection> = {}): AdvisorProcedureProtection => {
    return {
        callsMail: false,
        exportName: "signUp",
        fanOut: false,
        file: "signup",
        kind: "mutation",
        line: 12,
        unboundedAiGeneration: false,
        usesCaptcha: false,
        usesEmailGate: false,
        usesInsertManyUnsafe: false,
        usesMask: false,
        usesRateLimit: false,
        usesRls: false,
        visibility: "public",
        writesUserTable: false,
        ...overrides,
    };
};

interface Case {
    /** The context whose single row produces exactly one finding. */
    context: LintContext;
    /** The lint under test, run through its own `run`. */
    lint: Lint;
    /** The row's file and line, which the finding must carry. */
    site: { file: string; line: number };
}

const cases: ReadonlyArray<[string, Case]> = [
    [
        "action_without_error_handling",
        {
            context: {
                procedureProtections: [
                    procedure({ exportName: "notify", file: "notify", kind: "action", line: 3, handlesErrors: false, reachesOutbound: true }),
                ],
                schema,
            },
            lint: actionWithoutErrorHandling,
            site: { file: "notify", line: 3 },
        },
    ],
    [
        "ai_unbounded_generation_public",
        {
            context: {
                procedureProtections: [procedure({ exportName: "draft", file: "ai", line: 5, unboundedAiGeneration: true })],
                schema,
            },
            lint: aiUnboundedGenerationPublic,
            site: { file: "ai", line: 5 },
        },
    ],
    [
        "insert_many_unsafe_user_data",
        {
            context: {
                procedureProtections: [procedure({ exportName: "bulk", file: "bulk", line: 7, usesInsertManyUnsafe: true })],
                schema,
            },
            lint: insertManyUnsafeUserData,
            site: { file: "bulk", line: 7 },
        },
    ],
    [
        "privileged_fanout_from_public_procedure",
        {
            context: {
                procedureProtections: [procedure({ exportName: "fan", file: "fan", line: 9, fanOut: true })],
                schema,
            },
            lint: privilegedFanoutFromPublicProcedure,
            site: { file: "fan", line: 9 },
        },
    ],
    [
        "error_without_catalog",
        {
            context: {
                procedureProtections: [procedure({ exportName: "fail", file: "fail", line: 11, throwsBareError: true })],
                schema,
            },
            lint: errorWithoutCatalog,
            site: { file: "fail", line: 11 },
        },
    ],
    [
        "user_creating_mutation_without_captcha",
        {
            context: {
                procedureProtections: [procedure({ exportName: "signUp", file: "signup", line: 12, writesUserTable: true })],
                schema,
            },
            lint: userCreatingMutationWithoutCaptcha,
            site: { file: "signup", line: 12 },
        },
    ],
    [
        "public_mutation_without_ratelimit",
        {
            context: {
                procedureProtections: [procedure({ exportName: "post", file: "posts", line: 15 })],
                schema,
            },
            lint: publicMutationWithoutRatelimit,
            site: { file: "posts", line: 15 },
        },
    ],
    [
        "signup_mutation_without_disposable_gating",
        {
            context: {
                procedureProtections: [procedure({ exportName: "signUp", file: "signup", line: 12, hasEmailArg: true, writesUserTable: true })],
                schema,
            },
            lint: signupMutationWithoutDisposableGating,
            site: { file: "signup", line: 12 },
        },
    ],
    [
        "admin_route_without_guard",
        {
            context: {
                adminRoutes: [{ exportName: "purge", file: "admin", line: 4, method: "POST", path: "/admin/purge", usesGuard: false }],
                schema,
            },
            lint: adminRouteWithoutGuard,
            site: { file: "admin", line: 4 },
        },
    ],
    [
        "container_long_sleep_after",
        {
            context: {
                containers: [{ exportName: "transcoder", file: "containers", line: 6, sleepAfter: "2h" }],
                schema,
            },
            lint: containerLongSleepAfter,
            site: { file: "containers", line: 6 },
        },
    ],
    [
        "container_oversized_instance",
        {
            context: {
                containers: [{ exportName: "transcoder", file: "containers", instanceType: "standard-4", line: 6 }],
                schema,
            },
            lint: containerOversizedInstance,
            site: { file: "containers", line: 6 },
        },
    ],
    [
        "container_public_internet",
        {
            context: {
                containers: [{ exportName: "transcoder", file: "containers", line: 6 }],
                schema,
            },
            lint: containerPublicInternet,
            site: { file: "containers", line: 6 },
        },
    ],
    [
        "cron_every_minute",
        {
            context: {
                crons: [{ cron: "* * * * *", file: "crons", functionPath: "presence:sweep", line: 8, name: "sweep" }],
                schema,
            },
            lint: cronEveryMinute,
            site: { file: "crons", line: 8 },
        },
    ],
    [
        "queue_without_dlq",
        {
            context: {
                queues: [{ exportName: "notifications", filePath: "queues", line: 2, mode: "push", name: "notifications", tuning: {} }],
                schema,
            },
            lint: queueWithoutDlq,
            site: { file: "queues", line: 2 },
        },
    ],
    [
        "workflow_unused",
        {
            context: {
                workflowCalls: [],
                workflows: [{ exportName: "welcome", file: "workflows", line: 10 }],
                schema,
            },
            lint: workflowUnused,
            site: { file: "workflows", line: 10 },
        },
    ],
    [
        "shape_unknown_table",
        {
            context: {
                shapes: [{ exportName: "typo", file: "lunora/shapes.ts", line: 13, table: "message" }],
                schema,
            },
            lint: shapeUnknownTable,
            site: { file: "lunora/shapes.ts", line: 13 },
        },
    ],
    [
        "shape_targets_global_table",
        {
            context: {
                shapes: [{ exportName: "allUsers", file: "lunora/shapes.ts", line: 14, table: "users" }],
                schema,
            },
            lint: shapeTargetsGlobalTable,
            site: { file: "lunora/shapes.ts", line: 14 },
        },
    ],
    [
        "policy_references_unknown_table",
        {
            context: {
                rlsProcedures: [
                    {
                        exportName: "listDocuments",
                        file: "documents",
                        line: 16,
                        rlsTables: ["documents"],
                        tablesRead: ["documents"],
                        tablesWritten: [],
                        usesRls: true,
                        visibility: "public",
                    },
                ],
                schema,
            },
            lint: policyReferencesUnknownTable,
            site: { file: "documents", line: 16 },
        },
    ],
    [
        "ai_run_without_logging",
        {
            context: {
                procedureProtections: [
                    procedure({ emitsEvent: false, exportName: "summarize", file: "ai", line: 17, runsAiGeneration: true, visibility: "internal" }),
                ],
                schema,
            },
            lint: aiRunWithoutLogging,
            site: { file: "ai", line: 17 },
        },
    ],
    [
        "procedure_without_structured_event",
        {
            context: {
                procedureProtections: [procedure({ emitsEvent: false, exportName: "post", file: "posts", line: 18 })],
                schema,
            },
            lint: procedureWithoutStructuredEvent,
            site: { file: "posts", line: 18 },
        },
    ],
    [
        "rls_uncovered_table",
        {
            context: {
                rlsProcedures: [
                    {
                        exportName: "listDocuments",
                        file: "documents",
                        line: 16,
                        rlsTables: ["documents"],
                        tablesRead: ["documents"],
                        tablesWritten: [],
                        usesRls: true,
                        visibility: "public",
                    },
                    {
                        exportName: "dumpDocuments",
                        file: "export",
                        line: 19,
                        rlsTables: [],
                        tablesRead: ["documents"],
                        tablesWritten: [],
                        usesRls: false,
                        visibility: "public",
                    },
                ],
                schema,
            },
            lint: rlsUncoveredTable,
            site: { file: "export", line: 19 },
        },
    ],
];

describe("declaration-level findings carry their row's file and line", () => {
    it.each(cases)("%s copies the row's location into the finding's metadata", (_name, testCase) => {
        expect.assertions(2);

        const findings = testCase.lint.run(testCase.context);

        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata).toMatchObject(testCase.site);
    });
});
