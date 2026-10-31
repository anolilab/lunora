import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { emitAdminRevocations } from "../src/emit";
import { runCodegen } from "../src/index";
import { makeFixtureWorkdir } from "./golden-fixtures";

describe(emitAdminRevocations, () => {
    it("forwards the class from the scoped package, for every app", () => {
        expect.assertions(2);

        const emitted = emitAdminRevocations(false);

        expect(emitted).toContain('export { AdminRevocationDO } from "@lunora/do";');
        expect(emitted).toContain("ADMIN_REVOCATIONS");
    });

    it("forwards it from the umbrella package when the project uses it", () => {
        expect.assertions(1);

        expect(emitAdminRevocations(true)).toMatch(/export \{ AdminRevocationDO \} from "lunorash[^"]*";/u);
    });
});

describe("admin revocation surface on an unsupported target", () => {
    const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ai-search");

    it.each(["node", "celld"])("emits no module and no builder method on %s, and says why", (target) => {
        expect.assertions(5);

        const workdir = makeFixtureWorkdir(fixtureRoot);

        try {
            const result = runCodegen({ lint: false, projectRoot: workdir, target, wranglerQueueProducers: [] });
            const diagnostics = result.platformDiagnostics.filter(
                (diagnostic) => diagnostic.feature === undefined && diagnostic.message.includes("named admin token"),
            );

            expect(diagnostics.map((diagnostic) => diagnostic.name)).toStrictEqual(["platform_unsupported_feature"]);
            expect(diagnostics[0]?.level).toBe("warn");
            expect(result.generated.app).not.toContain("adminRevocations");
            expect(result.generated.app).not.toContain("ADMIN_REVOCATIONS");
            expect(existsSync(join(workdir, "lunora", "_generated", "adminRevocations.ts"))).toBe(false);
        } finally {
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("keeps the surface on the default Cloudflare target, with no diagnostic", () => {
        expect.assertions(3);

        const workdir = makeFixtureWorkdir(fixtureRoot);

        try {
            const result = runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });

            expect(result.generated.app).toContain("public adminRevocations(");
            expect(existsSync(join(workdir, "lunora", "_generated", "adminRevocations.ts"))).toBe(true);
            expect(result.platformDiagnostics.some((diagnostic) => diagnostic.message.includes("named admin token"))).toBe(false);
        } finally {
            rmSync(workdir, { force: true, recursive: true });
        }
    });
});
