import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ArchitectureManifest } from "../../../shared/architecture-manifest";
import { emitServiceDeclarations } from "../src/emit/service-declarations";
import { resolveServiceBindings, runCodegen } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "simple");

let workdir: string;

const write = (relative: string, source: string): void => {
    const path = join(workdir, relative);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source, "utf8");
};

const generated = (name: string): string => readFileSync(join(workdir, "lunora", "_generated", name), "utf8");

/** A service that imports a type from the llm-kit package, which the service's node_modules provides. */
const writeLlmKitImport = (): void => {
    write("services/llm-gateway/node_modules/llm-kit/package.json", `{ "name": "llm-kit", "types": "index.d.ts" }\n`);
    write("services/llm-gateway/node_modules/llm-kit/index.d.ts", `export interface Usage { tokens: number }\n`);
    write(
        "services/llm-gateway/src/index.ts",
        `import type { Usage } from "llm-kit";

export class Gateway {
    async complete(prompt: string): Promise<{ usage: Usage; text: string }> {
        return { text: prompt, usage: { tokens: prompt.length } };
    }
}
`,
    );
};

/** The declaration snapshot the llmGateway service emits, from the workdir's current sources. */
const emitLlmGateway = (): Record<string, string> | undefined =>
    resolveServiceBindings(workdir)
        .filter(({ name }) => name === "llmGateway")
        .map((service) => emitServiceDeclarations(service, join(workdir, "lunora", "_generated")))[0];

/** A fetch service (`parser`) and an RPC service (`llmGateway`), each in its own folder with its own wrangler config. */
const writeServices = (): void => {
    write(
        "lunora.config.ts",
        `export default {
    services: {
        llmGateway: { dir: "./services/llm-gateway", entrypoint: "Gateway" },
        parser: { dir: "./services/parser" } as const,
    } satisfies Record<string, { dir: string }>,
};
`,
    );
    write("services/parser/wrangler.jsonc", `{\n    // a comment\n    "name": "neore-parser",\n    "main": "src/index.ts",\n}\n`);
    write("services/parser/src/index.ts", `export default { fetch: async () => new Response("parsed") };\n`);
    write("services/llm-gateway/wrangler.jsonc", `{ "name": "neore-llm-gateway", "main": "src/index.ts" }\n`);
    write(
        "services/llm-gateway/src/index.ts",
        `export class Gateway {
    async complete(prompt: string): Promise<string> {
        return prompt;
    }
}
`,
    );
};

describe("services", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-services-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("emits nothing service-related when no service is declared", () => {
        expect.assertions(2);

        runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] });

        expect(generated("server.ts")).not.toContain("LunoraServices");
        expect(generated("shard.ts")).not.toContain("LUNORA_SERVICES");
    });

    it("types ctx.services on actions only and wires each binding into the shard", () => {
        expect.assertions(6);

        writeServices();
        runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] });

        const server = generated("server.ts");
        const shard = generated("shard.ts");

        expect(server).toContain(`import type * as lunoraService_llmGateway from "./services/llmGateway/src/index.js";`);
        expect(server).toContain("readonly llmGateway: ServiceRpc<typeof lunoraService_llmGateway.Gateway>;");
        expect(server).toContain("readonly parser: ServiceFetcher;");
        expect(server.match(/readonly services: LunoraServices;/gu)).toHaveLength(1);
        expect(shard).toContain(`{ binding: "SERVICE_LLM_GATEWAY", name: "llmGateway", rpc: true }`);
        expect(shard).toContain(`{ binding: "SERVICE_PARSER", name: "parser" }`);
    });

    it("types an RPC service from a declaration snapshot whose imports resolve from _generated", () => {
        expect.assertions(6);

        writeServices();
        write("services/llm-gateway/src/types.ts", `export interface Completion { text: string }\n`);
        write("services/llm-gateway/node_modules/llm-kit/package.json", `{ "name": "llm-kit", "types": "index.d.ts" }\n`);
        write("services/llm-gateway/node_modules/llm-kit/index.d.ts", `export interface Usage { tokens: number }\n`);
        write(
            "services/llm-gateway/src/index.ts",
            `import type { Usage } from "llm-kit";
import type { Completion } from "./types";

// A type error in the service must not stop its snapshot.
const broken: number = "not a number";

export class Gateway {
    async complete(prompt: string): Promise<Completion & { usage: Usage }> {
        return { text: prompt, usage: { tokens: broken } };
    }
}
`,
        );
        runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] });

        const entry = generated("services/llmGateway/src/index.d.ts");

        expect(entry).toContain(`from "./types.js"`);
        expect(entry).toContain(`from "../../../../../services/llm-gateway/node_modules/llm-kit/index.js"`);
        expect(entry).toContain("complete(prompt: string): Promise<Completion & {");
        expect(generated("services/llmGateway/src/types.d.ts")).toContain("export interface Completion");

        // The snapshot goes once the service is no longer RPC.
        write("lunora.config.ts", `export default { services: { parser: { dir: "./services/parser" } } };\n`);
        runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] });

        expect(() => generated("services/llmGateway/src/index.d.ts")).toThrow(/ENOENT/u);
        expect(() => generated("services")).toThrow(/ENOENT/u);
    });

    it("re-emits a service's snapshot when a file is added to its tree", () => {
        expect.assertions(2);

        writeServices();

        const first = emitLlmGateway();

        // A new file that nothing in the program imports yet still changes what the tree resolves to.
        write("services/llm-gateway/src/shadow.ts", "export const shadow = 1;\n");

        expect(emitLlmGateway()).not.toBe(first);
        expect(emitLlmGateway()).toBe(emitLlmGateway());
    });

    it("re-emits a service's snapshot when an imported declaration file changes without a manifest change", () => {
        expect.assertions(2);

        writeServices();
        writeLlmKitImport();

        const first = emitLlmGateway();

        // The manifest and its `types` target are untouched; only the declaration file the import resolves to changes.
        write("services/llm-gateway/node_modules/llm-kit/index.d.ts", `export interface Usage { tokens: string }\n`);

        expect(emitLlmGateway()).not.toBe(first);
        expect(emitLlmGateway()).toBe(emitLlmGateway());
    });

    it("re-emits a service's snapshot when a file is added to the root of a package it imports", () => {
        expect.assertions(1);

        writeServices();
        writeLlmKitImport();

        const first = emitLlmGateway();

        write("services/llm-gateway/node_modules/llm-kit/types.d.ts", `export interface Usage { tokens: boolean }\n`);

        expect(emitLlmGateway()).not.toBe(first);
    });

    it("re-emits a service's snapshot when a declaration file an imported package re-exports from changes", () => {
        expect.assertions(2);

        writeServices();
        write("services/llm-gateway/node_modules/llm-kit/package.json", `{ "name": "llm-kit", "types": "index.d.ts" }\n`);
        write("services/llm-gateway/node_modules/llm-kit/index.d.ts", `export type { Usage } from "./usage";\n`);
        write("services/llm-gateway/node_modules/llm-kit/usage.d.ts", `export interface Usage { tokens: number }\n`);
        write(
            "services/llm-gateway/src/index.ts",
            `import type { Usage } from "llm-kit";

export class Gateway {
    async complete(prompt: string): Promise<{ usage: Usage; text: string }> {
        return { text: prompt, usage: { tokens: prompt.length } };
    }
}
`,
        );

        const first = emitLlmGateway();

        // Only the file the package re-exports from changes; its manifest and index are untouched.
        write("services/llm-gateway/node_modules/llm-kit/usage.d.ts", `export interface Usage { tokens: string }\n`);

        expect(emitLlmGateway()).not.toBe(first);
        expect(emitLlmGateway()).toBe(emitLlmGateway());
    });

    it("re-emits a service's snapshot when a file shadows a subpath the package resolved in a nested directory", () => {
        expect.assertions(2);

        writeServices();
        write("services/llm-gateway/node_modules/llm-kit/package.json", `{ "name": "llm-kit" }\n`);
        write("services/llm-gateway/node_modules/llm-kit/dist/sub/index.d.ts", `export interface Usage { tokens: number }\n`);
        write(
            "services/llm-gateway/src/index.ts",
            `import type { Usage } from "llm-kit/dist/sub";

export class Gateway {
    async complete(prompt: string): Promise<{ usage: Usage; text: string }> {
        return { text: prompt, usage: { tokens: prompt.length } };
    }
}
`,
        );

        const first = emitLlmGateway();

        // Beside the directory the import resolved to, so the package root and its manifest are untouched.
        write("services/llm-gateway/node_modules/llm-kit/dist/sub.d.ts", `export interface Usage { tokens: string }\n`);

        expect(emitLlmGateway()).not.toBe(first);
        expect(emitLlmGateway()).toBe(emitLlmGateway());
    });

    it("re-emits a service's snapshot when a file shadows an import resolved under a build-named directory of the service", () => {
        expect.assertions(2);

        writeServices();
        write("services/llm-gateway/src/dist/sub/index.ts", `export interface Usage { tokens: number }\n`);
        write(
            "services/llm-gateway/src/index.ts",
            `import type { Usage } from "./dist/sub";

export class Gateway {
    async complete(prompt: string): Promise<{ usage: Usage; text: string }> {
        return { text: prompt, usage: { tokens: prompt.length } };
    }
}
`,
        );

        const first = emitLlmGateway();

        // Beside the directory the import resolved to; `dist` is excluded from the tree scan, so only the directory's own stamp sees this.
        write("services/llm-gateway/src/dist/sub.ts", `export interface Usage { tokens: string }\n`);

        expect(emitLlmGateway()).not.toBe(first);
        expect(emitLlmGateway()).toBe(emitLlmGateway());
    });

    it("re-emits a service's snapshot when a dependency's symlink is repointed to another install", () => {
        expect.assertions(2);

        writeServices();
        write("services/llm-gateway/store/llm-kit-1/package.json", `{ "name": "llm-kit", "types": "index.d.ts" }\n`);
        write("services/llm-gateway/store/llm-kit-1/index.d.ts", `export interface Usage { tokens: number }\n`);
        write("services/llm-gateway/store/llm-kit-2/package.json", `{ "name": "llm-kit", "types": "index.d.ts" }\n`);
        write("services/llm-gateway/store/llm-kit-2/index.d.ts", `export interface Usage { tokens: string }\n`);
        mkdirSync(join(workdir, "services/llm-gateway/node_modules"), { recursive: true });
        symlinkSync(join(workdir, "services/llm-gateway/store/llm-kit-1"), join(workdir, "services/llm-gateway/node_modules/llm-kit"), "dir");
        write(
            "services/llm-gateway/src/index.ts",
            `import type { Usage } from "llm-kit";

export class Gateway {
    async complete(prompt: string): Promise<{ usage: Usage; text: string }> {
        return { text: prompt, usage: { tokens: prompt.length } };
    }
}
`,
        );

        const first = emitLlmGateway();

        // Same manifest and same declaration file under the old target; only the link moves, as a package manager does on an update.
        unlinkSync(join(workdir, "services/llm-gateway/node_modules/llm-kit"));
        symlinkSync(join(workdir, "services/llm-gateway/store/llm-kit-2"), join(workdir, "services/llm-gateway/node_modules/llm-kit"), "dir");

        expect(emitLlmGateway()).not.toBe(first);
        expect(emitLlmGateway()).toBe(emitLlmGateway());
    });

    it("re-emits a service's snapshot when a dependency of an imported package is relinked in the package store", () => {
        expect.assertions(2);

        const store = join(workdir, "node_modules", ".pnpm");

        writeServices();
        write(join("node_modules", ".pnpm", "dep@1", "node_modules", "dep", "package.json"), `{ "name": "dep", "types": "index.d.ts" }\n`);
        write(join("node_modules", ".pnpm", "dep@1", "node_modules", "dep", "index.d.ts"), `export interface Tokens { count: number }\n`);
        write(join("node_modules", ".pnpm", "dep@2", "node_modules", "dep", "package.json"), `{ "name": "dep", "types": "index.d.ts" }\n`);
        write(join("node_modules", ".pnpm", "dep@2", "node_modules", "dep", "index.d.ts"), `export interface Tokens { count: string }\n`);
        write(join("node_modules", ".pnpm", "llm-kit@1", "node_modules", "llm-kit", "package.json"), `{ "name": "llm-kit", "types": "index.d.ts" }\n`);
        write(join("node_modules", ".pnpm", "llm-kit@1", "node_modules", "llm-kit", "index.d.ts"), `export type { Tokens as Usage } from "dep";\n`);
        mkdirSync(join(store, "llm-kit@1", "node_modules"), { recursive: true });
        symlinkSync(join(store, "dep@1", "node_modules", "dep"), join(store, "llm-kit@1", "node_modules", "dep"), "dir");
        mkdirSync(join(workdir, "services/llm-gateway/node_modules"), { recursive: true });
        symlinkSync(join(store, "llm-kit@1", "node_modules", "llm-kit"), join(workdir, "services/llm-gateway/node_modules/llm-kit"), "dir");
        write(
            "services/llm-gateway/src/index.ts",
            `import type { Usage } from "llm-kit";

export class Gateway {
    async complete(prompt: string): Promise<{ usage: Usage; text: string }> {
        return { text: prompt, usage: { count: prompt.length } };
    }
}
`,
        );

        const first = emitLlmGateway();

        // The package and its manifest are untouched; only the link to its dependency, beside it in the store, moves.
        unlinkSync(join(store, "llm-kit@1", "node_modules", "dep"));
        symlinkSync(join(store, "dep@2", "node_modules", "dep"), join(store, "llm-kit@1", "node_modules", "dep"), "dir");

        expect(emitLlmGateway()).not.toBe(first);
        expect(emitLlmGateway()).toBe(emitLlmGateway());
    });

    it("re-emits a service's snapshot when a package it imports retargets its types", () => {
        expect.assertions(2);

        writeServices();
        write("services/llm-gateway/node_modules/llm-kit/package.json", `{ "name": "llm-kit", "types": "index.d.ts" }\n`);
        write("services/llm-gateway/node_modules/llm-kit/index.d.ts", `export interface Usage { tokens: number }\n`);
        write(
            "services/llm-gateway/src/index.ts",
            `import type { Usage } from "llm-kit";

export class Gateway {
    async complete(prompt: string): Promise<{ usage: Usage; text: string }> {
        return { text: prompt, usage: { tokens: prompt.length } };
    }
}
`,
        );

        const first = emitLlmGateway();

        // The old declaration file keeps its bytes; only the manifest's `types` target moves.
        write("services/llm-gateway/node_modules/llm-kit/other.d.ts", "export interface Usage { tokens: string }\n");
        write("services/llm-gateway/node_modules/llm-kit/package.json", `{ "name": "llm-kit", "types": "other.d.ts" }\n`);

        const second = emitLlmGateway();

        expect(second).not.toBe(first);
        expect(second?.[join("services", "llmGateway", "src", "index.d.ts")]).toBeDefined();
    });

    it("reuses a service's declaration snapshot until a file in its program changes", () => {
        expect.assertions(3);

        writeServices();

        const first = emitLlmGateway();

        expect(emitLlmGateway()).toBe(first);

        write(
            "services/llm-gateway/src/index.ts",
            `export class Gateway {\n    async complete(prompt: string): Promise<number> {\n        return prompt.length;\n    }\n}\n`,
        );

        const second = emitLlmGateway();

        expect(second).not.toBe(first);
        expect(second?.[join("services", "llmGateway", "src", "index.d.ts")]).toContain("Promise<number>");
    });

    it("names the service when TypeScript emits no declaration for its entry", () => {
        expect.assertions(1);

        writeServices();
        // A `.js` entry without `allowJs` is not compiled, so there is nothing for server.ts to import.
        write("services/llm-gateway/wrangler.jsonc", `{ "name": "neore-llm-gateway", "main": "src/index.js" }\n`);
        write("services/llm-gateway/src/index.js", `export class Gateway {}\n`);

        expect(() => runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] })).toThrow(/service "llmGateway": TypeScript emitted no declaration/u);
    });

    it("binds a named entrypoint declared rpc: false as a fetcher, without importing the service's sources", () => {
        expect.assertions(5);

        writeServices();
        write("lunora.config.ts", `export default { services: { llmGateway: { dir: "./services/llm-gateway", entrypoint: "InternalApi", rpc: false } } };\n`);
        runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] });

        const server = generated("server.ts");
        const [service] = resolveServiceBindings(workdir);

        // #929: the RPC import made every consumer of _generated type-check the service.
        expect(server).not.toContain("lunoraService_llmGateway");
        expect(server).toContain("readonly llmGateway: ServiceFetcher;");
        expect(generated("shard.ts")).toContain(`{ binding: "SERVICE_LLM_GATEWAY", name: "llmGateway" }`);
        // The binding still targets the named entrypoint; nothing is typed from it.
        expect(service).toMatchObject({ entrypoint: "InternalApi" });
        expect(service).not.toHaveProperty("rpcEntrypoint");
    });

    it.each([
        ["rpc: true", `{ dir: "./services/parser", entrypoint: "Parser", rpc: true }`],
        ["a non-literal rpc", `{ dir: "./services/parser", rpc: rpcFlag }`],
    ])("treats %s as an unreadable declaration (only rpc: false means anything)", (_label, declaration) => {
        expect.assertions(1);

        writeServices();
        write("lunora.config.ts", `const rpcFlag = false;\nexport default { services: { parser: ${declaration} } };\n`);

        expect(() => resolveServiceBindings(workdir)).toThrow(/must be an inline object/u);
    });

    it("draws a service node and an invoke edge in the architecture manifest", () => {
        expect.assertions(3);

        writeServices();
        write("lunora/chat/module.ts", `import { defineModule } from "@lunora/server";\n\nexport default defineModule({});\n`);
        write(
            "lunora/chat/ask.ts",
            `import { action, v } from "@lunora/server";

export const ask = action({
    args: { prompt: v.string() },
    handler: async (ctx, args) => ctx.services.llmGateway.complete(args.prompt),
});

export const parse = action({
    args: {},
    handler: async (ctx) => {
        const client = { fetch: ctx.services.parser.fetch };

        return client.fetch("https://parser/");
    },
});
`,
        );
        runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] });

        const { edges, nodes } = JSON.parse(generated("architecture.json")) as ArchitectureManifest;

        expect(nodes).toContainEqual({ detail: "rpc · Gateway", id: "service:llmGateway", kind: "service", name: "neore-llm-gateway" });
        expect(edges).toContainEqual({ from: "function:chat_ask:ask", kind: "invoke", to: "service:llmGateway" });
        // A fetch handed to a client is still a use of the service.
        expect(edges).toContainEqual({ from: "function:chat_ask:parse", kind: "invoke", to: "service:parser" });
    });

    it("omits ctx.services on a target that rates services unsupported", () => {
        expect.assertions(2);

        writeServices();
        write("lunora.config.ts", `export default { target: "node", services: { parser: { dir: "./services/parser" } } };\n`);

        const result = runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] });

        expect(generated("server.ts")).not.toContain("LunoraServices");
        expect(result.platformDiagnostics.map((diagnostic) => diagnostic.name)).toContain("platform_unsupported_feature");
    });

    it("maps an .mts service entry to .mjs and records env Worker names and public scopes", () => {
        expect.assertions(3);

        writeServices();
        write(
            "services/llm-gateway/wrangler.jsonc",
            `{ "name": "neore-llm-gateway", "main": "src/index.mts", "routes": ["llm.example.com/*"], "env": { "staging": { "name": "gw-staging", "routes": [], "workers_dev": true } } }\n`,
        );
        write("services/llm-gateway/src/index.mts", `export class Gateway {\n    complete(prompt: string): string {\n        return prompt;\n    }\n}\n`);
        runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] });

        expect(generated("server.ts")).toContain(`from "./services/llmGateway/src/index.mjs";`);
        expect(generated("shard.ts")).toContain(`{ binding: "SERVICE_LLM_GATEWAY", name: "llmGateway", rpc: true }`);
        // Routed at the top level, but `staging` clears the routes and turns workers.dev back on.
        expect(resolveServiceBindings(workdir).find((service) => service.name === "llmGateway")).toMatchObject({
            envWorkers: { staging: "gw-staging" },
            publicScopes: ["staging"],
        });
    });

    it.each([
        [`{ services: { "not-an-id": { dir: "./services/parser" } } }`, /must be an identifier/u],
        [`{ services: { parser: { dir: "./services/missing" } } }`, /has no wrangler\.jsonc/u],
        [`{ services: { parser: { dir: "./services/parser", entrypoint: "bad name" } } }`, /must name an exported WorkerEntrypoint/u],
        [`{ services: { ...shared } }`, /must be an inline object/u],
        [`{ services: { ["par" + "ser"]: { dir: "./services/parser" } } }`, /must be an inline object/u],
        [`{ services: { parser: { ...shared, dir: "./services/parser" } } }`, /must be an inline object/u],
        [`{ services: { docParser: { dir: "./services/parser" }, doc_parser: { dir: "./services/parser" } } }`, /both map to the binding SERVICE_DOC_PARSER/u],
    ])("rejects %s", (config, message) => {
        expect.assertions(1);

        writeServices();
        write("lunora.config.ts", `const shared = {};\nexport default ${config};\n`);

        expect(() => runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] })).toThrow(message);
    });

    it("rejects a service whose wrangler config names no Worker", () => {
        expect.assertions(1);

        writeServices();
        write("services/parser/wrangler.jsonc", `{ "main": "src/index.ts" }\n`);

        expect(() => runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] })).toThrow(/declares no Worker "name"/u);
    });
});
