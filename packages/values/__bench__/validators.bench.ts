import { bench, describe } from "vitest";

import { v } from "../src/v.js";

/**
 * Validators sit on the per-RPC critical path: every incoming `args` record
 * runs through `parse()` on every field before the handler executes. Even a
 * few microseconds per validator multiplies into noticeable latency at
 * realistic call volumes, so we benchmark the shapes that actually show up
 * in user code:
 *
 * - Primitives — the most common args (string, number, boolean, id).
 * - Optional + literal + union — the next tier (auth flags, role narrowing).
 * - Object — almost every RPC takes an object somewhere.
 * - Array / record / nested object — the heavier shapes (history, prefs).
 * - Failing path (string given a number) — exercises the `fail()` throw.
 *
 * `safeParse` is benched alongside `parse` because the runtime uses both:
 * `parse` on the hot dispatch path, `safeParse` in dev overlay diagnostics.
 */

const stringValidator = v.string();
const numberValidator = v.number();
const booleanValidator = v.boolean();
const idValidator = v.id("users");
const optionalNumber = v.optional(v.number());
const literalUnion = v.union(v.literal("admin"), v.literal("user"), v.literal("guest"));

const userObject = v.object({
    active: v.boolean(),
    age: v.number(),
    email: v.string(),
    id: v.id("users"),
    name: v.string(),
});

const messageObject = v.object({
    authorId: v.id("users"),
    channelId: v.id("channels"),
    createdAt: v.number(),
    edited: v.optional(v.boolean()),
    id: v.id("messages"),
    tags: v.array(v.string()),
    text: v.string(),
});

const nestedObject = v.object({
    message: messageObject,
    metadata: v.record(v.string(), v.string()),
    user: userObject,
});

const stringArray = v.array(v.string());
const stringRecord = v.record(v.string(), v.string());

const sampleString = "hello world";
const sampleNumber = 42;
const sampleBoolean = true;
const sampleId = "users:abc123";
const sampleUser = { active: true, age: 30, email: "a@b.c", id: "users:1", name: "alice" };
const sampleMessage = {
    authorId: "users:1",
    channelId: "channels:c1",
    createdAt: 1_700_000_000_000,
    edited: false,
    id: "messages:m1",
    tags: ["urgent", "starred"],
    text: "hi",
};
const sampleNested = {
    message: sampleMessage,
    metadata: { agent: "vitest", ip: "127.0.0.1" },
    user: sampleUser,
};
const sampleStringArray = Array.from({ length: 32 }, (_, index) => `item-${String(index)}`);
const sampleRecord = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`key-${String(index)}`, `value-${String(index)}`]));

describe("primitives", () => {
    bench("v.string()", () => {
        stringValidator.parse(sampleString);
    });

    bench("v.number()", () => {
        numberValidator.parse(sampleNumber);
    });

    bench("v.boolean()", () => {
        booleanValidator.parse(sampleBoolean);
    });

    bench("v.id()", () => {
        idValidator.parse(sampleId);
    });

    bench("v.optional(v.number()) — defined", () => {
        optionalNumber.parse(sampleNumber);
    });

    bench("v.optional(v.number()) — undefined", () => {
        optionalNumber.parse(undefined);
    });
});

describe("compound validators", () => {
    bench("v.union() — first branch match", () => {
        literalUnion.parse("admin");
    });

    bench("v.union() — last branch match", () => {
        literalUnion.parse("guest");
    });

    bench("v.object() — 5 fields", () => {
        userObject.parse(sampleUser);
    });

    bench("v.object() — 7 fields with optional + array", () => {
        messageObject.parse(sampleMessage);
    });

    bench("v.array(v.string()) — 32 items", () => {
        stringArray.parse(sampleStringArray);
    });

    bench("v.record(v.string(), v.string()) — 16 entries", () => {
        stringRecord.parse(sampleRecord);
    });

    bench("nested object (user + message + record)", () => {
        nestedObject.parse(sampleNested);
    });
});

describe("safeParse path", () => {
    bench("safeParse — success", () => {
        userObject.safeParse(sampleUser);
    });

    bench("safeParse — failure (wrong type at root)", () => {
        userObject.safeParse(42);
    });

    bench("safeParse — failure (wrong type at nested field)", () => {
        userObject.safeParse({ ...sampleUser, age: "thirty" });
    });
});
