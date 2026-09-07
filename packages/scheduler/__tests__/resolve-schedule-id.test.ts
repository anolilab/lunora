/**
 * A schedule id is not just a storage key: `handleSchedulerDispatch` hands it to
 * `WorkflowBinding.create({ id })` verbatim, and Cloudflare Workflows validates
 * instance ids against `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` (length first, ceiling 100).
 * An id that fails it is a hard, non-duplicate `create` rejection — which the
 * scheduler retries five times and then parks under `dead:`. So both halves of
 * this function have to answer to that grammar: what it MINTS and what it ACCEPTS.
 */
import { describe, expect, it } from "vitest";

import resolveScheduleId from "../src/resolve-schedule-id";

/** The engine's own instance-id grammar (see `@lunora/workflow`'s `boundInstanceId`). */
const CLOUDFLARE_INSTANCE_ID = /^\w[\w-]*$/u;

describe("resolveScheduleId", () => {
    it("mints only ids Cloudflare Workflows accepts as an instance id", () => {
        expect.assertions(2);

        const rejected: string[] = [];

        for (let index = 0; index < 20_000; index += 1) {
            const id = resolveScheduleId(undefined);

            if (!CLOUDFLARE_INSTANCE_ID.test(id) || id.length > 100) {
                rejected.push(id);
            }
        }

        // base64url's index 62 is `-`, so 1 in 64 minted ids used to lead with one.
        expect(rejected).toStrictEqual([]);
        // Still a key segment: no `:`, which would corrupt the `t:<padded>:<id>` index.
        expect(resolveScheduleId(undefined)).not.toContain(":");
    });

    it("refuses a caller id Cloudflare would reject instead of replacing it", () => {
        expect.assertions(2);

        // `id` is not an idempotency key — a duplicate is a 409 — so minting over
        // an invalid one made two calls with the same id run the job twice.
        expect(() => resolveScheduleId("-leading-dash")).toThrow("must not start with `-`");
        // `_` IS a legal leading character — only `-` is not.
        expect(resolveScheduleId("_leading-underscore")).toBe("_leading-underscore");
    });

    it("keeps a caller id that is already a safe key segment", () => {
        expect.assertions(3);

        expect(resolveScheduleId("job_42")).toBe("job_42");
        expect(resolveScheduleId("a".repeat(64))).toBe("a".repeat(64));
        expect(() => resolveScheduleId("a".repeat(65))).toThrow("must be 1-64 characters");
    });

    it("refuses a caller id that is not a usable string", () => {
        expect.assertions(3);

        expect(() => resolveScheduleId("with:colon")).toThrow("must be 1-64 characters");
        expect(() => resolveScheduleId("")).toThrow("must be 1-64 characters");
        expect(() => resolveScheduleId(42)).toThrow("must be 1-64 characters");
    });
});
