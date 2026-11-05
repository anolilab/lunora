import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Node, Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";
import { loadProjectConfig, projectConfigProblems, readProjectConfigLiterals } from "../src/project-config-file";
import { runCodegen } from "../src/run-codegen";
import baseOptions from "./emit-app-options";

describe("lunora.config validation", () => {
    let projectRoot: string;
    let configPath: string;

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-config-validate-"));
        configPath = join(projectRoot, "lunora.config.ts");
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
    });

    const writeConfig = (source: string): void => {
        writeFileSync(configPath, source, "utf8");
    };

    it.each([
        "export default {};\n",
        `export default {
    advisor: { accept: [{ exportName: "list", file: "todos.ts", reason: "public feed", rule: "unauthenticated-query" }], minSeverity: "warn" },
    app: (app) => app,
    codegen: { exclude: ["seed/**"], lazyFunctions: true },
    durableObjects: { merge: false },
    remote: { kinds: ["d1"] },
    security: {
        headers: {
            crossOriginOpenerPolicy: "same-origin-allow-popups",
            csp: false,
            frameAncestors: ["https://partner.example"],
            hsts: { includeSubDomains: true, maxAge: 63072000, preload: false },
            permissionsPolicy: "camera=()",
            referrerPolicy: "no-referrer",
        },
    },
    services: { gateway: { dir: "./services/gateway", entrypoint: "Gateway", rpc: false } },
    studio: { companion: true },
    target: "cloudflare",
} satisfies LunoraConfig;\n`,
        "const config = { remote: true, app(app) { return app; } };\nexport default config;\n",
        // Computed values are the readers' to report, not this check's.
        "export default { remote: process.env.REMOTE === '1', target: process.env.TARGET };\n",
        "export type Env = { DB: string };\nexport interface Extra { a: string }\n",
        "export default { security: { headers: false } };\n",
        "export default { security: { headers: { frameOptions: 'DENY', hsts: false } } };\n",
        // `null` is "no preference", as the evaluated config reads it.
        "export default { remote: null };\n",
    ])("accepts a valid config (%#)", (source) => {
        expect.assertions(1);

        writeConfig(source);

        expect(projectConfigProblems(configPath)).toStrictEqual([]);
    });

    it("names an unknown top-level key with the closest valid one", () => {
        expect.assertions(1);

        writeConfig("export default { remot: true, target: 'cloudflare' };\n");

        expect(projectConfigProblems(configPath)).toStrictEqual([
            "unknown key `remot`. Did you mean `remote`? Valid keys: advisor, app, codegen, durableObjects, remote, security, services, studio, target.",
        ]);
    });

    it("names an unknown nested key, also inside a services entry", () => {
        expect.assertions(1);

        writeConfig("export default { codegen: { lazyFuntions: true }, services: { api: { dir: './api', entryPoint: 'Api' } } };\n");

        expect(projectConfigProblems(configPath)).toStrictEqual([
            "unknown key `codegen.lazyFuntions`. Did you mean `codegen.lazyFunctions`? Valid keys of `codegen`: exclude, lazyFunctions.",
            "unknown key `services.api.entryPoint`. Did you mean `services.api.entrypoint`? Valid keys of `services.api`: dir, entrypoint, rpc.",
        ]);
    });

    it.each([
        ['remote: "true"', '`remote` must be a boolean, got a string ("true").'],
        ["target: 1", "`target` must be a string, got a number (1)."],
        ["durableObjects: { merge: 'yes' }", "`durableObjects.merge` must be a boolean, got a string ('yes')."],
        ["app: 'app'", "`app` must be a function, got a string ('app')."],
        ["studio: true", "`studio` must be an object, got a boolean (true)."],
        ["security: { headers: 'strict' }", "`security.headers` must be a boolean or an object, got a string ('strict')."],
        [
            "security: { headers: { frameAncestors: 'https://a.example' } }",
            "`security.headers.frameAncestors` must be an array of strings, got a string ('https://a.example').",
        ],
        ["services: { api: { dir: './api', rpc: true } }", "`services.api.rpc` must be `false`, got `true`. Leave it out for an RPC binding."],
        ["security: { headers: { csp: true } }", "`security.headers.csp` must be a string or `false`, got `true`."],
        ["codegen: { exclude: ['seed/**', 1] }", "`codegen.exclude[1]` must be a string, got a number (1)."],
        ["advisor: { accept: ['rule'] }", "`advisor.accept[0]` must be an object, got a string ('rule')."],
    ])("refuses %s", (member, problem) => {
        expect.assertions(1);

        writeConfig(`export default { ${member} };\n`);

        expect(projectConfigProblems(configPath)).toStrictEqual([problem]);
    });

    it("names an unknown key inside security.headers", () => {
        expect.assertions(1);

        writeConfig("export default { security: { headers: { crossOriginOpenerPolicyy: 'same-origin' } } };\n");

        expect(projectConfigProblems(configPath)).toStrictEqual([
            "unknown key `security.headers.crossOriginOpenerPolicyy`. Did you mean `security.headers.crossOriginOpenerPolicy`? Valid keys of `security.headers`: crossOriginOpenerPolicy, csp, frameAncestors, frameOptions, hsts, permissionsPolicy, referrerPolicy.",
        ]);
    });

    it("names a key the shape's prototype has as unknown, rather than reading the prototype's member as its shape", () => {
        expect.assertions(1);

        writeConfig("export default { durableObjects: { toString: true } };\n");

        expect(projectConfigProblems(configPath)).toStrictEqual(["unknown key `durableObjects.toString`. Valid keys of `durableObjects`: merge."]);
    });

    it("follows a const to the value it names", () => {
        expect.assertions(1);

        writeConfig("const remote = 'true';\nexport default { remote };\n");

        expect(projectConfigProblems(configPath)).toStrictEqual(["`remote` must be a boolean, got a string ('true')."]);
    });

    it("names an unknown key inside an advisor.accept entry", () => {
        expect.assertions(1);

        writeConfig("export default { advisor: { accept: [{ exportName: 'a', file: 'a.ts', reason: 'r', rules: 'x' }] } };\n");

        expect(projectConfigProblems(configPath)).toStrictEqual([
            "unknown key `advisor.accept[0].rules`. Did you mean `advisor.accept[0].rule`? Valid keys of `advisor.accept[0]`: exportName, file, reason, rule.",
        ]);
    });

    it("checks the names around a spread, but not the values, which the spread may shadow (as the readers do)", () => {
        expect.assertions(1);

        writeConfig("const base = {};\nexport default { ...base, remote: 'true', traget: 'cloudflare' };\n");

        expect(projectConfigProblems(configPath)).toStrictEqual([
            "unknown key `traget`. Did you mean `target`? Valid keys: advisor, app, codegen, durableObjects, remote, security, services, studio, target.",
        ]);
    });

    it("reads `remote: null` as no preference, not as a config it cannot read", () => {
        expect.assertions(1);

        writeConfig("export default { remote: null };\n");

        expect(readProjectConfigLiterals(projectRoot)).toStrictEqual({});
    });

    it("sees an edit to the file it has already checked", () => {
        expect.assertions(2);

        writeConfig("export default { remote: true };\n");

        expect(projectConfigProblems(configPath)).toStrictEqual([]);

        writeConfig("export default { remote: 'true', studoi: {} };\n");

        expect(projectConfigProblems(configPath)).toHaveLength(2);
    });

    it("reports a config with only named exports", () => {
        expect.assertions(1);

        writeConfig("export const app = (app) => app;\nexport const target = 'cloudflare';\nexport type Env = object;\n");

        expect(projectConfigProblems(configPath)).toStrictEqual([
            "lunora.config.ts has no default export, so none of its settings are read (it exports `app`, `target`). Lunora reads only the default export: `export default { app, target } satisfies LunoraConfig`.",
        ]);
    });

    it("suggests exporting a lone settings object as the default, rather than wrapping it in an unknown key", () => {
        expect.assertions(1);

        writeConfig("export const config = { target: 'cloudflare' };\n");

        expect(projectConfigProblems(configPath)).toStrictEqual([
            "lunora.config.ts has no default export, so none of its settings are read (it exports `config`). Lunora reads only the default export: `export default config;` in place of the named export.",
        ]);
    });

    it("makes the evaluating loader report a config with only named exports, with the same fix", async () => {
        expect.assertions(2);

        writeConfig("export const settings = { remote: true };\n");

        const loaded = await loadProjectConfig(projectRoot);

        expect(loaded.config).toBeUndefined();
        expect(loaded.error).toContain(
            "has no default export, so none of its settings are read (it exports `settings`). Lunora reads only the default export: `export default settings;`",
        );
    });

    it("stops codegen on an invalid config, listing every problem", () => {
        expect.assertions(1);

        cpSync(join(import.meta.dirname, "fixtures", "simple", "lunora"), join(projectRoot, "lunora"), { recursive: true });
        writeConfig("export default { remote: 'true', studoi: {} };\n");

        expect(() => runCodegen({ projectRoot, wranglerQueueProducers: [] })).toThrow(
            /lunora\.config\.ts is invalid:\n {2}- `remote` must be a boolean[^\n]*\n {2}- unknown key `studoi`\. Did you mean `studio`\?/u,
        );
    });

    describe("keys checked against the `LunoraConfig` interface codegen emits", () => {
        /** The member names of a type literal or interface, sorted. */
        const memberNames = (node: Node | undefined): string[] => {
            if (node === undefined || (!Node.isInterfaceDeclaration(node) && !Node.isTypeLiteral(node))) {
                throw new Error(`not a type with members: ${node?.getText() ?? "undefined"}`);
            }

            return node
                .getMembers()
                .map((member) => (Node.isPropertySignature(member) ? member.getName() : member.getText()))
                .toSorted((left, right) => left.localeCompare(right));
        };

        /** The `Valid keys…` list the validator names for an unknown key at `path`. */
        const validKeys = (source: string): string[] => {
            writeConfig(source);

            const [problem] = projectConfigProblems(configPath);
            const list = /Valid keys(?: of `[^`]+`)?: (?<keys>.+)\.$/u.exec(problem ?? "")?.groups?.keys;

            if (list === undefined) {
                throw new Error(`no key list in ${String(problem)}`);
            }

            return list.split(", ").toSorted((left, right) => left.localeCompare(right));
        };

        const lunoraConfig = new Project({ useInMemoryFileSystem: true })
            .createSourceFile("app.ts", emitApp({ ...baseOptions }))
            .getInterfaceOrThrow("LunoraConfig");

        /** The type literal a `LunoraConfig` member is declared as, reaching into `ReadonlyArray<…>` and `Record<string, …>`. */
        const memberType = (name: string): Node | undefined => {
            const typeNode = lunoraConfig.getPropertyOrThrow(name).getTypeNode();

            return Node.isTypeReference(typeNode) ? typeNode.getTypeArguments().at(-1) : typeNode;
        };

        it("refuses exactly the keys the interface does not declare, at the top level", () => {
            expect.assertions(1);

            expect(validKeys("export default { zzz: 1 };\n")).toStrictEqual(memberNames(lunoraConfig));
        });

        it.each(["codegen", "durableObjects", "security", "studio"])("and inside `%s`", (section) => {
            expect.assertions(1);

            expect(validKeys(`export default { ${section}: { zzz: 1 } };\n`)).toStrictEqual(memberNames(memberType(section)));
        });

        it("and inside `advisor`, an `advisor.accept` entry and a `services` entry", () => {
            expect.assertions(3);

            const advisor = memberType("advisor");

            expect(validKeys("export default { advisor: { zzz: 1 } };\n")).toStrictEqual(memberNames(advisor));

            const accept = Node.isTypeLiteral(advisor) ? advisor.getPropertyOrThrow("accept").getTypeNode() : undefined;

            expect(validKeys("export default { advisor: { accept: [{ zzz: 1 }] } };\n")).toStrictEqual(
                memberNames(Node.isTypeReference(accept) ? accept.getTypeArguments()[0] : undefined),
            );
            expect(validKeys("export default { services: { api: { zzz: 1 } } };\n")).toStrictEqual(memberNames(memberType("services")));
        });
    });
});
