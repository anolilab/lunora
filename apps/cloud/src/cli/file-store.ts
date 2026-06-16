import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CliConfig, ConfigStore } from "./config";

/**
 * File-backed {@link ConfigStore} at `~/.lunora/cloud.json` — the default store
 * for the deploy CLI (which runs in Node, not the Worker). A missing/garbled
 * file reads as empty config.
 */
export const createFileConfigStore = (path: string = join(homedir(), ".lunora", "cloud.json")): ConfigStore => {
    return {
        read: async () => {
            try {
                return JSON.parse(await readFile(path, "utf8")) as CliConfig;
            } catch {
                return {};
            }
        },
        write: async (config) => {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        },
    };
};
