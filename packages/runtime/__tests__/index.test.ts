import { describe, expect, expectTypeOf, it } from "vitest";

import { composeWorker, createWorker, defineRpcEnvelope, VERSION } from "../src/index";

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

    it("exports the composeWorker composition helper", () => {
        expect.assertions(1);

        expectTypeOf(composeWorker).toBeFunction();

        expect(typeof composeWorker).toBe("function");
    });
});
