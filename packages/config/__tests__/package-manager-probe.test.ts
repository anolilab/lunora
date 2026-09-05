/**
 * The default "is this manager installed?" probe, isolated in its own file
 * because it needs `node:child_process` mocked — which the sibling suite's
 * `detectPackageManager` test deliberately does not want (it resolves the real
 * pnpm on this machine).
 */
import type { spawnSync as SpawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.fn<typeof SpawnSync>(() => ({ status: 0 }) as ReturnType<typeof SpawnSync>);

vi.mock(import("node:child_process"), () => {
    return { spawnSync };
});

const { detectInstalledManagers } = await import("../src/package-manager");

describe("the default package-manager probe", () => {
    afterEach(() => {
        spawnSync.mockClear();
    });

    it("spawns each manager through a shell on Windows, where they are .cmd shims", () => {
        expect.assertions(5);

        // Since Node's CVE-2024-27980 hardening, `spawn`/`spawnSync` cannot start a
        // `.cmd` shim directly — and every package-manager CLI on Windows is one.
        // Without `shell`, the probe threw for all four managers and the catch
        // reported `false`: `detectInstalledManagers()` was ALWAYS `[]`, so `init`
        // silently skipped the install prompt and `detectPackageManager` threw for
        // a fresh directory. The repo states the hazard and this exact fix twice in
        // siblings (`post-codegen-hook.ts`, the CLI's `spawn.ts`).
        detectInstalledManagers();

        expect(spawnSync).toHaveBeenCalledTimes(4);

        // Asserted against this platform's own answer rather than a hardcoded
        // `true`: the point is that the option is COMPUTED from the platform at
        // all. It was absent entirely.
        for (const call of spawnSync.mock.calls as unknown as ReadonlyArray<[string, string[], Record<string, unknown>]>) {
            expect(call[2]).toHaveProperty("shell", process.platform === "win32");
        }
    });
});
