import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DevCommandOptions } from "../../src/commands/dev";
import { planDevCommand, runDevCommand } from "../../src/commands/dev";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): Logger => {
    return {
        error: () => {},
        info: () => {},
        success: () => {},
        warn: () => {},
    };
};

let workdir: string;

describe("cirrus dev", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-dev-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("planDevCommand", () => {
        it("plans a single `wrangler dev` child — never Vite", () => {
            expect.assertions(5);

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger() });

            expect(plan.wrangler.tag).toBe("wrangler");
            expect(plan.wrangler.args.join(" ")).toContain("wrangler");
            expect(plan.wrangler.args.join(" ")).toContain("dev");
            expect(plan.wrangler.args.join(" ")).not.toContain("vite");
            expect(plan.studioEnabled).toBe(true);
        });

        it("defaults the worker to :8787 and the studio to :6173", () => {
            expect.assertions(3);

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger() });

            expect(plan.workerPort).toBe(8787);
            expect(plan.workerOrigin).toBe("http://localhost:8787");
            expect(plan.studioPort).toBe(6173);
        });

        it("routes the worker port into wrangler --port and the worker origin", () => {
            expect.assertions(3);

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger(), port: 7000, workerPort: 9999 });

            expect(plan.wrangler.args).toContain("9999");
            expect(plan.workerOrigin).toBe("http://localhost:9999");
            expect(plan.studioPort).toBe(7000);
        });

        it("reflects the --no-studio / --no-codegen toggles", () => {
            expect.assertions(2);

            const plan = planDevCommand({ codegen: false, cwd: workdir, studio: false, logger: silentLogger() });

            expect(plan.studioEnabled).toBe(false);
            expect(plan.codegenEnabled).toBe(false);
        });
    });

    describe("runDevCommand", () => {
        it("spawns the wrangler worker, starts studio + codegen, and tears them down on exit", async () => {
            expect.assertions(6);

            let codegenClosed = false;
            let studioClosed = false;
            const startWorker: NonNullable<DevCommandOptions["startWorker"]> = (descriptor) => {
                // Assert we were handed the wrangler descriptor, then exit cleanly.
                expect(descriptor.args.join(" ")).toContain("wrangler");
                expect(descriptor.args.join(" ")).toContain("dev");

                return { exited: Promise.resolve(0), kill: () => {} };
            };

            const result = await runDevCommand({
                cwd: workdir,
                logger: silentLogger(),
                startCodegen: () => {
                    return {
                        close: () => {
                            codegenClosed = true;
                        },
                    };
                },
                startStudio: async () => {
                    return {
                        close: async () => {
                            studioClosed = true;
                        },
                        url: "http://127.0.0.1:6173",
                    };
                },
                startWorker,
            });

            expect(result.code).toBe(0);
            // Siblings started and were torn down when the worker exited.
            expect(codegenClosed).toBe(true);
            expect(studioClosed).toBe(true);
            expect(result.plan.workerOrigin).toBe("http://localhost:8787");
        });
    });
});
