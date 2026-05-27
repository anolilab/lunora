import { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";

import { join } from "@visulima/path";

import { detectPackageManager, execArgsFor } from "../util/detectPackageManager.js";
import type { Logger } from "../util/logger.js";
import type { SpawnDescriptor, Spawner } from "../util/spawn.js";
import { defaultSpawner } from "../util/spawn.js";

export interface DevCommandOptions {
    cwd?: string;
    logger: Logger;
    noVite?: boolean;
    port?: number;
    spawner?: Spawner;
}

export type DevMode = "concurrent" | "standalone" | "vite";

export interface DevCommandPlan {
    descriptors: ReadonlyArray<SpawnDescriptor & { tag?: string }>;
    mode: DevMode;
}

const findWranglerConfig = (cwd: string): boolean => {
    return existsSync(join(cwd, "wrangler.jsonc")) || existsSync(join(cwd, "wrangler.json")) || existsSync(join(cwd, "wrangler.toml"));
};

const findViteConfig = (cwd: string): boolean => {
    return existsSync(join(cwd, "vite.config.ts")) || existsSync(join(cwd, "vite.config.js")) || existsSync(join(cwd, "vite.config.mjs"));
};

const buildPlan = (cwd: string, options: DevCommandOptions): DevCommandPlan => {
    const viteConfigPresent = findViteConfig(cwd);
    const wranglerConfigPresent = findWranglerConfig(cwd);
    const useVite = viteConfigPresent && !options.noVite;
    const manager = detectPackageManager(cwd);

    const viteArgs: string[] = [];

    if (options.port !== undefined) {
        viteArgs.push("--port", String(options.port));
    }

    const wranglerArgs: string[] = ["dev"];

    // When both vite + wrangler run concurrently we let vite own --port (it
    // is what the browser hits) and let wrangler use its default port so
    // the two never collide.
    if (options.port !== undefined && !useVite) {
        wranglerArgs.push("--port", String(options.port));
    }

    if (useVite && wranglerConfigPresent) {
        const viteExec = execArgsFor(manager, "vite", viteArgs);
        const wranglerExec = execArgsFor(manager, "wrangler", wranglerArgs);

        return {
            descriptors: [
                { args: viteExec.args, command: viteExec.command, cwd, tag: "vite" },
                { args: wranglerExec.args, command: wranglerExec.command, cwd, tag: "wrangler" },
            ],
            mode: "concurrent",
        };
    }

    if (useVite) {
        const exec = execArgsFor(manager, "vite", viteArgs);

        return {
            descriptors: [{ args: exec.args, command: exec.command, cwd, tag: "vite" }],
            mode: "vite",
        };
    }

    const exec = execArgsFor(manager, "wrangler", wranglerArgs);

    return {
        descriptors: [{ args: exec.args, command: exec.command, cwd, tag: "wrangler" }],
        mode: "standalone",
    };
};

export const planDevCommand = (options: DevCommandOptions): DevCommandPlan => {
    return buildPlan(options.cwd ?? process.cwd(), options);
};

/**
 * Spawn two children concurrently, pipe their stdout/stderr through the
 * provided logger (tagged by descriptor.tag), and resolve once both have
 * exited. SIGINT/SIGTERM in the parent is fanned out to both children.
 */
const runConcurrent = async (
    descriptors: ReadonlyArray<SpawnDescriptor & { tag?: string }>,
    logger: Logger,
): Promise<{ code: number }> => {
    const children: ChildProcess[] = [];

    const cleanup = (signal: NodeJS.Signals) => {
        for (const child of children) {
            if (!child.killed) {
                try {
                    child.kill(signal);
                } catch {
                    /* ignore — process may already be gone */
                }
            }
        }
    };

    const onSigint = () => cleanup("SIGTERM");
    const onSigterm = () => cleanup("SIGTERM");

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    const promises = descriptors.map(async (descriptor) => {
        return new Promise<number>((resolve) => {
            const tag = descriptor.tag ?? "child";
            const child = nodeSpawn(descriptor.command, [...descriptor.args], {
                cwd: descriptor.cwd ?? process.cwd(),
                env: descriptor.env ? { ...process.env, ...descriptor.env } : process.env,
                stdio: ["inherit", "pipe", "pipe"],
            });

            children.push(child);

            const onLine = (chunk: Buffer | string, kind: "stdout" | "stderr") => {
                const text = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trimEnd();

                if (text.length === 0) {
                    return;
                }

                for (const line of text.split("\n")) {
                    const prefixed = `[${tag}] ${line}`;

                    if (kind === "stderr") {
                        logger.warn(prefixed);
                    } else {
                        logger.info(prefixed);
                    }
                }
            };

            child.stdout?.on("data", (chunk: Buffer) => onLine(chunk, "stdout"));
            child.stderr?.on("data", (chunk: Buffer) => onLine(chunk, "stderr"));

            child.on("error", (error) => {
                logger.error(`[${tag}] failed to start: ${error.message}`);
                resolve(1);
            });

            child.on("exit", (code) => {
                resolve(code ?? 0);
            });
        });
    });

    try {
        const codes = await Promise.all(promises);
        const worst = codes.reduce((accumulator, code) => (code !== 0 ? code : accumulator), 0);

        return { code: worst };
    } finally {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
    }
};

export const runDevCommand = async (options: DevCommandOptions): Promise<{ code: number; plan: DevCommandPlan }> => {
    const plan = planDevCommand(options);
    const spawner = options.spawner ?? defaultSpawner;

    if (plan.mode === "concurrent") {
        options.logger.info("starting Vite + wrangler dev (concurrent)");

        // For test injection paths (recording spawner) fall back to
        // sequential spawn so tests stay deterministic. The recording
        // spawner just captures descriptors and returns 0.
        if (spawner !== defaultSpawner) {
            let lastCode = 0;

            for (const descriptor of plan.descriptors) {
                // eslint-disable-next-line no-await-in-loop
                const result = await spawner(descriptor);

                lastCode = result.code;
            }

            return { code: lastCode, plan };
        }

        const result = await runConcurrent(plan.descriptors, options.logger);

        return { code: result.code, plan };
    }

    options.logger.info(plan.mode === "vite" ? "starting Vite + Worker dev server" : "starting wrangler dev (standalone)");

    let lastCode = 0;

    for (const descriptor of plan.descriptors) {
        // eslint-disable-next-line no-await-in-loop
        const result = await spawner(descriptor);

        lastCode = result.code;
    }

    return { code: lastCode, plan };
};
