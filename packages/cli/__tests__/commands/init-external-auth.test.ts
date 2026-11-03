import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseAuthChoice, wireExternalAuth } from "../../src/commands/init/external-auth";
import type { Logger } from "../../src/util/logger";

const ENTRY = `import type { ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "../lunora/_generated/app.js";

interface Env extends Record<string, unknown> {
    SHARD: ShardNamespaceLike;
}

const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    .extend(() => ({ allowUnauthenticatedShardAccess: true }))
    .build();

export default app;
`;

const CLIENT = `import { LunoraClient } from "lunorash/client";

export const client = new LunoraClient({ url: location.origin });
`;

/** What the auth-auth0-jwt item writes to `.dev.vars`, shortened. */
const AUTH0_ENV = ["AUTH0_DOMAIN=acme", "AUTH0_AUDIENCE=api"];

const silentLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];
    const push = (message: string): number => lines.push(message);

    return { lines, logger: { error: push, info: push, success: push, warn: push } };
};

describe(wireExternalAuth, () => {
    let project: string;

    beforeEach(() => {
        project = mkdtempSync(join(tmpdir(), "lunora-init-auth-"));
        writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { lunorash: "1.0.0" } }));
        mkdirSync(join(project, "src"));
        writeFileSync(join(project, "src", "client.ts"), CLIENT);
    });

    afterEach(() => {
        rmSync(project, { force: true, recursive: true });
    });

    it("chains resolveIdentity onto the entry's defineApp builder and imports the scaffolded resolver", () => {
        expect.assertions(4);

        writeFileSync(join(project, "src", "server.ts"), ENTRY);

        wireExternalAuth(project, "clerk", silentLogger().logger);

        const entry = readFileSync(join(project, "src", "server.ts"), "utf8");

        expect(entry).not.toContain("memoizeIdentity");
        expect(entry).toContain('import { clerkIdentity } from "../lunora/identity/clerk.js";');
        expect(entry).toMatch(/\.extend\(\(env\) => \(\{ resolveIdentity: clerkIdentity\(env\) \}\)\)\n {4}\.build\(\)/u);
        // The header import stays first.
        expect(entry.startsWith('import type { ShardNamespaceLike } from "lunorash/runtime";')).toBe(true);
    });

    it("chains resolveIdentity in front of a terminal buildFrameworkWorker call", () => {
        expect.assertions(1);

        writeFileSync(
            join(project, "src", "server.ts"),
            ENTRY.replace(
                ".build();",
                ".buildFrameworkWorker((request: Request, env: unknown, ctx: unknown) => handle(request, env as Env, ctx as ExecutionContext));",
            ),
        );

        wireExternalAuth(project, "clerk", silentLogger().logger);

        expect(readFileSync(join(project, "src", "server.ts"), "utf8")).toMatch(
            /\.extend\(\(env\) => \(\{ resolveIdentity: clerkIdentity\(env\) \}\)\)\n {4}\.buildFrameworkWorker\(/u,
        );
    });

    it("leaves an entry it already wired untouched on a repeat run", () => {
        expect.assertions(2);

        writeFileSync(join(project, "src", "server.ts"), ENTRY);
        wireExternalAuth(project, "clerk", silentLogger().logger);

        const once = readFileSync(join(project, "src", "server.ts"), "utf8");
        const { lines, logger } = silentLogger();

        wireExternalAuth(project, "clerk", logger);

        expect(readFileSync(join(project, "src", "server.ts"), "utf8")).toBe(once);
        expect(lines.join("\n")).toContain("already wires clerkIdentity");
    });

    it("does not replace a resolveIdentity the app already sets, and says how to compose them", () => {
        expect.assertions(2);

        const own = ENTRY.replace(".build();", ".extend(() => ({ resolveIdentity: accessResolver }))\n    .build();");

        writeFileSync(join(project, "src", "server.ts"), own);

        const { lines, logger } = silentLogger();

        wireExternalAuth(project, "workos", logger);

        expect(readFileSync(join(project, "src", "server.ts"), "utf8")).toBe(own);
        expect(lines.join("\n")).toContain("composeIdentityResolvers([workosIdentity(env), <your resolver>])");
    });

    it("puts the imports after the last import of an entry without semicolons", () => {
        expect.assertions(1);

        writeFileSync(join(project, "src", "server.ts"), ENTRY.replaceAll(";\n", "\n"));

        wireExternalAuth(project, "clerk", silentLogger().logger);

        expect(readFileSync(join(project, "src", "server.ts"), "utf8")).toContain(
            'import { defineApp } from "../lunora/_generated/app.js"\nimport { clerkIdentity }',
        );
    });

    it("does not splice imports into the chain when the last import's semicolon is followed by a comment", () => {
        expect.assertions(2);

        writeFileSync(
            join(project, "src", "server.ts"),
            ENTRY.replace('from "../lunora/_generated/app.js";', 'from "../lunora/_generated/app.js"; // generated'),
        );

        wireExternalAuth(project, "clerk", silentLogger().logger);

        const entry = readFileSync(join(project, "src", "server.ts"), "utf8");

        expect(entry).toContain('from "../lunora/_generated/app.js"; // generated\nimport { clerkIdentity } from "../lunora/identity/clerk.js";\n');
        // The chain stays intact: one `defineApp<Env>()` and the extend right before `.build()`.
        expect(entry).toMatch(
            /\.extend\(\(\) => \(\{ allowUnauthenticatedShardAccess: true \}\)\)\n {4}\/\/ Verify[^\n]*\n {4}\.extend\(\(env\) => \(\{ resolveIdentity: clerkIdentity\(env\) \}\)\)\n {4}\.build\(\);/u,
        );
    });

    it("ends the chain at its terminal call, not at a semicolon inside a callback body or string", () => {
        expect.assertions(1);

        const callback = ENTRY.replace(
            "    .build();",
            '    .extend((env) => {\n        const origin = "https://a.test;\n";\n\n        return { allowedOrigins: [origin] };\n    })\n    .build();',
        );

        writeFileSync(join(project, "src", "server.ts"), callback);

        wireExternalAuth(project, "clerk", silentLogger().logger);

        expect(readFileSync(join(project, "src", "server.ts"), "utf8")).toMatch(
            /return \{ allowedOrigins: \[origin\] \};\n {4}\}\)\n {4}\/\/ Verify[^\n]*\n {4}\.extend\(\(env\) => \(\{ resolveIdentity: clerkIdentity\(env\) \}\)\)\n {4}\.build\(\);/u,
        );
    });

    it("writes lunora.config.ts for a Vite-first app with no entry", () => {
        expect.assertions(2);

        writeFileSync(join(project, "wrangler.jsonc"), '{ "main": "virtual:lunora/worker" }');

        wireExternalAuth(project, "workos", silentLogger().logger);

        const config = readFileSync(join(project, "lunora.config.ts"), "utf8");

        expect(config).toContain('import { workosIdentity } from "./lunora/identity/workos";');
        expect(config).toContain("app.extend((env) => ({ resolveIdentity: workosIdentity(env) }))");
    });

    it("leaves an existing lunora.config.ts alone and says what to add", () => {
        expect.assertions(2);

        writeFileSync(join(project, "wrangler.jsonc"), '{ "main": "virtual:lunora/worker" }');

        writeFileSync(join(project, "lunora.config.ts"), "export default {};\n");

        const { lines, logger } = silentLogger();

        wireExternalAuth(project, "auth0", logger);

        expect(readFileSync(join(project, "lunora.config.ts"), "utf8")).toBe("export default {};\n");
        expect(lines.join("\n")).toContain("resolveIdentity: auth0Identity(env)");
    });

    it("turns on authTokenOnUpgrade where the client is built and prints the token wiring", () => {
        expect.assertions(2);

        const { lines, logger } = silentLogger();

        wireExternalAuth(project, "clerk", logger);

        expect(readFileSync(join(project, "src", "client.ts"), "utf8")).toContain("new LunoraClient({ url: location.origin, authTokenOnUpgrade: true })");
        expect(lines.join("\n")).toContain("setAuthTokenProvider(client, getToken, { subject: userId })");
    });

    it("puts the setting after a spread so a spread cannot overwrite it, and skips a call that already sets it", () => {
        expect.assertions(2);

        mkdirSync(join(project, "src", "app"), { recursive: true });
        writeFileSync(join(project, "src", "app", "app.config.ts"), 'providers: [provideLunora({ ...imported, url: "/x" })],\n');
        writeFileSync(join(project, "src", "app", "other.config.ts"), "providers: [provideLunora({ authTokenOnUpgrade: false })],\n");

        wireExternalAuth(project, "clerk", silentLogger().logger);

        expect(readFileSync(join(project, "src", "app", "app.config.ts"), "utf8")).toContain(
            'provideLunora({ ...imported, url: "/x", authTokenOnUpgrade: true })',
        );
        expect(readFileSync(join(project, "src", "app", "other.config.ts"), "utf8")).toBe("providers: [provideLunora({ authTokenOnUpgrade: false })],\n");
    });

    it("turns on authTokenOnUpgrade inside a Svelte component's script block and leaves its markup alone", () => {
        expect.assertions(1);

        mkdirSync(join(project, "src", "routes"), { recursive: true });
        const layout = '<script lang="ts">\n  const client = new LunoraClient({ url: location.origin });\n</script>\n<p>{client.url}</p>\n';
        writeFileSync(join(project, "src", "routes", "+layout.svelte"), layout, "utf8");

        wireExternalAuth(project, "clerk", silentLogger().logger);

        expect(readFileSync(join(project, "src", "routes", "+layout.svelte"), "utf8")).toBe(
            '<script lang="ts">\n  const client = new LunoraClient({ url: location.origin, authTokenOnUpgrade: true });\n</script>\n<p>{client.url}</p>\n',
        );
    });

    it("leaves a comment or string that names a client construction alone, and patches only the real call", () => {
        expect.assertions(2);

        mkdirSync(join(project, "src"), { recursive: true });
        const comment = '// new LunoraClient({ url: "old" }) and provideLunora() were here\nexport const note = "provideLunora()";\n';
        writeFileSync(join(project, "src", "note.ts"), comment, "utf8");
        writeFileSync(join(project, "src", "client.ts"), 'export const client = new LunoraClient({ url: "/x" });\n', "utf8");

        wireExternalAuth(project, "clerk", silentLogger().logger);

        expect(readFileSync(join(project, "src", "note.ts"), "utf8")).toBe(comment);
        expect(readFileSync(join(project, "src", "client.ts"), "utf8")).toContain('new LunoraClient({ url: "/x", authTokenOnUpgrade: true })');
    });

    it("turns on authTokenOnUpgrade in an Analog app that builds its client through provideLunora", () => {
        expect.assertions(2);

        mkdirSync(join(project, "src", "app"), { recursive: true });
        writeFileSync(join(project, "src", "app", "app.config.ts"), "providers: [provideHttpClient(), provideLunora()],\n");
        writeFileSync(join(project, "src", "app", "other.config.ts"), 'providers: [provideLunora({ url: "/x" })],\n');

        wireExternalAuth(project, "clerk", silentLogger().logger);

        expect(readFileSync(join(project, "src", "app", "app.config.ts"), "utf8")).toContain("provideLunora({ authTokenOnUpgrade: true })");
        expect(readFileSync(join(project, "src", "app", "other.config.ts"), "utf8")).toContain('provideLunora({ url: "/x", authTokenOnUpgrade: true })');
    });
});

describe("wireExternalAuth outside a composed worker", () => {
    it("records the env vars in .dev.vars.example and warns instead of writing a config the worker would not read", () => {
        expect.assertions(3);

        const project = mkdtempSync(join(tmpdir(), "lunora-init-auth-"));

        try {
            writeFileSync(join(project, "package.json"), "{}");
            writeFileSync(join(project, "wrangler.jsonc"), '{ "main": "worker.ts" }');
            writeFileSync(join(project, ".dev.vars"), `${AUTH0_ENV.join("\n")}\n`);

            const { lines, logger } = silentLogger();

            wireExternalAuth(project, "auth0", logger);

            expect(existsSync(join(project, "lunora.config.ts"))).toBe(false);
            expect(lines.join("\n")).toContain("resolveIdentity: auth0Identity(env)");
            expect(readFileSync(join(project, ".dev.vars.example"), "utf8")).toContain(AUTH0_ENV.join("\n"));
        } finally {
            rmSync(project, { force: true, recursive: true });
        }
    });
});

describe(parseAuthChoice, () => {
    it("accepts the five choices case-insensitively and warns on anything else", () => {
        expect.assertions(3);

        const warnings: string[] = [];

        expect(parseAuthChoice("WorkOS", (message) => warnings.push(message))).toBe("workos");
        expect(parseAuthChoice("okta", (message) => warnings.push(message))).toBe("none");
        expect(warnings).toHaveLength(1);
    });
});
