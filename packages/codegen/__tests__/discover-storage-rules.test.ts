import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverStorageRulesMetadata from "../src/discover-storage-rules";

// A self-contained branded builder + storage-rules DSL, mirroring the RLS
// metadata test's inline preamble (the isolated project has no workspace
// resolution). `.use` returns the same builder so `.use(storageRules(...)).action(...)`
// type-checks and the chain walk finds the `storageRules(...)` call.
const PREAMBLE = `
    interface StorageRule { bucket: string; on: string; prefix?: string; when: (context: unknown) => unknown }
    declare const storageRules: (rules: StorageRule[], options?: { roles?: unknown[] }) => (options: { ctx: unknown }) => unknown;
    declare const action: <R>(config: { args: Record<string, unknown>; handler: (ctx: unknown) => R }) => { kind: "action" };

    interface ActionBuilder<Args> {
        readonly __cirrusProcedure: "action";
        use: <C>(middleware: (options: { ctx: unknown }) => C) => ActionBuilder<Args>;
        action: <R>(handler: (options: { args: Args; ctx: unknown }) => R) => { kind: "action" };
    }

    declare const c: { action: ActionBuilder<Record<never, never>> };
`;

const AVATARS = `${PREAMBLE}
    export const upload = c.action
        .use(
            storageRules([
                { bucket: "avatars", on: "read", prefix: "user/", when: () => true },
                { bucket: "avatars", on: "write", prefix: "user/", when: () => true },
                { bucket: "avatars", on: "delete", when: () => true },
            ]),
        )
        .action(() => null);

    // A bare-factory procedure — no builder chain, so it contributes nothing.
    export const peek = action({ args: {}, handler: () => null });
`;

let workdir: string;
let project: Project;

describe("discoverStorageRulesMetadata", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-storage-rules-"));
        mkdirSync(join(workdir, "cirrus"), { recursive: true });
        writeFileSync(join(workdir, "cirrus", "avatars.ts"), AVATARS, "utf8");
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("extracts each rule's bucket + operation + prefix and the declaring procedure", () => {
        expect.assertions(3);

        const { rules } = discoverStorageRulesMetadata(project, join(workdir, "cirrus"));

        expect(rules).toContainEqual({ bucket: "avatars", file: "avatars", on: "read", prefix: "user/", procedure: "upload" });
        expect(rules).toContainEqual({ bucket: "avatars", file: "avatars", on: "write", prefix: "user/", procedure: "upload" });
        // A rule with no prefix omits the key entirely.
        expect(rules).toContainEqual({ bucket: "avatars", file: "avatars", on: "delete", procedure: "upload" });
    });

    it("ignores bare-factory procedures and non-storageRules chains", () => {
        expect.assertions(1);

        const { rules } = discoverStorageRulesMetadata(project, join(workdir, "cirrus"));

        expect(rules.some((rule) => rule.procedure === "peek")).toBe(false);
    });
});
