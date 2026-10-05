import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    buildPage,
    CLOUD_DOCS_DIR,
    CONTRACT_PATH,
    markerEnd,
    markerStart,
    MODULE_SOURCES,
    PAGES,
    readContract,
    targetCapabilitiesTable,
} from "../scripts/generate-target-capabilities";

const contractSource = readFileSync(CONTRACT_PATH, "utf8");
const contract = readContract(contractSource);

const pageSource = (file: string): string => readFileSync(path.join(CLOUD_DOCS_DIR, file), "utf8");

/** A deep copy, so a test can edit the contract without touching the shared one. */
const cloneContract = (): typeof contract => structuredClone(contract);

describe("generated target capability tables", () => {
    it.each(PAGES.map((page) => [page.file, page] as const))("%s matches the provisioning contract", async (file, page) => {
        expect.assertions(1);

        const source = pageSource(file);

        // This equality IS the gate: `generate-target-capabilities.js --check` compares exactly these two.
        await expect(buildPage(page, source, contract)).resolves.toBe(source);
    });

    it.each(["celld-vps", "cloudflare-workers"])("lists every binding type %s is rated for", (target) => {
        expect.assertions(2);

        const types = Object.keys(contract.bindingSupport[target]);
        const table = targetCapabilitiesTable(contract, target);

        expect(types.filter((type) => !table.includes(`\`${type}\``))).toStrictEqual([]);
        // Guards the guard: an empty table would satisfy the line above.
        expect(types.length).toBeGreaterThan(10);
    });

    it("keeps the hand-written prose outside the generated blocks", () => {
        expect.assertions(2);

        const server = pageSource("your-own-server.mdx");
        const account = pageSource("your-own-cloudflare-account.mdx");

        expect(server.slice(0, server.indexOf(markerStart("capabilities:celld-vps")))).toContain("## Requirements");
        expect(account.slice(0, account.indexOf(markerStart("cloudflare-token-permissions")))).toContain("## Connect an account");
    });
});

describe("target capability drift check", () => {
    const [serverPage] = PAGES;

    it("fails once a binding's support changes", async () => {
        expect.assertions(2);

        const edited = cloneContract();

        edited.bindingSupport["celld-vps"].ai = "bound";

        const source = pageSource(serverPage.file);
        const regenerated = await buildPage(serverPage, source, edited);

        expect(regenerated).not.toBe(source);
        expect(regenerated).toMatch(/\| Workers AI\s+\| `ai`\s+\| Yes\s+\|/u);
    });

    it("fails once a refusal reason is reworded", async () => {
        expect.assertions(1);

        const edited = cloneContract();

        edited.unsupportedReasons["celld-vps"].vectorize = "reworded by this test";

        const source = pageSource(serverPage.file);

        await expect(buildPage(serverPage, source, edited)).resolves.not.toBe(source);
    });

    it("refuses a binding type it has no label for", () => {
        expect.assertions(1);

        const edited = cloneContract();

        edited.bindingSupport["celld-vps"].zz_added_by_this_test = "bound";

        expect(() => targetCapabilitiesTable(edited, "celld-vps")).toThrow("has no label");
    });

    it("refuses a refused binding with no reason", () => {
        expect.assertions(1);

        const edited = cloneContract();

        edited.bindingSupport["celld-vps"].d1 = "unsupported";

        expect(() => targetCapabilitiesTable(edited, "celld-vps")).toThrow("no reason in UNSUPPORTED_REASONS");
    });

    it("refuses a page whose generated-block markers are gone", async () => {
        expect.assertions(1);

        await expect(buildPage(serverPage, "# no markers here\n", contract)).rejects.toThrow("missing the generated-block markers");
    });

    it("keeps each marker pair in order on the committed pages", () => {
        expect.assertions(3);

        for (const page of PAGES) {
            const source = pageSource(page.file);

            for (const block of page.blocks) {
                expect(source.indexOf(markerEnd(block.id))).toBeGreaterThan(source.indexOf(markerStart(block.id)));
            }
        }
    });
});

describe("reading the contract", () => {
    it("resolves a reference to another top-level string constant", () => {
        expect.assertions(1);

        const pitr = contract.targets["celld-vps"].limitations.find((limitation: { id: string }) => limitation.id === "pitr");

        // `TARGETS` cites `CELLD_PITR_NOTE` by name rather than inlining it.
        expect(pitr?.reason).toContain("PITR_UNAVAILABLE");
    });

    it("refuses a constant it cannot evaluate statically", () => {
        expect.assertions(1);

        const source = contractSource.replace(/export const BINDING_SUPPORT = \{/u, "export const BINDING_SUPPORT = build() ?? {");

        expect(() => readContract(source)).toThrow("cannot evaluate");
    });

    it("takes the celld-vps row from @lunora/config's CELLD_RELEASE_BINDINGS, through its re-export", () => {
        expect.assertions(4);

        const row = contract.bindingSupport["celld-vps"];

        expect(row).toMatchObject({ ai: "unsupported", d1: "provisioned", durable_object: "bound", kv: "provisioned" });

        // The row follows the config package's source, not a copy of it.
        const edited = readContract(contractSource, (filePath) => {
            const text = readFileSync(filePath, "utf8");

            return filePath.endsWith("release-config.ts") ? text.replace('kv: "provisioned",', 'kv: "bound",') : text;
        });

        expect(edited.bindingSupport["celld-vps"].kv).toBe("bound");
        expect(edited.bindingSupport["celld-vps"].d1).toBe("provisioned");
        expect(Object.keys(MODULE_SOURCES)).toStrictEqual(["@lunora/config/celld"]);
    });

    it("refuses a value imported from a module it does not read", () => {
        expect.assertions(1);

        const source = contractSource.replace(/(import \{ CELLD_RELEASE_BINDINGS[^}]*\} from )"@lunora\/config\/celld"/u, '$1"@lunora/elsewhere"');

        expect(() => readContract(source)).toThrow('imports a value from "@lunora/elsewhere"');
    });

    it("refuses a name the imported module does not export", () => {
        expect.assertions(1);

        const source = contractSource.replace("import { CELLD_RELEASE_BINDINGS,", "import { NOT_EXPORTED_BY_CONFIG as CELLD_RELEASE_BINDINGS,");

        expect(() => readContract(source)).toThrow("does not export a constant `NOT_EXPORTED_BY_CONFIG`");
    });

    it("refuses a call it does not know", () => {
        expect.assertions(1);

        const source = contractSource.replace(/Object\.keys(?=\(CELLD_VPS_REFUSALS\))/u, "Object.entries");

        expect(() => readContract(source)).toThrow("cannot evaluate");
    });

    it("refuses a contract that no longer declares a table", () => {
        expect.assertions(1);

        expect(() => readContract(contractSource.replaceAll("CLOUDFLARE_TOKEN_PERMISSIONS", "RENAMED_BY_THIS_TEST"))).toThrow("no longer declares");
    });
});
