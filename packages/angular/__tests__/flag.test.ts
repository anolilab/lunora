import { describe, expect, it } from "vitest";

import { flag, flags } from "../src/flag";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

const FLAGS_REF = "__lunora_flags__:eval";

describe(flag, () => {
    it("holds the default then resolves on push", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const dark = flag("dark-mode", false, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.functionPath).toBe(FLAGS_REF);
        expect(dark()).toBe(false);

        fake.subscriptions[0]?.push(true);

        expect(dark()).toBe(true);
    });

    it("sends the flag key, inferred type, and default as subscribe args", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        flag("hero", "control", { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(fake.subscriptions[0]?.args).toStrictEqual({ context: undefined, default: "control", key: "hero", type: "string" });
    });

    it("fails open — a thrown subscribe keeps the default", () => {
        const destroy = createFakeDestroyRef();
        const client = {
            subscribe: () => {
                throw new Error("socket closed");
            },
        };

        const dark = flag("dark-mode", false, { client: client as never, destroyRef: destroy.asDestroyRef });

        expect(dark()).toBe(false);
    });

    it("tears down the subscription when the DestroyRef fires", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        flag("dark-mode", false, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);

        destroy.destroy();

        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
    });
});

describe(flags, () => {
    it("opens one subscription per key and resolves each independently", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const all = flags({ "dark-mode": false, "page-size": 10 }, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(fake.subscriptions).toHaveLength(2);
        expect(all()).toStrictEqual({ "dark-mode": false, "page-size": 10 });

        fake.subscriptions.find((sub) => sub.args["key"] === "dark-mode")?.push(true);
        fake.subscriptions.find((sub) => sub.args["key"] === "page-size")?.push(50);

        expect(all()).toStrictEqual({ "dark-mode": true, "page-size": 50 });
    });

    it("tears down every subscription on destroy", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        flags({ a: false, b: false }, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(fake.subscriptions.every((sub) => !sub.unsubscribed)).toBe(true);

        destroy.destroy();

        expect(fake.subscriptions.every((sub) => sub.unsubscribed)).toBe(true);
    });
});
