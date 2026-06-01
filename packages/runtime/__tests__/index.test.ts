import { describe, expect, expectTypeOf, it } from "vitest";

import { createWorker, defineRpcEnvelope, VERSION } from "../src/index.js";

describe("index", () => {
    it("exports VERSION", () => {
        expect.assertions(1);

        expect(VERSION).toBe("0.0.0");
    });

    it("exports the core factory and helpers", () => {
        expect.assertions(1);

        expectTypeOf(createWorker).toBeFunction();

        expect(defineRpcEnvelope({ functionPath: "x:y" })).toEqual({ functionPath: "x:y" });
    });
});
