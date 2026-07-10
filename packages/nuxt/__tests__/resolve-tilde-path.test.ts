import { describe, expect, it } from "vitest";

import { resolveTildePath } from "../src/resolve-tilde-path";

// `resolveTildePath` produces the absolute `#lunora/app` alias target. Nitro
// re-resolves a NON-absolute alias against its own `server/` srcDir, so any
// specifier the module hands it must already be absolute — tildes AND relative
// (`./`, `../`) app-entry paths, which are otherwise left untouched and hit the
// exact "Cannot resolve" Nitro failure this helper exists to prevent.
describe("resolveTildePath", () => {
    const rootDir = "/project";
    const srcDir = "/project/app";

    it("expands `~~/` against the rootDir", () => {
        expect.assertions(1);

        expect(resolveTildePath("~~/lunora/server", rootDir, srcDir)).toBe("/project/lunora/server");
    });

    it("expands `~/` against the srcDir", () => {
        expect.assertions(1);

        expect(resolveTildePath("~/lunora/server", rootDir, srcDir)).toBe("/project/app/lunora/server");
    });

    it("resolves a `./` relative specifier against the rootDir", () => {
        expect.assertions(1);

        expect(resolveTildePath("./lunora/server", rootDir, srcDir)).toBe("/project/lunora/server");
    });

    it("resolves a `../` relative specifier against the rootDir", () => {
        expect.assertions(1);

        expect(resolveTildePath("../shared/lunora/server", rootDir, srcDir)).toBe("/shared/lunora/server");
    });

    it("leaves a bare package specifier untouched", () => {
        expect.assertions(1);

        expect(resolveTildePath("@acme/lunora-app", rootDir, srcDir)).toBe("@acme/lunora-app");
    });

    it("leaves an already-absolute path untouched", () => {
        expect.assertions(1);

        expect(resolveTildePath("/abs/lunora/server", rootDir, srcDir)).toBe("/abs/lunora/server");
    });
});
