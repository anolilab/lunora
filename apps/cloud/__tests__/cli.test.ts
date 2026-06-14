import { describe, expect, it, vi } from "vitest";

import { deploy, link, login, status } from "../src/cli/commands";
import type { CliConfig, ConfigStore } from "../src/cli/config";

const memoryStore = (initial: CliConfig = {}): ConfigStore => {
    let config = initial;

    return {
        read: () => Promise.resolve(config),
        write: (next) => {
            config = next;

            return Promise.resolve();
        },
    };
};

describe("cli commands", () => {
    it("login then link build up the config; status reflects it", async () => {
        const store = memoryStore();

        await login(store, { apiUrl: "https://cloud", deployKey: "production:org|secret" });
        await link(store, { projectId: "proj_1" });

        const config = await store.read();

        expect(config).toStrictEqual({ apiUrl: "https://cloud", deployKey: "production:org|secret", projectId: "proj_1" });
        expect(status(config)).toStrictEqual({ linked: true, loggedIn: true });
    });

    it("deploy requires login then link", async () => {
        await expect(deploy(memoryStore(), { scriptName: "s" }, () => {})).rejects.toThrow(/not logged in/u);
        await expect(deploy(memoryStore({ apiUrl: "https://c", deployKey: "k" }), { scriptName: "s" }, () => {})).rejects.toThrow(/no linked project/u);
    });

    it("deploy calls the deploy fn with the merged config", async () => {
        const store = memoryStore({ apiUrl: "https://cloud", deployKey: "k", projectId: "proj_1" });
        const deployFn = vi.fn(async () => {
            return { status: "live" };
        });

        const result = await deploy(store, { kind: "production", scriptName: "s1" }, () => {}, deployFn);

        expect(result).toStrictEqual({ status: "live" });
        expect(deployFn).toHaveBeenCalledWith(
            { apiUrl: "https://cloud", branch: undefined, deployKey: "k", kind: "production", projectId: "proj_1", scriptName: "s1" },
            expect.any(Function),
        );
    });
});
