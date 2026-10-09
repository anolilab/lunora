import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli";
import { execute } from "../../src/commands/cloudflare/handler";
import type { CloudflareOptions } from "../../src/commands/cloudflare/index";
import { CLOUDFLARE_TOOLS } from "../../src/commands/cloudflare/index";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { SpawnDescriptor } from "../../src/util/spawn";
import { runExecute } from "../helpers/execute";

/** Every spawn the CLI attempts; none reaches a real process. */
const spawned = vi.hoisted((): SpawnDescriptor[] => []);

vi.mock(import("../../src/util/spawn"), async (importOriginal) => {
    return {
        ...(await importOriginal()),
        defaultSpawner: async (descriptor: SpawnDescriptor) => {
            spawned.push(descriptor);

            return { code: 0 };
        },
    };
});

const WRANGLER = `{ "name": "demo-app" }\n`;

describe("lunora cloudflare", () => {
    let cwd: string;

    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "lunora-cloudflare-group-"));
        // npm, so a forwarded command reads `npx -- wrangler …` whatever the host repo uses.
        writeFileSync(join(cwd, "package.json"), `{ "packageManager": "npm@10.9.0" }\n`, "utf8");
        writeFileSync(join(cwd, "wrangler.jsonc"), WRANGLER, "utf8");
        spawned.length = 0;
    });

    afterEach(() => {
        rmSync(cwd, { force: true, recursive: true });
    });

    const setTarget = (target: string): void => {
        writeFileSync(join(cwd, "lunora.config.ts"), `export default { target: "${target}" };\n`, "utf8");
    };

    /** Run the real CLI in `cwd` with a capturing logger. */
    const cli = async (argv: string[]): Promise<{ code: number; output: string }> => {
        const lines: string[] = [];
        const push = (...values: unknown[]): void => {
            lines.push(values.map(String).join(" "));
        };
        const code = await runCli({ argv, cwd, logger: { debug: push, error: push, info: push, log: push, warn: push } as unknown as Console });

        return { code, output: lines.join("\n") };
    };

    /** The wrangler argv of each spawn, after the `npx --` prefix. */
    const wranglerCalls = (): string[] => spawned.map((descriptor) => descriptor.args.join(" ").replace(/^-- /u, ""));

    describe("help", () => {
        it("lists every tool with its arguments when run without one, and exits 0", async () => {
            expect.assertions(3);

            const { code, output } = await cli(["cloudflare"]);

            expect(code).toBe(0);
            expect(CLOUDFLARE_TOOLS.filter((tool) => !output.includes(`  ${tool.name}  `)).map((tool) => tool.name)).toStrictEqual([]);
            expect(output).toContain("lunora cloudflare containers <build|push|images|list|info|delete> [args…]");
        });

        it.each([
            ["cloudflare", "--help"],
            ["cloudflare", "containers", "list", "--help"],
        ])("`lunora %s` names every tool", async (...argv) => {
            expect.assertions(2);

            const { code, output } = await cli(argv);

            expect(code).toBe(0);
            expect(CLOUDFLARE_TOOLS.filter((tool) => !output.includes(`lunora cloudflare ${tool.name}`)).map((tool) => tool.name)).toStrictEqual([]);
        });

        it("refuses an unknown tool, listing the real ones", async () => {
            expect.assertions(3);

            const { code, output } = await cli(["cloudflare", "budget"]);

            expect(code).toBe(EXIT_CODE.USAGE);
            expect(output).toContain('cloudflare: unknown tool "budget" — expected alerts | ai-gateway | analyze | containers | deployments');
            expect(spawned).toHaveLength(0);
        });
    });

    describe("dispatch", () => {
        it("forwards a containers subcommand with its own positionals and flags", async () => {
            expect.assertions(2);

            const { code } = await cli(["cloudflare", "containers", "images", "delete", "transcoder:v1", "--env", "staging"]);

            expect(code).toBe(0);
            expect(wranglerCalls()).toStrictEqual(["wrangler containers images delete transcoder:v1 --env staging"]);
        });

        it("forwards a deployments subcommand with its version id and flags", async () => {
            expect.assertions(2);

            const { code } = await cli(["cloudflare", "deployments", "rollback", "v42", "--yes", "--message", "bad", "--env", "staging"]);

            expect(code).toBe(0);
            expect(wranglerCalls()).toStrictEqual(["wrangler rollback --env staging v42 --yes --message bad"]);
        });

        it("adds no envelope after `deployments list --format json`, whose document is wrangler's", async () => {
            expect.assertions(3);

            const { code, stdout } = await runExecute<CloudflareOptions>(execute, {
                argument: ["deployments", "list"],
                commandName: "cloudflare",
                cwd,
                options: { format: "json" },
            });

            expect(code).toBe(0);
            expect(wranglerCalls()).toStrictEqual(["wrangler deployments list --json"]);
            expect(stdout).toBe("");
        });

        it("hands analyze's report to the --format json envelope", async () => {
            expect.assertions(2);

            const { code, document } = await runExecute<CloudflareOptions, { totalFiles: number }>(execute, {
                argument: ["analyze"],
                commandName: "cloudflare",
                cwd,
                options: { format: "json" },
            });

            expect(code).toBe(0);
            // The mocked dry-run writes nothing, so the report covers an empty outdir.
            expect(document?.data?.totalFiles).toBe(0);
        });

        it("refuses an unknown deployments subcommand without spawning", async () => {
            expect.assertions(3);

            const { code, output } = await cli(["cloudflare", "deployments", "nuke"]);

            expect(code).toBe(EXIT_CODE.USAGE);
            expect(output).toContain('cloudflare deployments: unknown subcommand "nuke"');
            expect(spawned).toHaveLength(0);
        });

        it("runs analyze through a wrangler dry-run", async () => {
            expect.assertions(2);

            const { code } = await cli(["cloudflare", "analyze"]);

            expect(code).toBe(0);
            expect(wranglerCalls()[0]).toMatch(/^wrangler deploy --dry-run --outdir /u);
        });

        it("runs ai-gateway with its flags", async () => {
            expect.assertions(3);

            const { code, output } = await cli(["cloudflare", "ai-gateway", "--dry-run", "--id", "my-gateway", "--no-logs"]);

            expect(code).toBe(0);
            expect(output).toContain('would create or reuse AI Gateway "my-gateway" (log collection off)');
            // A dry run edits nothing.
            expect(readFileSync(join(cwd, "wrangler.jsonc"), "utf8")).toBe(WRANGLER);
        });
    });

    describe("on a project that does not deploy to Cloudflare", () => {
        const invocations = ["alerts", "ai-gateway --dry-run", "analyze", "containers list", "deployments list"];
        const hosts = [
            ["celld", "celld"],
            ["node", "Node"],
        ];

        it.each(hosts.flatMap(([target, host]) => invocations.map((line) => [line, target, host])))(
            "`lunora cloudflare %s` refuses a %s project from lunora.config, naming the host, and runs nothing",
            async (line, target, host) => {
                expect.assertions(4);

                setTarget(String(target));

                const [tool = "", ...rest] = String(line).split(" ");
                const { code, output } = await cli(["cloudflare", tool, ...rest]);

                expect(code).toBe(EXIT_CODE.USAGE);
                expect(output).toContain(`this project deploys to ${String(host)} — \`lunora cloudflare ${tool}\` only applies to Cloudflare.`);
                // ai-gateway's dry run would have printed its plan.
                expect(output).not.toContain("would create");
                expect(spawned).toHaveLength(0);
            },
        );

        it("refuses on --target alone, and --target cloudflare overrides lunora.config", async () => {
            expect.assertions(4);

            const flagged = await cli(["cloudflare", "containers", "list", "--target", "celld"]);

            expect(flagged.code).toBe(EXIT_CODE.USAGE);
            expect(spawned).toHaveLength(0);

            setTarget("celld");

            const overridden = await cli(["cloudflare", "containers", "list", "--target", "cloudflare"]);

            expect(overridden.code).toBe(0);
            expect(wranglerCalls()).toStrictEqual(["wrangler containers list"]);
        });

        it("refuses an unknown --target", async () => {
            expect.assertions(3);

            const { code, output } = await cli(["cloudflare", "deployments", "list", "--target", "aws"]);

            expect(code).toBe(EXIT_CODE.USAGE);
            expect(output).toContain("aws");
            expect(spawned).toHaveLength(0);
        });
    });

    describe("the old top-level names", () => {
        it.each([
            ["containers list --format json", "containers", "cloudflare containers", "lunora cloudflare containers list --format json"],
            ["deployments rollback --yes", "deployments", "cloudflare deployments", "lunora cloudflare deployments rollback --yes"],
            ["ai gateway --dry-run", "ai gateway", "cloudflare ai-gateway", "lunora cloudflare ai-gateway --dry-run"],
            ["analyze", "analyze", "cloudflare analyze", "lunora cloudflare analyze"],
            ["alerts setup --email ops@example.com", "alerts", "cloudflare alerts", "lunora cloudflare alerts setup --email ops@example.com"],
        ])("`lunora %s` fails, says where it moved, and runs nothing", async (line, old, moved, suggested) => {
            expect.assertions(4);

            const { code, output } = await cli(line.split(" "));

            expect(code).toBe(EXIT_CODE.USAGE);
            expect(output).toContain(`\`lunora ${old}\` moved to \`lunora ${moved}\`. Run: ${suggested}`);
            expect(output).not.toContain("Did you mean");
            expect(spawned).toHaveLength(0);
        });
    });
});
