import { describe, expect, it } from "vitest";

import { ALLOWED_COMMANDS, assertAllowedCommand, assertSafePath, capOutput, containerDriver, resolveSandbox, simulatedDriver } from "../lunora/sandbox";

/** The paths a model reaches for when it decides it wants out of the project. */
const ESCAPES = ["/etc/passwd", "../../other-project/secret.ts", "lunora/../../etc/hosts", "C:/Windows/System32/config", "..", "src/../../..//x"];

describe("assertSafePath", () => {
    it.each(ESCAPES)("refuses %s", (path) => {
        expect.assertions(1);

        expect(() => assertSafePath(path)).toThrow(/refusing/u);
    });

    it("accepts an ordinary project-relative path and normalises separators", () => {
        expect.assertions(2);

        expect(assertSafePath("lunora/schema.ts")).toBe("lunora/schema.ts");
        // A Windows-style separator is normalised rather than rejected — the
        // path is legitimate, only its spelling is not.
        expect(assertSafePath(String.raw`src\routes\index.tsx`)).toBe("src/routes/index.tsx");
    });

    it("refuses the files the toolchain owns", () => {
        expect.assertions(2);

        // Plan 335 §3.6: these are written by codegen and by the secrets flow.
        // A model that rewrites them corrupts the project in a way that looks
        // like a successful edit.
        expect(() => assertSafePath(".dev.vars")).toThrow(/toolchain/u);
        expect(() => assertSafePath("lunora/_generated/api.ts")).toThrow(/toolchain/u);
    });

    it("refuses an empty or over-long path", () => {
        expect.assertions(2);

        expect(() => assertSafePath("   ")).toThrow(/empty or over-long/u);
        expect(() => assertSafePath("a".repeat(401))).toThrow(/empty or over-long/u);
    });
});

describe("assertAllowedCommand", () => {
    it.each([...ALLOWED_COMMANDS])("allows %s", (command) => {
        expect.assertions(1);

        expect(() => {
            assertAllowedCommand(command);
        }).not.toThrow();
    });

    it.each(["bash", "sh", "curl", "rm", "python3", "node_modules/.bin/anything"])("refuses %s and names what is permitted", (command) => {
        expect.assertions(1);

        // The message matters as much as the refusal: the caller is a model, and
        // a refusal that lists the alternatives is one it can act on.
        expect(() => {
            assertAllowedCommand(command);
        }).toThrow(/not an allowed command\. Permitted: git, lunora, node, pnpm, wrangler/u);
    });
});

describe("capOutput", () => {
    it("passes short output through untouched", () => {
        expect.assertions(1);

        expect(capOutput("done")).toBe("done");
    });

    it("marks the truncation rather than silently shortening", () => {
        expect.assertions(2);

        const capped = capOutput("x".repeat(9000));

        expect(capped).toContain("… [truncated]");
        expect(capped.length).toBeLessThan(9000);
    });
});

describe("simulatedDriver", () => {
    it("reports itself as simulated", () => {
        expect.assertions(1);

        // The workbench renders this. A driver that claimed to be a container
        // would tell a user their command ran somewhere it did not.
        expect(simulatedDriver().kind).toBe("simulated");
    });

    it("fails `lunora verify` for a project with no schema", async () => {
        expect.assertions(2);

        const result = await simulatedDriver().exec("lunora", ["verify"], new Map());

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("lunora/schema.ts not found");
    });

    it("passes `lunora verify` once a schema exists", async () => {
        expect.assertions(1);

        const files = new Map([["lunora/schema.ts", ""]]);

        await expect(simulatedDriver().exec("lunora", ["verify"], files)).resolves.toStrictEqual({
            code: 0,
            stderr: "",
            stdout: "verify: project is valid (simulated)",
        });
    });

    it("rEJECTS rather than throws for a disallowed command", async () => {
        expect.assertions(1);

        // Two things at once. The allowlist is a security control, not a
        // container-only one — a simulation that accepted `bash` would train the
        // agent on a habit the real driver rejects. And the refusal must arrive
        // as a *rejection*: this driver once threw synchronously while the
        // container one rejected, so `driver.exec(...).catch(…)` caught a refusal
        // from one driver and sailed past the other.
        await expect(simulatedDriver().exec("bash", ["-c", "echo hi"], new Map())).rejects.toThrow(/not an allowed command/u);
    });
});

describe("driver parity", () => {
    it("both drivers refuse the same command the same way", async () => {
        expect.assertions(2);

        const accessor = {
            get: () => {
                return {
                    exec: async () => {
                        return { code: 0, stderr: "", stdout: "" };
                    },
                };
            },
        };

        // The guard is the drivers' shared contract; if one enforces it and the
        // other does not, the simulation is teaching the agent the wrong rules.
        await expect(simulatedDriver().exec("curl", [], new Map())).rejects.toThrow(/not an allowed command/u);
        await expect(containerDriver(accessor, "p1").exec("curl", [], new Map())).rejects.toThrow(/not an allowed command/u);
    });
});

describe("containerDriver", () => {
    it("forwards the command to ctx.containers.<name>.exec and reports itself as a container", async () => {
        expect.assertions(3);

        const calls: { args?: ReadonlyArray<string>; command: string }[] = [];
        const accessor = {
            get: () => {
                return {
                    exec: async (command: string, options?: { args?: ReadonlyArray<string> }) => {
                        calls.push({ args: options?.args, command });

                        return { code: 0, stderr: "", stdout: "ok" };
                    },
                };
            },
        };

        const driver = containerDriver(accessor, "project-1");
        const result = await driver.exec("pnpm", ["install"], new Map());

        expect(driver.kind).toBe("container");
        expect(calls[0]).toStrictEqual({ args: ["install"], command: "pnpm" });
        expect(result.stdout).toBe("ok");
    });
});

describe("resolveSandbox", () => {
    it("falls back to the simulation when no container binding exists", () => {
        expect.assertions(2);

        // The fallback is deliberate — without it the app cannot start locally —
        // but it must be visible, which is what `kind` is for.
        expect(resolveSandbox(undefined, "p1").kind).toBe("simulated");
        expect(resolveSandbox({}, "p1").kind).toBe("simulated");
    });

    it("uses the container driver when the binding is present", () => {
        expect.assertions(1);

        const accessor = {
            get: () => {
                return {
                    exec: async () => {
                        return { code: 0, stderr: "", stdout: "" };
                    },
                };
            },
        };

        expect(resolveSandbox({ sandbox: accessor }, "p1").kind).toBe("container");
    });
});
