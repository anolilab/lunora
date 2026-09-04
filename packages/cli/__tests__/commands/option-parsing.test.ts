import type { OptionDefinition } from "@visulima/cerebro";
import { Cerebro } from "@visulima/cerebro";
import { describe, expect, it } from "vitest";

import { advisorCommand } from "../../src/commands/advisor";
import { buildCommand } from "../../src/commands/build";
import { codegenCommand } from "../../src/commands/codegen";
import { deployCommand } from "../../src/commands/deploy";
import { devCommand } from "../../src/commands/dev";
import { prepareCommand } from "../../src/commands/prepare";
import { verifyCommand } from "../../src/commands/verify";

/**
 * Guards the option-name → parsed-key mapping that each handler relies on. The
 * declared option `name` and the key cerebro hands the handler at runtime are NOT
 * always the same string — hyphenated names camelCase (`worker-port` →
 * `workerPort`), and `no-*` flags arrive under the *negated positive* key
 * (`no-studio` → `studio: false`). A handler that reads the wrong key silently
 * ignores the flag (this happened: `--no-studio`/`--no-typecheck` were dead).
 *
 * Rather than re-run a whole command (which spawns wrangler/tsc), we feed the
 * command's real `options` array into a throwaway cerebro with a capturing stub
 * and assert the parsed shape the handler destructures.
 */
const parseOptions = async (commandName: string, options: ReadonlyArray<OptionDefinition<unknown>>, argv: string[]): Promise<Record<string, unknown>> => {
    let captured: Record<string, unknown> = {};
    const cli = new Cerebro("lunora", { argv });

    cli.addCommand({
        execute: ({ options: parsed }) => {
            captured = parsed;
        },
        name: commandName,
        options: [...options],
    });

    await cli.run({ shouldExitProcess: false });

    return captured;
};

describe("command option parsing → handler key mapping", () => {
    it("`dev --no-studio --no-codegen` parses to the negated `studio`/`codegen` keys the handler reads", async () => {
        expect.assertions(2);

        const parsed = await parseOptions("dev", devCommand.options ?? [], ["dev", "--no-studio", "--no-codegen"]);

        // dev/handler.ts reads `options.studio === false` / `options.codegen === false`.
        expect(parsed.studio).toBe(false);
        expect(parsed.codegen).toBe(false);
    });

    it("`dev` (no flags) leaves studio/codegen enabled (default true)", async () => {
        expect.assertions(2);

        const parsed = await parseOptions("dev", devCommand.options ?? [], ["dev"]);

        // Absent `--no-*` → the positive key defaults true → handler treats as enabled.
        expect(parsed.studio).not.toBe(false);
        expect(parsed.codegen).not.toBe(false);
    });

    it("`dev --worker-port 9000` camelCases to `workerPort`", async () => {
        expect.assertions(1);

        const parsed = await parseOptions("dev", devCommand.options ?? [], ["dev", "--worker-port", "9000"]);

        // dev/handler.ts reads `options.workerPort`.
        expect(parsed.workerPort).toBe(9000);
    });

    it("`verify --no-typecheck` parses to the negated `typecheck` key the handler reads", async () => {
        expect.assertions(1);

        const parsed = await parseOptions("verify", verifyCommand.options ?? [], ["verify", "--no-typecheck"]);

        // verify/handler.ts reads `options.typecheck === false`.
        expect(parsed.typecheck).toBe(false);
    });

    // Issue #285 (1+2): `lunora codegen --help` documents the gate as "defaults to
    // on in CI, off locally". That is only true when `options.strictAdvisories` is
    // `undefined` with no flag passed, so `resolveStrictAdvisories`'s CI-vs-local
    // `??` fallback ever runs. Declaring only `no-strict-advisories` and letting
    // cerebro synthesize `--strict-advisories` gives the synthesized option an
    // unconditional `defaultValue: true`, so `strictAdvisories` was NEVER
    // `undefined` — the gate was strict locally regardless of `--help`'s claim.
    it.each([
        ["build", buildCommand],
        ["codegen", codegenCommand],
        ["deploy", deployCommand],
        ["prepare", prepareCommand],
        ["verify", verifyCommand],
    ])("`%s` (no flags) leaves strictAdvisories undefined so the CI-vs-local default can apply", async (name, command) => {
        expect.assertions(1);

        const parsed = await parseOptions(name, command.options ?? [], [name]);

        expect(parsed.strictAdvisories).toBeUndefined();
    });

    it.each([
        ["build", buildCommand],
        ["codegen", codegenCommand],
        ["deploy", deployCommand],
        ["prepare", prepareCommand],
        ["verify", verifyCommand],
    ])("`%s --strict-advisories` parses to strictAdvisories: true", async (name, command) => {
        expect.assertions(1);

        const parsed = await parseOptions(name, command.options ?? [], [name, "--strict-advisories"]);

        expect(parsed.strictAdvisories).toBe(true);
    });

    it.each([
        ["build", buildCommand],
        ["codegen", codegenCommand],
        ["deploy", deployCommand],
        ["prepare", prepareCommand],
        ["verify", verifyCommand],
    ])("`%s --no-strict-advisories` parses to strictAdvisories: false", async (name, command) => {
        expect.assertions(1);

        const parsed = await parseOptions(name, command.options ?? [], [name, "--no-strict-advisories"]);

        expect(parsed.strictAdvisories).toBe(false);
    });

    // Issue #285 (3): `lunora advisor --help` documents `--no-write`, but the
    // option was declared as the POSITIVE `write` flag — cerebro only synthesizes
    // a `no-*` counterpart for an option it declared, so `--no-write` was rejected
    // as an unknown option.
    it("`advisor --no-write` parses instead of throwing an unknown-option error", async () => {
        expect.assertions(1);

        const parsed = await parseOptions("advisor", advisorCommand.options ?? [], ["advisor", "--no-write"]);

        expect(parsed.write).toBe(false);
    });

    it("`advisor` (no flags) leaves write enabled (default true)", async () => {
        expect.assertions(1);

        const parsed = await parseOptions("advisor", advisorCommand.options ?? [], ["advisor"]);

        expect(parsed.write).not.toBe(false);
    });

    it("`advisor --write` still parses to write: true", async () => {
        expect.assertions(1);

        const parsed = await parseOptions("advisor", advisorCommand.options ?? [], ["advisor", "--write"]);

        expect(parsed.write).toBe(true);
    });
});
