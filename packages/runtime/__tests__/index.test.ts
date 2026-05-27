import { expect, test } from "vitest";

import { createWorker, defineRpcEnvelope, VERSION } from "../src/index.js";

test("exports VERSION", () => {
    expect(VERSION).toBe("0.0.0");
});

test("exports the core factory and helpers", () => {
    expect(typeof createWorker).toBe("function");
    expect(defineRpcEnvelope({ functionPath: "x:y" })).toEqual({ functionPath: "x:y" });
});
