import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { EvalData } from "../../src/commands/eval/handler";
import { execute, runEvalCommand } from "../../src/commands/eval/handler";
import type { EvalOptions } from "../../src/commands/eval/index";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";
import { runExecute } from "../helpers/execute";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "fixtures");

interface Recorded {
    errors: string[];
    infos: string[];
    successes: string[];
    warnings: string[];
}

const recordingLogger = (): { logger: Logger; recorded: Recorded } => {
    const recorded: Recorded = { errors: [], infos: [], successes: [], warnings: [] };

    return {
        logger: {
            error: (message) => recorded.errors.push(message),
            info: (message) => recorded.infos.push(message),
            success: (message) => recorded.successes.push(message),
            warn: (message) => recorded.warnings.push(message),
        },
        recorded,
    };
};

describe("lunora eval", () => {
    it("discovers and runs a fixture *.eval.ts, printing the aggregate table, and exits 0 on a clean run", async () => {
        expect.assertions(6);

        const { logger, recorded } = recordingLogger();
        const cwd = join(fixtureRoot, "eval-sample");

        const result = await runEvalCommand({ cwd, logger });

        expect(result.code).toBe(0);
        expect(result.evals).toHaveLength(1);
        expect(result.evals[0]?.name).toBe("support-triage");
        expect(result.evals[0]?.result?.average).toBe(1);
        expect(result.evals[0]?.passed).toBe(true);
        // The aggregate table names the eval and its score.
        expect(recorded.infos.some((line) => line.includes("support-triage") && line.includes("1.000"))).toBe(true);
    });

    it("reuses `evaluate` from @lunora/testing unchanged — the runner adds no scoring logic of its own", async () => {
        expect.assertions(2);

        const { logger } = recordingLogger();
        const cwd = join(fixtureRoot, "eval-sample");

        const result = await runEvalCommand({ cwd, logger });
        const [outcome] = result.evals;

        // The per-case breakdown is `evaluate`'s own `EvalItemResult[]`, passed
        // through verbatim — two cases in, two cases out, each with its own score.
        expect(outcome?.result?.items).toHaveLength(2);
        expect(outcome?.result?.items.every((item) => item.average === 1)).toBe(true);
    });

    it("exits 0 when no evals directory exists — a project with no evals yet is a no-op, not an error", async () => {
        expect.assertions(2);

        const { logger } = recordingLogger();
        // `fixtureRoot` itself has no `evals/` child (only the per-scenario
        // subdirectories above do) — exercises the "nothing to run yet" path.
        const result = await runEvalCommand({ cwd: fixtureRoot, logger });

        expect(result.code).toBe(0);
        expect(result.evals).toHaveLength(0);
    });

    it("--threshold gates the exit code: below the average fails, at/under it passes", async () => {
        expect.assertions(4);

        const { logger: failLogger } = recordingLogger();
        const cwd = join(fixtureRoot, "eval-threshold-sample");

        const failing = await runEvalCommand({ cwd, logger: failLogger, threshold: 0.6 });

        expect(failing.code).toBe(1);
        expect(failing.evals[0]?.passed).toBe(false);

        const { logger: passLogger } = recordingLogger();
        const passing = await runEvalCommand({ cwd, logger: passLogger, threshold: 0.4 });

        expect(passing.code).toBe(0);
        expect(passing.evals[0]?.passed).toBe(true);
    });

    it("a per-eval `threshold` export overrides a stricter global --threshold for that eval", async () => {
        expect.assertions(2);

        const { logger } = recordingLogger();
        const cwd = join(fixtureRoot, "eval-override-sample");

        // The eval's own average is 0.5 and its export sets `threshold: 0.4`; a
        // much stricter global 0.9 would fail it if the override didn't win.
        const result = await runEvalCommand({ cwd, logger, threshold: 0.9 });

        expect(result.code).toBe(0);
        expect(result.evals[0]?.threshold).toBe(0.4);
    });

    it("a NaN per-eval `threshold` export fails that eval only, without ever running it", async () => {
        expect.assertions(4);

        const { logger } = recordingLogger();
        const cwd = join(fixtureRoot, "eval-bad-threshold-sample");

        const result = await runEvalCommand({ cwd, logger });
        const outcome = result.evals.find((entry) => entry.name === "nan-threshold");

        expect(result.code).toBe(1);
        expect(outcome?.passed).toBe(false);
        expect(outcome?.error).toContain("threshold");
        expect(outcome?.error).toContain("[0, 1]");
    });

    it("an out-of-range per-eval `threshold` export fails that eval only, without ever running it", async () => {
        expect.assertions(5);

        const { logger } = recordingLogger();
        const cwd = join(fixtureRoot, "eval-bad-threshold-sample");

        const result = await runEvalCommand({ cwd, logger });
        const outcome = result.evals.find((entry) => entry.name === "out-of-range");

        expect(result.code).toBe(1);
        expect(outcome?.passed).toBe(false);
        expect(outcome?.error).toContain("threshold");
        expect(outcome?.error).toContain("[0, 1]");
        // `run` was never invoked to produce a judged result for either bad-threshold eval.
        expect(result.evals.every((entry) => entry.result === undefined)).toBe(true);
    });

    it("a crashed eval always fails the run, independent of --threshold", async () => {
        expect.assertions(3);

        const { logger, recorded } = recordingLogger();
        const cwd = join(fixtureRoot, "eval-crash-sample");

        const result = await runEvalCommand({ cwd, logger });

        expect(result.code).toBe(1);
        expect(result.evals[0]?.error).toContain("boom");
        expect(recorded.errors.some((line) => line.includes("1/1"))).toBe(true);
    });

    // Through `execute`, the only path that writes the envelope: `runEvalCommand`
    // hands back the outcomes and `defineHandler` serializes them.
    it("--format json prints one structured document to stdout, flat per the documented per-eval shape", async () => {
        expect.assertions(6);

        const cwd = join(fixtureRoot, "eval-sample");
        const { code, document } = await runExecute<EvalOptions, EvalData>(execute, { commandName: "eval", cwd, options: { format: "json" } });

        expect(code).toBe(0);
        expect(document?.code).toBe(0);
        expect(document?.data?.evals).toHaveLength(1);
        // Flat per the documented contract (`plans/245-eval-runner-design.md`
        // §4/§6): `evals[].average`, not `evals[].result.average`.
        expect(document?.data?.evals[0]?.average).toBe(1);
        expect(document?.data?.evals[0]?.name).toBe("support-triage");
        expect(document?.data?.evals[0]?.passed).toBe(true);
    });

    it("rejects a NaN --threshold before discovering anything", async () => {
        expect.assertions(2);

        const { logger, recorded } = recordingLogger();
        const cwd = join(fixtureRoot, "eval-sample");

        // Mirrors Cerebro parsing `--threshold abc` with `type: Number`, which
        // yields NaN rather than a CLI-level parse error.
        const result = await runEvalCommand({ cwd, logger, threshold: Number.NaN });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(recorded.errors.some((line) => line.includes("--threshold") && line.includes("[0, 1]"))).toBe(true);
    });

    it("rejects a --threshold outside [0, 1] before discovering anything", async () => {
        expect.assertions(2);

        const { logger, recorded } = recordingLogger();
        const cwd = join(fixtureRoot, "eval-sample");

        const result = await runEvalCommand({ cwd, logger, threshold: 5 });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(recorded.errors.some((line) => line.includes("--threshold") && line.includes("[0, 1]"))).toBe(true);
    });

    it("aborts with one distinct, actionable message and a non-zero exit when the Node floor can't load a .ts eval (ERR_UNKNOWN_FILE_EXTENSION), instead of mislabeling it a per-eval failure", async () => {
        expect.assertions(4);

        const { logger, recorded } = recordingLogger();
        const cwd = join(fixtureRoot, "eval-floor-sample");

        const result = await runEvalCommand({ cwd, logger });

        expect(result.code).toBe(1);
        // No per-eval outcome at all — the run aborted before producing one,
        // rather than recording a mislabeled "failed" entry for it.
        expect(result.evals).toHaveLength(0);
        expect(result.error).toContain("Node ≥23.6");
        expect(recorded.errors.some((line) => line.includes("Node ≥23.6") && line.includes("plans/245-eval-runner-design.md"))).toBe(true);
    });

    it("--threshold against an empty/missing eval dir exits non-zero instead of passing vacuously", async () => {
        expect.assertions(3);

        const { logger, recorded } = recordingLogger();
        // `fixtureRoot` itself has no `evals/` child (see the no-directory test
        // above) — 0 evals discovered. A `--threshold` gate applied to nothing
        // must not report success.
        const result = await runEvalCommand({ cwd: fixtureRoot, logger, threshold: 0.8 });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(result.evals).toHaveLength(0);
        expect(recorded.errors.some((line) => line.includes("--threshold") && line.includes("0 eval files"))).toBe(true);
    });
});
