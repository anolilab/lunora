import { describe, expect, it, vi } from "vitest";

import type { ShardNamespaceLike } from "../src/do/report-lifecycle";
import { RECORD_CONTAINER_EVENT_OP, reportContainerLifecycle, ROOT_SHARD_NAME } from "../src/do/report-lifecycle";
import { buildContainerLifecycleEvent } from "../src/lifecycle-event";

/** A fake ShardDO namespace whose root stub captures the forwarded request. */
const fakeNamespace = (fetch: (request: Request) => Promise<Response>): ShardNamespaceLike & { getByNameCalls: string[] } => {
    const getByNameCalls: string[] = [];
    const stub = { fetch };

    return {
        get: () => stub,
        getByName: (name: string) => {
            getByNameCalls.push(name);

            return stub;
        },
        getByNameCalls,
        idFromName: (name: string) => name,
    };
};

describe(reportContainerLifecycle, () => {
    it("posts the recordContainerEvent admin op to the root shard with the admin bearer", async () => {
        expect.assertions(6);

        let captured: Request | undefined;

        const namespace = fakeNamespace(async (request) => {
            captured = request;

            return Response.json({ result: { recorded: true } }, { status: 200 });
        });

        const envelope = buildContainerLifecycleEvent("transcoder", "do-1", "start");

        await reportContainerLifecycle({ LUNORA_ADMIN_TOKEN: "s3cret", SHARD: namespace }, envelope);

        expect(namespace.getByNameCalls).toStrictEqual([ROOT_SHARD_NAME]);
        expect(captured).toBeDefined();
        expect(captured!.method).toBe("POST");
        expect(captured!.headers.get("authorization")).toBe("Bearer s3cret");

        const body = await captured!.json<{ args: { event: unknown }; functionPath: string }>();

        expect(body.functionPath).toBe(RECORD_CONTAINER_EVENT_OP);
        expect(body.args.event).toMatchObject({ container: "transcoder", event: "start", type: "container" });
    });

    it("skips silently when no SHARD binding is present", async () => {
        expect.assertions(1);

        const envelope = buildContainerLifecycleEvent("transcoder", "do-1", "start");

        // No throw, and resolves to undefined — there is nothing to call.
        await expect(reportContainerLifecycle({ LUNORA_ADMIN_TOKEN: "s3cret" }, envelope)).resolves.toBeUndefined();
    });

    it("skips silently when no admin token is configured (the gate would reject)", async () => {
        expect.assertions(2);

        const fetch = vi.fn<(request: Request) => Promise<Response>>(async () => new Response(null, { status: 200 }));
        const namespace = fakeNamespace(fetch);

        const envelope = buildContainerLifecycleEvent("transcoder", "do-1", "start");

        await reportContainerLifecycle({ SHARD: namespace }, envelope);

        expect(fetch).not.toHaveBeenCalled();
        expect(namespace.getByNameCalls).toStrictEqual([]);
    });

    it("swallows a throwing shard stub (the push must never throw out)", async () => {
        expect.assertions(1);

        const namespace = fakeNamespace(() => {
            throw new Error("shard unreachable");
        });

        const envelope = buildContainerLifecycleEvent("transcoder", "do-1", "error", "boom");

        await expect(reportContainerLifecycle({ LUNORA_ADMIN_TOKEN: "s3cret", SHARD: namespace }, envelope)).resolves.toBeUndefined();
    });

    it("routes through a jurisdiction-pinned subnamespace when configured", async () => {
        expect.assertions(2);

        const inner = fakeNamespace(async () => Response.json({ result: { recorded: true } }, { status: 200 }));
        const jurisdictionCalls: string[] = [];
        const namespace: ShardNamespaceLike = {
            get: () => {
                throw new Error("should resolve via the jurisdiction subnamespace, not the root namespace");
            },
            idFromName: () => {
                throw new Error("should resolve via the jurisdiction subnamespace, not the root namespace");
            },
            jurisdiction: (j) => {
                jurisdictionCalls.push(j);

                return inner;
            },
        };

        const envelope = buildContainerLifecycleEvent("transcoder", "do-1", "start");

        await reportContainerLifecycle({ LUNORA_ADMIN_TOKEN: "s3cret", SHARD: namespace }, envelope, "us");

        expect(jurisdictionCalls).toStrictEqual(["us"]);
        expect(inner.getByNameCalls).toStrictEqual([ROOT_SHARD_NAME]);
    });

    it("drops the event (best-effort) when the binding can't honor the jurisdiction", async () => {
        expect.assertions(1);

        // Legacy binding without `.jurisdiction()`: applyJurisdiction throws, the
        // best-effort wrapper swallows it — the event is never written to the
        // un-pinned, out-of-region root shard.
        const namespace = fakeNamespace(async () => Response.json({ result: { recorded: true } }, { status: 200 }));
        delete (namespace as { jurisdiction?: unknown }).jurisdiction;

        const envelope = buildContainerLifecycleEvent("transcoder", "do-1", "start");

        await reportContainerLifecycle({ LUNORA_ADMIN_TOKEN: "s3cret", SHARD: namespace }, envelope, "eu");

        expect(namespace.getByNameCalls).toStrictEqual([]);
    });
});
