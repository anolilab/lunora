import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reconcileWranglerBindings } from "../src/cloudflare/apply-bindings";
import { inferLunoraBindings } from "../src/infer-bindings";

describe("reconcile the companion service binding", () => {
    let root: string;

    const config = (): Record<string, any> => parseJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8")) as Record<string, any>;
    const lunora = (): unknown => (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { lunora?: unknown }).lunora;

    const reconcile = async (companion: boolean): Promise<void> => {
        writeFileSync(join(root, "lunora.config.ts"), `export default { studio: { companion: ${String(companion)} } };\n`, "utf8");
        reconcileWranglerBindings(root, await inferLunoraBindings({ projectRoot: root }));
    };

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-reconcile-companion-"));
        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{ "name": "shop", "observability": { "enabled": true }, "services": [{ "binding": "LEGACY", "service": "legacy-worker" }] }\n`,
            "utf8",
        );
        writeFileSync(join(root, "package.json"), `{ "name": "app" }\n`, "utf8");
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("writes an owned ADVISOR_COMPANION entry naming <name>-advisor, and removes it when the flag goes off", async () => {
        expect.assertions(4);

        await reconcile(true);

        expect(config()["services"]).toStrictEqual([
            { binding: "LEGACY", service: "legacy-worker" },
            { binding: "ADVISOR_COMPANION", service: "shop-advisor" },
        ]);
        expect(lunora()).toStrictEqual(expect.objectContaining({ services: expect.objectContaining({ services: ["ADVISOR_COMPANION"] }) }));

        await reconcile(false);

        expect(config()["services"]).toStrictEqual([{ binding: "LEGACY", service: "legacy-worker" }]);
        expect(lunora()).toBeUndefined();
    });

    it("leaves the companion out when the run does not deploy it, so the app never binds a Worker nobody published", async () => {
        expect.assertions(2);

        writeFileSync(join(root, "lunora.config.ts"), "export default { studio: { companion: true } };\n", "utf8");

        const inferred = await inferLunoraBindings({ projectRoot: root, skipCompanion: true });

        expect(inferred.services).toStrictEqual([]);

        reconcileWranglerBindings(root, inferred);

        expect(config()["services"]).toStrictEqual([{ binding: "LEGACY", service: "legacy-worker" }]);
    });

    it("keeps an app service declared as `advisorCompanion` when the run skips the companion", async () => {
        expect.assertions(1);

        mkdirSync(join(root, "services", "advisor"), { recursive: true });
        writeFileSync(join(root, "services", "advisor", "wrangler.jsonc"), `{ "name": "advisor-svc", "main": "src/index.ts" }\n`, "utf8");
        writeFileSync(
            join(root, "lunora.config.ts"),
            `export default { services: { advisorCompanion: { dir: "./services/advisor" } }, studio: { companion: true } };\n`,
            "utf8",
        );

        const inferred = await inferLunoraBindings({ projectRoot: root, skipCompanion: true });

        expect(inferred.services?.map((service) => service.binding)).toStrictEqual(["SERVICE_ADVISOR_COMPANION"]);
    });

    it("points the inferred companion at the project's own lunora directory", async () => {
        expect.assertions(1);

        writeFileSync(join(root, "lunora.config.ts"), "export default { studio: { companion: true } };\n", "utf8");

        const inferred = await inferLunoraBindings({ projectRoot: root, schemaDir: "backend" });

        expect(inferred.services?.[0]?.wranglerPath).toBe(join(root, "backend", "_generated", "companion", "wrangler.jsonc"));
    });
});
