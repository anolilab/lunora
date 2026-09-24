import { describe, expect, it } from "vitest";

import { readDeployInfo } from "../src/settings";

/**
 * `readDeployInfo` is reached two ways, and only one of them normalises its
 * input. `buildSettings` coerces its own `unknown` env with `?? {}` before
 * calling here; `ShardDO` does not — it types `env` as `unknown`, stores it
 * as-is, and reaches this through an `as` cast on the request-log write path.
 *
 * So a host that constructs a shard without an env used to land on `env[key]`
 * of `undefined`. A throw there loses the log line for every request, in order
 * to report a deploy id that was never going to be there.
 */
describe(readDeployInfo, () => {
    it.each([
        ["undefined", undefined],
        ["null", null],
    ])("answers empty rather than throwing when env is %s", (_label, env) => {
        expect.assertions(2);

        expect(() => readDeployInfo(env)).not.toThrow();
        expect(readDeployInfo(env)).toStrictEqual({});
    });

    it("still reads the version-metadata binding when env is present", () => {
        expect.assertions(1);

        expect(readDeployInfo({ CF_VERSION_METADATA: { id: "dep_1", tag: "v3" } })).toMatchObject({ deploymentId: "dep_1", versionTag: "v3" });
    });
});
