import { afterEach, describe, expect, it } from "vitest";

import { declareAppJurisdiction, resetAppJurisdiction } from "../../../shared/app-jurisdiction";
import { createCaptureSink } from "../src/from-env";
import { dispatchToLunoraFunction } from "../src/inbound/handler";
import type { InboundEmail } from "../src/inbound/parse";
import type { ShardNamespaceLike } from "../src/inbound/shard";

const email: InboundEmail = {
    attachments: [],
    authentication: { dkim: [], dmarc: [], spf: [] },
    from: "alice@example.com",
    headers: {},
    messageId: "<m-1@example.com>",
    subject: "Hi",
    text: "hello",
    to: ["bob@example.test"],
};

const okResponse = {
    json: async (): Promise<unknown> => {
        return { result: { id: "row-1" } };
    },
    ok: true,
    status: 200,
};

/** A `SHARD` binding that records which view (pinned or not) every RPC reached. */
const recordingNamespace = (): { log: string[]; namespace: ShardNamespaceLike; pinnedTo: string[] } => {
    const log: string[] = [];
    const pinnedTo: string[] = [];
    const view = (label: string): ShardNamespaceLike => {
        return {
            get: (id) => {
                return {
                    fetch: async () => {
                        log.push(`${label}:${String(id)}`);

                        return okResponse;
                    },
                };
            },
            idFromName: (name) => name,
        };
    };

    return {
        log,
        namespace: {
            ...view("UNPINNED"),
            jurisdiction: (jurisdiction) => {
                pinnedTo.push(jurisdiction);

                return view("PINNED");
            },
        },
        pinnedTo,
    };
};

const context = { ctx: undefined, env: { LUNORA_ADMIN_TOKEN: "secret" }, message: undefined as never };

describe("mail follows the app's declared jurisdiction", () => {
    afterEach(() => {
        resetAppJurisdiction();
    });

    it("pins inbound dispatch without a jurisdiction option once the app declares one", async () => {
        expect.assertions(2);

        const { log, namespace, pinnedTo } = recordingNamespace();
        const dispatch = dispatchToLunoraFunction({ functionPath: "inbound:onEmail", shard: namespace });

        // No declaration: the un-pinned namespace, as before.
        await dispatch(email, context);
        declareAppJurisdiction("eu");
        await dispatch(email, context);

        expect(pinnedTo).toStrictEqual(["eu"]);
        expect(log).toStrictEqual(["UNPINNED:__root__", "PINNED:__root__"]);
    });

    it("pins the dev capture inbox without a jurisdiction option", async () => {
        expect.assertions(3);

        declareAppJurisdiction("eu");

        const { log, namespace, pinnedTo } = recordingNamespace();
        const result = await createCaptureSink({ LUNORA_ADMIN_TOKEN: "secret", SHARD: namespace }).record({ subject: "Hi", to: "a@b.test" });

        expect(result).toStrictEqual({ id: "row-1" });
        expect(pinnedTo).toStrictEqual(["eu"]);
        expect(log).toStrictEqual(["PINNED:__root__"]);
    });

    it("refuses an explicit jurisdiction that contradicts the app's", async () => {
        expect.assertions(2);

        declareAppJurisdiction("eu");

        const { log, namespace } = recordingNamespace();

        await expect(dispatchToLunoraFunction({ functionPath: "inbound:onEmail", jurisdiction: "us", shard: namespace })(email, context)).rejects.toThrow(
            'jurisdiction "us" contradicts the app\'s declared jurisdiction "eu"',
        );
        expect(log).toStrictEqual([]);
    });
});

describe("captured mail under a contradicting jurisdiction", () => {
    afterEach(() => {
        resetAppJurisdiction();
    });

    it("fails the send instead of reporting a success-shaped id for mail it never recorded", async () => {
        expect.assertions(2);

        declareAppJurisdiction("eu");

        const { log, namespace } = recordingNamespace();
        const sink = createCaptureSink({ LUNORA_ADMIN_TOKEN: "secret", SHARD: namespace }, undefined, "us");

        await expect(sink.record({ subject: "Hi", to: "a@b.test" })).rejects.toThrow('jurisdiction "us" contradicts');
        expect(log).toStrictEqual([]);
    });
});

describe("declareAppJurisdiction", () => {
    afterEach(() => {
        resetAppJurisdiction();
    });

    it("refuses to redeclare a different jurisdiction in one isolate", () => {
        expect.assertions(2);

        declareAppJurisdiction("eu");

        expect(() => {
            declareAppJurisdiction("eu");
        }).not.toThrow();
        expect(() => {
            declareAppJurisdiction("us");
        }).toThrow('already "eu"');
    });
});
