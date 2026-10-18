import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCodegen } from "../src/run-codegen";

const LIVE_STREAM = `import { defineLiveStream } from "@lunora/server";\n\nexport const posts = defineLiveStream({ id: "posts" });\n`;

const DELIVERY_AUTHORIZATION = `import { defineApp } from "./_generated/app";\n\nexport const app = defineApp().deliveryAuthorization(() => async () => undefined).build();\n`;

const DIAGNOSTIC = "platform_live_stream_delivery_authorization";

describe("live streams with delivery authorization, through runCodegen", () => {
    const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "simple");
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-live-delivery-auth-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const flagged = (files: Record<string, string>): string[] => {
        for (const [name, source] of Object.entries(files)) {
            writeFileSync(join(workdir, "lunora", name), source, "utf8");
        }

        return runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] })
            .platformDiagnostics.filter((diagnostic) => diagnostic.name === DIAGNOSTIC)
            .map((diagnostic) => diagnostic.level);
    };

    it("refuses a defineLiveStream declared alongside delivery authorization", () => {
        expect.assertions(1);

        expect(flagged({ "app-auth.ts": DELIVERY_AUTHORIZATION, "live-posts.ts": LIVE_STREAM })).toStrictEqual(["error"]);
    });

    it("passes a defineLiveStream on its own", () => {
        expect.assertions(1);

        expect(flagged({ "live-posts.ts": LIVE_STREAM })).toStrictEqual([]);
    });

    it("passes delivery authorization on its own", () => {
        expect.assertions(1);

        expect(flagged({ "app-auth.ts": DELIVERY_AUTHORIZATION })).toStrictEqual([]);
    });
});
