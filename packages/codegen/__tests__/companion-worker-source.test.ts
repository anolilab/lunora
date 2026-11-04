import { ts } from "ts-morph";
import { describe, expect, it } from "vitest";

import emitCompanion from "../src/emit/companion";

// The emitted source is the only copy of the companion Worker's behaviour, so it is run here: a change to the
// emitter that breaks the route, the verbs or the body shape fails this rather than a deploy.
const loadWorker = async (proceduresJson: string): Promise<{ fetch: (request: Request) => Promise<Response> }> => {
    const source = emitCompanion("/nonexistent-project", proceduresJson, true)["src/worker.ts"] ?? "";
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    const loaded: { default: { fetch: (request: Request) => Promise<Response> | Response } } = await import(
        `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
    );

    return { fetch: async (request) => loaded.default.fetch(request) };
};

const PATH = "/__lunora/advisor-procedures";
const DOCUMENT = `${JSON.stringify({ procedures: [{ name: "todos:list" }] })}\n`;

describe("the emitted companion worker source", () => {
    it("serves the procedures document on GET at the route", async () => {
        expect.assertions(3);

        const worker = await loadWorker(DOCUMENT);
        const response = await worker.fetch(new Request(`https://companion.internal${PATH}`));

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/json");
        await expect(response.json()).resolves.toStrictEqual({ procedures: [{ name: "todos:list" }] });
    });

    it("refuses other verbs with 405 and other paths with 404", async () => {
        expect.assertions(2);

        const worker = await loadWorker(DOCUMENT);

        await expect(worker.fetch(new Request(`https://companion.internal${PATH}`, { method: "POST" }))).resolves.toHaveProperty("status", 405);
        await expect(worker.fetch(new Request("https://companion.internal/other"))).resolves.toHaveProperty("status", 404);
    });

    it("uses the route path the app's Worker forwards", () => {
        expect.assertions(1);

        // The same literal is `ADVISOR_PROCEDURES_PATH` in @lunora/runtime's create-worker.ts, which codegen cannot import.
        expect(emitCompanion("/nonexistent-project", DOCUMENT, true)["src/worker.ts"]).toContain(`const ADVISOR_PROCEDURES_PATH = "${PATH}";`);
    });
});
