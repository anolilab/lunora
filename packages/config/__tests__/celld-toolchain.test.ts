import { describe, expect, it } from "vitest";

import type { CelldCommandRunner } from "../src/celld/celld-toolchain";
import { probeCelldToolchain } from "../src/celld/celld-toolchain";

/** A runner for the given tools: each present one answers with the version it reports, the others are not on PATH. */
const tools =
    (present: Record<string, string>): CelldCommandRunner =>
    async (command) =>
        command in present ? { code: 0, stdout: present[command] ?? "" } : undefined;

const ALL = { celld: "celld 0.6.1\n", esbuild: "0.25.0\n" };

const errorsOf = async (options: Parameters<typeof probeCelldToolchain>[0]): Promise<string[]> => {
    const probe = await probeCelldToolchain(options);

    return probe.errors;
};
const BUCKET = { CELLD_BUCKET: "s3://fleet" };

describe("probeCelldToolchain", () => {
    it("finds nothing wrong for a deploy with celld, esbuild and a bucket", async () => {
        expect.assertions(1);

        await expect(probeCelldToolchain({ env: BUCKET, purpose: "deploy", run: tools(ALL) })).resolves.toStrictEqual({ errors: [], warnings: [] });
    });

    it("errors when celld is not on PATH, for a dev session as for a deploy", async () => {
        expect.assertions(2);

        const dev = await probeCelldToolchain({ purpose: "dev", run: tools({}) });

        expect(dev.errors).toStrictEqual([expect.stringMatching(/celld is not on PATH/u)]);
        await expect(probeCelldToolchain({ env: BUCKET, purpose: "deploy", run: tools({ esbuild: "0.25.0" }) })).resolves.toMatchObject({
            errors: [expect.stringMatching(/celld is not on PATH/u)],
        });
    });

    it("errors on a deploy without esbuild, but a dev session does not need it", async () => {
        expect.assertions(2);

        await expect(errorsOf({ env: BUCKET, purpose: "deploy", run: tools({ celld: "celld 0.6.1" }) })).resolves.toStrictEqual([
            expect.stringMatching(/esbuild is not on PATH/u),
        ]);
        await expect(errorsOf({ purpose: "dev", run: tools({ celld: "celld 0.6.1" }) })).resolves.toStrictEqual([]);
    });

    it("errors on a live deploy with no CELLD_BUCKET, but not on a dry run", async () => {
        expect.assertions(2);

        await expect(errorsOf({ env: {}, purpose: "deploy", run: tools(ALL) })).resolves.toStrictEqual([expect.stringMatching(/CELLD_BUCKET is not set/u)]);
        await expect(errorsOf({ dryRun: true, env: {}, purpose: "deploy", run: tools(ALL) })).resolves.toStrictEqual([]);
    });

    it("warns, without erroring, when celld is older than the version the matrix is rated against", async () => {
        expect.assertions(2);

        const old = await probeCelldToolchain({ env: BUCKET, purpose: "deploy", run: tools({ ...ALL, celld: "celld 0.5.1" }) });

        expect(old.errors).toStrictEqual([]);
        expect(old.warnings).toStrictEqual([expect.stringMatching(/celld 0\.5\.1 is older than 0\.6\.1/u)]);
    });

    it("compares minor and patch versions, not only the major", async () => {
        expect.assertions(1);

        const result = await probeCelldToolchain({ purpose: "dev", run: tools({ celld: "celld 0.6.0" }) });

        expect(result.warnings).toStrictEqual([expect.stringMatching(/celld 0\.6\.0 is older/u)]);
    });
});
