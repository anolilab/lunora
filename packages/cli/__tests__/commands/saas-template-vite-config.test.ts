/**
 * The `saas` template's dev-origin plugin, EXECUTED.
 *
 * It injects the origin the server render calls Lunora on. `localhost` there means
 * "the machine reading this", so it must never reach the client bundle (a browser
 * on another machine would connect to itself), and the port it names must be the
 * one Vite binds.
 *
 * The plugins the config composes are stubbed: only the plugin under test is real.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

/** What the template's `.env` files hold, for the `loadEnv` stub below. */
const envFiles: Record<string, string> = {};

// eslint-disable-next-line vitest/prefer-import-in-mock -- the package is not a dependency of this one, so it cannot be resolved as a type
vi.mock("@lunora/vite", () => {
    return {
        lunora: () => {
            return { name: "lunora" };
        },
    };
});
// eslint-disable-next-line vitest/prefer-import-in-mock -- the package is not a dependency of this one, so it cannot be resolved as a type
vi.mock("@cloudflare/vite-plugin", () => {
    return {
        cloudflare: () => {
            return { name: "cloudflare" };
        },
    };
});
// eslint-disable-next-line vitest/prefer-import-in-mock -- the package is not a dependency of this one, so it cannot be resolved as a type
vi.mock("@tanstack/react-start/plugin/vite", () => {
    return {
        tanstackStart: () => {
            return { name: "tanstack-start" };
        },
    };
});
// eslint-disable-next-line vitest/prefer-import-in-mock -- the package is not a dependency of this one, so it cannot be resolved as a type
vi.mock("@vitejs/plugin-react", () => {
    return {
        default: () => {
            return { name: "react" };
        },
    };
});
// eslint-disable-next-line vitest/prefer-import-in-mock -- the package is not a dependency of this one, so it cannot be resolved as a type
vi.mock("vite", () => {
    return {
        defineConfig: (config: unknown) => config,
        // Vite's merge: the `.env` files, then any `VITE_*` already in `process.env` on top.
        loadEnv: (): Record<string, string> => {
            return { ...envFiles, ...(process.env["VITE_LUNORA_URL"] ? { VITE_LUNORA_URL: process.env["VITE_LUNORA_URL"] } : {}) };
        },
    };
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

interface OriginResult {
    define?: unknown;
    environments?: { client?: unknown; ssr?: { define?: Record<string, string> } };
    server?: { strictPort?: boolean };
}

type Config = (user: { server?: { port?: number } }, env: { mode: string }) => OriginResult | undefined;

const originPlugin = async (): Promise<{ apply?: string; config: Config }> => {
    const loaded = (await import(pathToFileURL(join(root, "templates", "saas", "vite.config.ts")).href)) as {
        default: { plugins: { config?: unknown; name: string }[] };
    };
    const plugin = loaded.default.plugins.find(({ name }) => name === "lunora-ssr-origin");

    return plugin as unknown as Awaited<ReturnType<typeof originPlugin>>;
};

describe("saas template dev origin", () => {
    const serve = { mode: "development" };

    afterEach(() => {
        vi.unstubAllEnvs();
        delete envFiles["VITE_LUNORA_URL"];
    });

    it("defines the origin for the server render only, never the client bundle", async () => {
        expect.assertions(4);

        vi.stubEnv("VITE_LUNORA_URL", "");

        const plugin = await originPlugin();
        const result = plugin.config({ server: { port: 4321 } }, serve);

        expect(plugin.apply).toBe("serve");
        // eslint-disable-next-line no-secrets/no-secrets -- an env-var define key, not a secret
        expect(result?.environments?.ssr?.define).toStrictEqual({ "import.meta.env.VITE_LUNORA_URL": '"http://localhost:4321"' });
        expect(result?.define).toBeUndefined();
        expect(result?.environments?.client).toBeUndefined();
    });

    it("makes the configured port the bound one, so the injected origin cannot drift", async () => {
        expect.assertions(1);

        vi.stubEnv("VITE_LUNORA_URL", "");

        const plugin = await originPlugin();
        const result = plugin.config({}, serve);

        expect(result?.server?.strictPort).toBe(true);
    });

    it("leaves an explicit VITE_LUNORA_URL alone", async () => {
        expect.assertions(1);

        vi.stubEnv("VITE_LUNORA_URL", "https://api.example.com");

        const plugin = await originPlugin();

        expect(plugin.config({}, serve)).toBeUndefined();
    });

    it("leaves a VITE_LUNORA_URL set in a .env file alone", async () => {
        expect.assertions(1);

        vi.stubEnv("VITE_LUNORA_URL", "");
        envFiles["VITE_LUNORA_URL"] = "https://api.example.com";

        const plugin = await originPlugin();

        expect(plugin.config({}, serve)).toBeUndefined();
    });
});
