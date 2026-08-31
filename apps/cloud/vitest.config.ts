import { coverageConfigDefaults, defineConfig } from "vitest/config";

/**
 * Coverage is declared here, and `package.json` carries the matching
 * `test:coverage` script, because without BOTH this app is absent from the
 * repo's coverage gate entirely.
 *
 * CI's Codecov leg runs `vis affected test:coverage`, and vis synthesizes no
 * target for a project that declares no such script — so the largest unit in the
 * repo, holding billing/metering, deploy-key auth, secret encryption and tenant
 * dispatch, contributed nothing to coverage while `codecov.yml`'s non-informational
 * `patch: 75%` gate passed vacuously on every PR that touched only this app. The
 * tests always ran; only the measurement was missing, which is the worse failure
 * because it looks like success.
 *
 * `lunora/_generated` and the vendored shadcn primitives are excluded: neither is
 * hand-written, and including them moves the percentage without moving the risk.
 */
export default defineConfig({
    test: {
        coverage: {
            ...coverageConfigDefaults,
            exclude: [
                ...(coverageConfigDefaults.exclude ?? []),
                "**/_generated/**",
                "src/components/ui/**",
                "src/routeTree.gen.ts",
                "**/node_modules/**",
                "**/dist/**",
            ],
            include: ["src", "lunora"],
            provider: "v8" as const,
            reporter: ["clover", "cobertura", "lcov", "text"],
        },
        environment: "node",
    },
});
