/**
 * Phase 7 verification gate: the playground project — our exemplar app —
 * stays loadable end-to-end by the rest of the toolchain.
 *
 * If a refactor in `lunora-codegen` or `lunora-config` breaks the playground,
 * we catch it here instead of on a deploy. We deliberately don't boot Vite or
 * `wrangler dev` (slow, flaky inside the workspace) — we compose-check the
 * same pieces a real `lunora dev` would run:
 *
 *   1. `runCodegen`               → parses schema + functions under `lunora/`
 *   2. `validateWranglerProject`  → asserts bindings line up with the schema
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCodegen } from "@lunora/codegen";
import { validateWranglerProject } from "@lunora/config/cloudflare";
import { describe, expect, it } from "vitest";

const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = join(testDirectory, "..");

describe("playground compose smoke (Phase 7)", () => {
    it("runCodegen parses schema + functions and emits the _generated triad", () => {
        expect.assertions(7);

        const result = runCodegen({ projectRoot });

        expect(existsSync(join(result.outputDirectory, "dataModel.ts"))).toBe(true);
        expect(existsSync(join(result.outputDirectory, "api.ts"))).toBe(true);
        expect(existsSync(join(result.outputDirectory, "server.ts"))).toBe(true);

        expect(result.generated.dataModel).toContain("messages");
        expect(result.generated.dataModel).toContain("channels");
        expect(result.generated.dataModel).toContain("users");
        expect(result.generated.api).toContain("messages");
    });

    it("keeps the inbound-email sink off the public api", () => {
        expect.assertions(3);

        // `inbound:onEmail` is reached by the worker's `email()` export over the
        // root shard's ADMIN RPC, behind a DMARC/SPF/DKIM `verify` gate that only
        // the mail path crosses. Registered as a plain `mutation` it was ALSO on
        // the public `api`, so any signed-in client could call it directly with a
        // freely chosen `from` — the forged-sender case the gate exists to stop,
        // reached by walking around the gate instead of through it.
        //
        // `internalMutation` is the sibling pattern (`cleanup.ts`), and the mail
        // dispatcher already sends `x-lunora-system: 1`, which is exactly what
        // lets an internal target answer a server-initiated dispatch.
        const { api } = runCodegen({ projectRoot }).generated;
        const internalAt = api.indexOf("export interface InternalApiTypes");

        expect(internalAt).toBeGreaterThan(-1);
        // Not in the public `ApiTypes` block…
        expect(api.slice(0, internalAt)).not.toContain("onEmail");
        // …and present in the internal one.
        expect(api.slice(internalAt)).toContain("onEmail");
    });

    it("validateWranglerProject finds no problems for the shipped wrangler.jsonc", () => {
        expect.assertions(3);

        const result = validateWranglerProject({ projectRoot });

        expect(result.wranglerPath).toBeDefined();
        expect(result.problems).toEqual([]);
        expect(result.report.valid).toBe(true);
    });

    it("wrangler.jsonc declares the bindings the schema requires", () => {
        expect.assertions(7);

        const wranglerPath = join(projectRoot, "wrangler.jsonc");
        const text = readFileSync(wranglerPath, "utf8");

        // SHARD DO for shard-local tables (`messages`)
        expect(text).toContain('"SHARD"');
        expect(text).toContain("ShardDO");
        // SCHEDULER DO for `lunora-scheduler`
        expect(text).toContain('"SCHEDULER"');
        expect(text).toContain("SchedulerDO");
        // D1 binding for `.global()` tables (`users`, `channels`)
        expect(text).toContain("d1_databases");
        // R2 binding used by the avatar upload mutation
        expect(text).toContain("r2_buckets");
        expect(text).toContain("FILES");
    });

    /*
     * A source assertion, not a behavioural one, and deliberately so: the worker
     * entry builds its app (and its Durable Object classes) at module scope, so
     * importing it under the node pool hangs — exercising `handleStorageAsset`
     * for real needs the workers pool, which this app does not run. The guard it
     * pins is one comparison, and the regression it guards against is precisely
     * someone re-adding a condition in front of it, which a text assertion does
     * see.
     */
    it("re-checks the signed content-type on every PUT, not only when one was pinned", () => {
        expect.assertions(2);

        const text = readFileSync(join(projectRoot, "src/server/index.ts"), "utf8");

        // An unconditional compare. Guarding it with `verdict.contentType !== undefined`
        // hands the choice back to the uploader whenever the URL carries no pin —
        // and the GET branch below serves whatever was stored back from this
        // origin, so a `text/html` body becomes stored XSS.
        expect(text).toContain("if (contentType !== verdict.contentType) {");
        expect(text).not.toContain("verdict.contentType !== undefined");
    });

    /* Source assertion for the same reason as the one above — the worker entry
     * is not importable under this pool. */
    it("does not claim a Durable Object reset it cannot perform", () => {
        expect.assertions(2);

        const text = readFileSync(join(projectRoot, "src/server/index.ts"), "utf8");

        // `/test/reset` used to POST `https://do/internal/reset` at a DO named
        // `__e2e_reset__`, inside a swallowing `catch`. `ShardDO.fetch` answers
        // 404 to anything but `/rpc` and its WS/relay routes, and that name is
        // neither `__root__` nor any channel shard — so even a real route would
        // have reset the wrong DO. A best-effort call to a route that does not
        // exist is worse than no call: the e2e fixtures and the `workers: 1`
        // argument were both written as if DO state were being cleared.
        //
        // Matched on the QUOTED forms, so the handler's own docblock — which
        // names the deleted route in prose to explain why it is gone — does not
        // trip the check that the CALL is absent.
        expect(text).not.toContain('"https://do/internal/reset"');
        expect(text).not.toContain('idFromName("__e2e_reset__")');
    });
});
