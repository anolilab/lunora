import { describe, expect, expectTypeOf, test } from "vitest";

import { createWorker, defineRpcEnvelope, VERSION } from "../src/index.js";

describe("index", () => {
    test("exports VERSION", () => {
        expect.assertions(1);

        expect(VERSION).toBe("0.0.0");
    });

    test("exports the core factory and helpers", () => {
        expect.assertions(1);

        expectTypeOf(createWorker).toBeFunction();

        expect(defineRpcEnvelope({ functionPath: "x:y" })).toEqual({ functionPath: "x:y" });
    });
});
