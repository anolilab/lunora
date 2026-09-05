import { describe, expect, it } from "vitest";

import CLOUDFLARE_DRIVER from "../src/cloudflare/cloudflare-driver";

describe("cLOUDFLARE_DRIVER", () => {
    it("identifies itself as the cloudflare target", () => {
        expect.assertions(1);

        expect(CLOUDFLARE_DRIVER.id).toBe("cloudflare");
    });
});

describe("cLOUDFLARE_DRIVER toolchain", () => {
    const { toolchain } = CLOUDFLARE_DRIVER;

    it("builds the deploy argv, matching wrangler's expected flag order", () => {
        expect.assertions(2);

        expect(toolchain?.deploy({})).toStrictEqual({ args: ["deploy"], tool: "wrangler" });
        // Entry positional precedes flags; `--metafile` always rides with `--outdir`.
        expect(toolchain?.deploy({ dryRun: true, entry: "src/worker.ts", environment: "prod", outDir: "dist", temporary: true }).args).toStrictEqual([
            "deploy",
            "src/worker.ts",
            "--env",
            "prod",
            "--temporary",
            "--dry-run",
            "--outdir",
            "dist",
            "--metafile",
        ]);
    });

    // A preview must never take production traffic, so it maps to a different
    // wrangler subcommand rather than a flag on `deploy`.
    it("maps a preview deploy onto versions upload", () => {
        expect.assertions(1);

        expect(toolchain?.deploy({ preview: true }).args).toStrictEqual(["versions", "upload"]);
    });

    it("builds tail argv with the worker positional before flags", () => {
        expect.assertions(1);

        expect(toolchain?.tail({ environment: "prod", format: "json", search: "boom", status: "error", worker: "api" }).args).toStrictEqual([
            "tail",
            "api",
            "--env",
            "prod",
            "--format",
            "json",
            "--status",
            "error",
            "--search",
            "boom",
        ]);
    });

    // The value is never in argv — it goes over stdin — so only the key appears.
    it("builds secret argv without ever placing a value on the command line", () => {
        expect.assertions(2);

        const put = toolchain?.secretPut({ environment: "prod", key: "STRIPE_KEY" });

        expect(put?.args).toStrictEqual(["secret", "put", "STRIPE_KEY", "--env", "prod"]);
        expect(toolchain?.secretList({}).args).toStrictEqual(["secret", "list", "--format", "json"]);
    });

    it("builds dev argv with the generated config and caller flags", () => {
        expect.assertions(1);

        expect(toolchain?.dev({ configPath: "wrangler.dev.jsonc", extraArgs: ["--var", "X:1"] }).args).toStrictEqual([
            "dev",
            "--config",
            "wrangler.dev.jsonc",
            "--var",
            "X:1",
        ]);
    });
});
