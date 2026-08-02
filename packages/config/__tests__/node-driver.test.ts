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

    it("reports crons as runtime-registered rather than written to config", async () => {
        expect.assertions(2);

        const result = await driver.provision({ crons: ["0 9 * * *", "*/5 * * * *"], projectRoot: "/nonexistent-lunora-project" });

        // The one place this target does MORE than Cloudflare, which reconciles
        // `triggers.crons` into wrangler.jsonc at build time and cannot register
        // one at runtime at all.
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("SchedulerHost.cron");
    });
});
