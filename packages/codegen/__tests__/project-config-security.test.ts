import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitApp } from "../src/emit-app";
import { readProjectConfigLiterals, readProjectSecurityHeaders } from "../src/project-config-file";
import baseOptions from "./emit-app-options";

describe("security.headers in lunora.config", () => {
    let projectRoot: string;

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-security-config-"));
        mkdirSync(join(projectRoot, "lunora"));
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
        vi.restoreAllMocks();
    });

    const writeConfig = (body: string): void => {
        writeFileSync(join(projectRoot, "lunora.config.ts"), `export default ${body};\n`, "utf8");
    };

    it.each([
        [
            '{ security: { headers: { crossOriginOpenerPolicy: "same-origin", frameAncestors: ["https://a.example"], hsts: { maxAge: 60 } } } }',
            { headers: { crossOriginOpenerPolicy: "same-origin", frameAncestors: ["https://a.example"], hsts: { maxAge: 60 } } },
        ],
        ["{ security: { headers: false } }", { headers: false }],
        ["{ security: {} }", {}],
        ["{ security: { headers: { csp: process.env.CSP } } }", { unreadable: true }],
        ['{ security: { headers: { ...base, csp: "x" } } }', { unreadable: true }],
        ["{ get security() { return {}; } }", { unreadable: true }],
    ])("reads %s", (body, expected) => {
        expect.assertions(1);

        writeConfig(body);

        expect(readProjectConfigLiterals(projectRoot).security).toStrictEqual(expected);
    });

    it("reads a `__proto__` key as unreadable rather than copying it into the generated worker", () => {
        expect.assertions(1);

        writeConfig('{ security: { headers: { __proto__: { csp: "x" } } } }');

        expect(readProjectConfigLiterals(projectRoot).security).toStrictEqual({ unreadable: true });
    });

    it.each([
        ["{ security: { headers: { csp: process.env.CSP } } }", "not built from literals"],
        ['{ security: { headers: { frameAncestors: ["https://a.example\'; script-src *"] } } }', "is not an origin"],
        [String.raw`{ security: { headers: { permissionsPolicy: "a=()\nX-Evil: 1" } } }`, "line break"],
        ['{ security: { headers: { frameOption: "DENY" } } }', "security.headers.frameOption is not an option"],
        ['{ security: { headers: { hsts: { maxAge: "x" } } } }', "hsts.maxAge must be a whole number"],
        ['{ security: { headers: { frameOptions: "ALLOW" } } }', "frameOptions must be one of"],
        ['{ security: { headers: { frameAncestors: "https://a.example" } } }', "frameAncestors must be an array"],
        ["{ security: { headers: [] } }", "must be a boolean or an object"],
    ])("falls back to the defaults, saying why, for %s", (body, reason) => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        writeConfig(body);

        expect(readProjectSecurityHeaders(join(projectRoot, "lunora"))).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(reason));
    });
});

describe("emitApp — security.headers", () => {
    it("emits undefined when the config sets none, leaving the runtime its defaults", () => {
        expect.assertions(1);

        expect(emitApp(baseOptions)).toContain('const LUNORA_SECURITY_HEADERS: SecurityOptions["headers"] = undefined;');
    });

    it("emits the config's value and applies it only when code set no security.headers", () => {
        expect.assertions(3);

        const output = emitApp({ ...baseOptions, securityHeaders: { crossOriginOpenerPolicy: "unsafe-none" } });

        expect(output).toContain('const LUNORA_SECURITY_HEADERS: SecurityOptions["headers"] = {"crossOriginOpenerPolicy":"unsafe-none"};');
        expect(output).toContain("if (LUNORA_SECURITY_HEADERS !== undefined && options.security?.headers === undefined) {");
        expect(output).toContain("export { AppBuilder, defineApp, LUNORA_SECURITY_HEADERS };");
    });
});
