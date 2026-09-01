import { describe, expect, it } from "vitest";

import { resolveDeployDriver } from "../src/driver-registry";

/**
 * The Node driver's job is not to write configuration — it has none to write —
 * but to say plainly, at provision time, which of the app's declared
 * requirements this target cannot serve. That report is the whole feature: the
 * alternative is finding out when `ctx.queues` is `undefined` at runtime.
 */
describe("node deploy driver", () => {
    const driver = resolveDeployDriver("node");

    it("is selectable and identifies itself", () => {
        expect.assertions(2);

        expect(driver.id).toBe("node");
        expect(driver.name).toBe("Node");
    });

    it("declares no toolchain, because Node has no vendor CLI to shell out to", () => {
        expect.assertions(1);

        // `DriverToolchain` describes commands like `wrangler deploy` / `tail` /
        // `secret put`. There is no hosted control plane, log stream or remote
        // secret store here, so claiming a toolchain would mean inventing
        // commands that cannot run.
        expect(driver.toolchain).toBeUndefined();
    });

    it("never reports a write, because this target has no configuration file", async () => {
        expect.assertions(3);

        const result = await driver.provision({ projectRoot: "/nonexistent-lunora-project" });

        // Idempotent by construction rather than by diffing: there is nothing
        // to reconcile, so `changed` can only ever be false.
        expect(result.changed).toBe(false);
        expect(result.added).toStrictEqual([]);
        // An app declaring nothing has nothing this target cannot serve.
        expect(result.warnings).toStrictEqual([]);
    });

    it("reports declared crons as undispatched, not as runtime-registered", async () => {
        expect.assertions(4);

        const result = await driver.provision({ crons: ["0 9 * * *", "*/5 * * * *"], projectRoot: "/nonexistent-lunora-project" });

        // Regression: this warning used to read "will be registered at runtime
        // via SchedulerHost.cron", which is a promise nothing keeps. Node's
        // `SchedulerHost.cron` is implemented and the conformance suite is its
        // only caller — no runtime walks the generated LUNORA_CRONS map into it,
        // and the only cron dispatch that ships is @lunora/runtime's, reached
        // from Cloudflare's `scheduled()` handler. An operator reading the old
        // line shipped an app whose crons silently never fired.
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("NOTHING dispatches them");
        expect(result.warnings[0]).not.toMatch(/will be registered/);
        // Still says where the work can go instead of just refusing.
        expect(result.warnings[0]).toContain("ctx.scheduler.runAfter");
    });
});
