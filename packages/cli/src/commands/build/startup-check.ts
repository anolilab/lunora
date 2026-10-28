import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { resolveSchemaDirectory } from "@lunora/config";
import { detectPackageManager, toolchainExecArgs } from "@lunora/config/cli";

import type { Logger } from "../../util/logger";
import type { Spawner } from "../../util/spawn";

/** Cloudflare's startup CPU limit (error 10021). Fixed by the platform, not raisable on any plan. */
const STARTUP_LIMIT_MS = 1000;

/**
 * Local `wrangler check startup` "Active" median above which `lunora build` warns.
 *
 * The laptop-to-Cloudflare factor is not known. Local profiles of 0.4–0.7 s have been rejected upstream
 * (a real ~1,000-procedure app; plan 490 §0 and §9), which puts the factor at ~1.4× and possibly
 * ~2.5× or more. 200 ms is half the low end of that rejected range, so the warning fires while
 * there is still room to act rather than at the deploy that already fails.
 */
const STARTUP_WARN_MS = 200;

/** Profiles per build. One run swings by 2× on a busy machine; the median of three is stable enough for a warning. */
const STARTUP_RUNS = 3;

const STARTUP_DOCS_URL = "https://lunora.sh/docs/startup-cpu-limit";

const ACTIVE_LINE = /Active:\s+([\d.]+) ms/u;

/** Where `lunora build` asks wrangler to write the upload form, relative to the project root, kept out of the measured out-dir. */
const startupBundlePath = (runId: string): string => join(".lunora", "startup-check", runId, "worker.bundle");

interface StartupCheckOptions {
    /** The upload form `wrangler deploy --outfile` wrote, relative to `cwd`. */
    bundleFile: string;
    cwd: string;
    logger: Logger;
    spawner: Spawner;
}

/** True when the generated registry loads function modules on demand; the output decides, as for the smoke-load. */
const isLazyBuild = (cwd: string): boolean => {
    const functionsFile = join(cwd, resolveSchemaDirectory(cwd), "_generated", "functions.ts");

    return existsSync(functionsFile) && readFileSync(functionsFile, "utf8").includes("export const loadAllFunctions");
};

/** Median "Active" ms over {@link STARTUP_RUNS} profiles, or the reason none could be taken. */
const profileStartup = async ({ bundleFile, cwd, spawner }: StartupCheckOptions): Promise<{ median: number } | { skip: string }> => {
    const samples: number[] = [];
    const profile = join(dirname(bundleFile), "startup.cpuprofile");
    const { args, command } = toolchainExecArgs(detectPackageManager(cwd), {
        args: ["check", "startup", "--worker", bundleFile, "--outfile", profile],
        tool: "wrangler",
    });

    for (let run = 0; run < STARTUP_RUNS; run += 1) {
        let output: string | undefined;

        try {
            // eslint-disable-next-line no-await-in-loop -- profiles run one at a time so they do not compete for the CPU they measure
            const result = await spawner({ args, captureStdoutSilently: true, command, cwd });

            if (result.code !== 0) {
                return { skip: `\`wrangler check startup\` exited with code ${String(result.code)}` };
            }

            output = result.stdout;
        } catch (error) {
            return { skip: `\`wrangler check startup\` could not run (${error instanceof Error ? error.message : String(error)})` };
        }

        const match = ACTIVE_LINE.exec(output ?? "");

        if (match?.[1] === undefined) {
            return { skip: "`wrangler check startup` printed no Active time" };
        }

        samples.push(Number(match[1]));
    }

    samples.sort((a, b) => a - b);

    return { median: samples[Math.floor(samples.length / 2)] as number };
};

/**
 * Profile the built Worker's global-scope evaluation and warn when it nears Cloudflare's 1 s startup
 * limit, which is otherwise invisible until the upload is rejected. Advisory: it never fails the build,
 * and anything that stops it from measuring (no upload form on disk, wrangler missing or failing) is
 * a debug line, not an error.
 */
const checkStartupBudget = async (options: StartupCheckOptions): Promise<number | undefined> => {
    const { bundleFile, cwd, logger } = options;

    if (!existsSync(resolve(cwd, bundleFile))) {
        logger.debug?.(`startup check skipped: no upload form at ${bundleFile}`);

        return undefined;
    }

    const measured = await profileStartup(options);

    if ("skip" in measured) {
        logger.debug?.(`startup check skipped: ${measured.skip}`);

        return undefined;
    }

    const { median } = measured;
    const summary = `startup: ${median.toFixed(0)} ms local CPU (median of ${String(STARTUP_RUNS)} \`wrangler check startup\` runs)`;

    if (median <= STARTUP_WARN_MS) {
        logger.info(summary);

        return median;
    }

    const lazyHint = isLazyBuild(cwd) ? "" : " This build is eager: `--lazy-functions` (or LUNORA_LAZY_FUNCTIONS=1) defers function modules to first use.";

    logger.warn(
        `${summary} is above the ${String(STARTUP_WARN_MS)} ms warning line. Cloudflare rejects a Worker whose startup exceeds ` +
            `${String(STARTUP_LIMIT_MS)} ms of ITS CPU (error 10021), and how local CPU maps to Cloudflare's is unknown: a 0.4–0.7 s local ` +
            `profile has been rejected, so the line is a heuristic, not a prediction.${lazyHint} See ${STARTUP_DOCS_URL}`,
    );

    return median;
};

export { checkStartupBudget, STARTUP_WARN_MS, startupBundlePath };
