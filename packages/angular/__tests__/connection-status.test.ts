import { describe, expect, it } from "vitest";

import { connectionStatus } from "../src/connection-status";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

describe(connectionStatus, () => {
    it("seeds with the current status and updates on every transition", () => {
        const fake = createFakeClient("connecting");
        const destroy = createFakeDestroyRef();

        const status = connectionStatus({ client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(status()).toBe("connecting");

        fake.emitStatus("connected");

        expect(status()).toBe("connected");

        fake.emitStatus("offline");

        expect(status()).toBe("offline");
    });

    it("removes the listener when the DestroyRef fires", () => {
        const fake = createFakeClient("idle");
        const destroy = createFakeDestroyRef();

        const status = connectionStatus({ client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(fake.statusListeners).toHaveLength(1);

        destroy.destroy();

        expect(fake.statusListeners).toHaveLength(0);

        // A post-teardown emit must not move the signal.
        fake.emitStatus("connected");

        expect(status()).toBe("idle");
    });
});
