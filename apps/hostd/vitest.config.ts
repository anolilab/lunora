import { configDefaults } from "vitest/config";

import { getVitestConfig } from "../../tools/get-vitest-config";

const INTEGRATION_TESTS = ["__tests__/integration/**/*.test.ts"];

/**
 * `unit` always runs. `integration` — the `test:hostd` lane: the built daemon
 * against real celld, real Caddy (with `caddy-ratelimit`), an S3-compatible
 * bucket and an in-process fake control plane (`__tests__/integration/`) — is
 * gated behind `LUNORA_HOSTD_TESTS=1`, like the `celld` and `workerd` lanes:
 * it needs those binaries and unrestricted loopback, which a sandboxed runner
 * has not, and the code under test runs in other processes, so it adds no
 * coverage. With `LUNORA_HOSTD_ISOLATION=1` as well (root, systemd) it sets
 * the box up with install.sh's own functions, runs hostd under the real unit,
 * and probes the isolation. Run it with `pnpm run test:hostd`; the variables
 * it reads are listed in `__tests__/integration/lane.ts`.
 */
const runIntegration = process.env["LUNORA_HOSTD_TESTS"] === "1";

const unit = {
    extends: true,
    test: {
        exclude: [...configDefaults.exclude, ...INTEGRATION_TESTS],
        name: "unit",
    },
};

const integration = {
    extends: true,
    test: {
        // celld boots, bundles and adopts a release; a usage report waits for its minute window to close.
        // `extends: true` concatenates the root `include`, so the unit files are excluded explicitly.
        exclude: [...configDefaults.exclude, "__tests__/*.test.ts", "__tests__/daemon/**"],
        hookTimeout: 180_000,
        include: INTEGRATION_TESTS,
        name: "integration",
        testTimeout: 180_000,
    },
};

export default getVitestConfig({ test: { environment: "node", projects: runIntegration ? [unit, integration] : [unit] } });
