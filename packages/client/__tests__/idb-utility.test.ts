import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { createDatabaseOpener } from "../src/idb-utility";

/** An `IDBFactory` whose first `open` fails with an `error` event; later opens delegate to a real one. */
const flakyFactory = (failures: number): IDBFactory => {
    const real = new IDBFactory();
    let remaining = failures;

    return {
        open: (name: string, version?: number) => {
            if (remaining > 0) {
                remaining -= 1;

                const target = new EventTarget();
                const request = Object.assign(target, { error: new Error("blocked"), result: undefined }) as unknown as IDBOpenDBRequest;

                queueMicrotask(() => target.dispatchEvent(new Event("error")));

                return request;
            }

            return real.open(name, version);
        },
    } as unknown as IDBFactory;
};

describe(createDatabaseOpener, () => {
    it("retries the open on the next call after a failed open instead of caching the rejection", async () => {
        expect.assertions(2);

        const open = createDatabaseOpener(flakyFactory(1), "db", 1, (database) => {
            database.createObjectStore("s");
        });

        await expect(open()).rejects.toThrow("blocked");

        const database = await open();

        expect(database.objectStoreNames.contains("s")).toBe(true);
    });

    it("still shares one connection across calls once an open succeeded", async () => {
        expect.assertions(1);

        const open = createDatabaseOpener(new IDBFactory(), "db", 1, (database) => {
            database.createObjectStore("s");
        });

        await expect(open()).resolves.toBe(await open());
    });
});
