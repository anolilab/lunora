import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverFunctions from "../../src/discover/functions";
import { emitFunctions } from "../../src/emit";

/**
 * Discovery of the two lifecycle factories this branch added: `onShardInit` and
 * `onQueryChange`.
 *
 * A factory the discoverer does not recognise still registers as *something* —
 * it just never lands in `LUNORA_LIFECYCLE_HOOKS`, so the shard has an empty
 * manifest and simply never dispatches it. Nothing throws, nothing type-errors,
 * and the symptom is a hook that "doesn't work": memory tables that stay empty,
 * or a reactor that never fires. So each case asserts the discovered tag AND that
 * the path reaches the emitted manifest, since the manifest is what the runtime
 * actually reads.
 */
let workdir: string;

const manifestFor = (functions: ReturnType<typeof discoverFunctions>): string => {
    const emitted = emitFunctions({ functions });
    const start = emitted.indexOf("export const LUNORA_LIFECYCLE_HOOKS");

    return emitted.slice(start, emitted.indexOf("};", start));
};

describe("discoverFunctions — lifecycle factories", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-lifecycle-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const writeFunction = (relative: string, source: string): void => {
        const full = join(workdir, relative);

        mkdirSync(full.slice(0, Math.max(0, full.lastIndexOf("/"))), { recursive: true });
        writeFileSync(full, source);
    };

    const discover = (): ReturnType<typeof discoverFunctions> =>
        discoverFunctions(new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false }), workdir);

    it("tags an onShardInit export as an internal `init` mutation", () => {
        expect.assertions(4);

        writeFunction(
            "init.ts",
            `
            import { onShardInit } from "@lunora/server";
            export const warm = onShardInit(async () => undefined);
        `,
        );

        const [warm] = discover();

        expect(warm?.lifecycle).toBe("init");
        // A client must never be able to invoke an init hook by path.
        expect(warm?.visibility).toBe("internal");
        expect(warm?.kind).toBe("mutation");
        expect(manifestFor(discover())).toContain('init: ["init:warm"]');
    });

    it("tags an onQueryChange export as an internal `reactor` mutation", () => {
        expect.assertions(3);

        writeFunction(
            "reactors.ts",
            `
            import { onQueryChange } from "@lunora/server";
            export const dispatch = onQueryChange(() => [], async () => undefined);
        `,
        );

        const [dispatch] = discover();

        expect(dispatch?.lifecycle).toBe("reactor");
        expect(dispatch?.visibility).toBe("internal");
        expect(manifestFor(discover())).toContain('reactor: ["reactors:dispatch"]');
    });

    it("keeps the four lifecycle moments in separate manifest buckets", () => {
        expect.assertions(4);

        writeFunction(
            "hooks.ts",
            `
            import { onConnect, onDisconnect, onQueryChange, onShardInit } from "@lunora/server";
            export const joined = onConnect(async () => undefined);
            export const left = onDisconnect(async () => undefined);
            export const warm = onShardInit(async () => undefined);
            export const react = onQueryChange(() => [], async () => undefined);
        `,
        );

        const manifest = manifestFor(discover());

        // The buckets drive different dispatch paths — per socket, per instance,
        // per write flush — so a hook landing in the wrong one runs at the wrong
        // time rather than not at all, which is harder to spot.
        expect(manifest).toContain('connect: ["hooks:joined"]');
        expect(manifest).toContain('disconnect: ["hooks:left"]');
        expect(manifest).toContain('init: ["hooks:warm"]');
        expect(manifest).toContain('reactor: ["hooks:react"]');
    });

    it("emits empty buckets when no lifecycle hook is declared", () => {
        expect.assertions(2);

        writeFunction(
            "todos.ts",
            `
            import { query } from "@lunora/server";
            export const list = query({ args: {}, handler: () => null });
        `,
        );

        const manifest = manifestFor(discover());

        // An ordinary function must not leak into any bucket — the shard would
        // dispatch it on every flush or every cold start.
        expect(manifest).toContain("init: []");
        expect(manifest).toContain("reactor: []");
    });

    it("keeps lifecycle hooks out of the compiled-argument fast path", () => {
        expect.assertions(1);

        writeFunction(
            "init.ts",
            `
            import { onShardInit } from "@lunora/server";
            export const warm = onShardInit(async () => undefined);
        `,
        );

        // The framework supplies a hook's argument, not a caller, so there is no
        // user-declared validator to compile — and attempting it would install a
        // parser over a shape the app never wrote.
        expect(emitFunctions({ functions: discover() })).not.toContain("installCompiledValidatorMap(lunora_init_0.warm.args");
    });
});
