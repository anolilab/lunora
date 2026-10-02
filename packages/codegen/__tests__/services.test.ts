import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ArchitectureManifest } from "../../../shared/architecture-manifest";
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

        runCodegen({ projectRoot: workdir });

        expect(generated("server.ts")).not.toContain("LunoraServices");
        expect(generated("shard.ts")).not.toContain("LUNORA_SERVICES");
    });

    it("types ctx.services on actions only and wires each binding into the shard", () => {
        expect.assertions(6);

        writeServices();
        runCodegen({ projectRoot: workdir });

        const server = generated("server.ts");
        const shard = generated("shard.ts");

        expect(server).toContain(`import type * as lunoraService_llmGateway from "../../services/llm-gateway/src/index.js";`);
        expect(server).toContain("readonly llmGateway: ServiceRpc<typeof lunoraService_llmGateway.Gateway>;");
        expect(server).toContain("readonly parser: ServiceFetcher;");
        expect(server.match(/readonly services: LunoraServices;/gu)).toHaveLength(1);
        expect(shard).toContain(`{ binding: "SERVICE_LLM_GATEWAY", name: "llmGateway", rpc: true }`);
        expect(shard).toContain(`{ binding: "SERVICE_PARSER", name: "parser" }`);
    });

    it("binds a named entrypoint declared rpc: false as a fetcher, without importing the service's sources", () => {
        expect.assertions(5);

        writeServices();
        write("lunora.config.ts", `export default { services: { llmGateway: { dir: "./services/llm-gateway", entrypoint: "InternalApi", rpc: false } } };\n`);
        runCodegen({ projectRoot: workdir });

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
        runCodegen({ projectRoot: workdir });

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

        const result = runCodegen({ projectRoot: workdir });

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
        runCodegen({ projectRoot: workdir });

        expect(generated("server.ts")).toContain(`from "../../services/llm-gateway/src/index.mjs";`);
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

        expect(() => runCodegen({ projectRoot: workdir })).toThrow(message);
    });

    it("rejects a service whose wrangler config names no Worker", () => {
        expect.assertions(1);

        writeServices();
        write("services/parser/wrangler.jsonc", `{ "main": "src/index.ts" }\n`);

        expect(() => runCodegen({ projectRoot: workdir })).toThrow(/declares no Worker "name"/u);
    });
});
