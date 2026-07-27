import { ADMIN_FUNCTIONS } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCapturedMail } from "../src/mail-catcher";
import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const ADMIN_TOKEN = "s3cret-admin";

/** Bare ShardDO whose `handleRpc` is never reached — admin RPCs dispatch before it. */
class TestMailShardDO extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }
}

describe("shardDO sendTestMail admin RPC", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    const adminRequest = (args: Record<string, unknown>): Request =>
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args, functionPath: ADMIN_FUNCTIONS.sendTestMail }),
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        });

    it("records a synthetic message readable via readCapturedMail", async () => {
        expect.assertions(6);

        const shard = new TestMailShardDO(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest({}));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { id: string } }>();

        expect(typeof body.result.id).toBe("string");

        const { entries } = readCapturedMail(database.sql);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.subject).toBe("Lunora test email");
        expect(entries[0]?.to).toBe("test@lunora.sh");
        expect(entries[0]?.html ?? "").toContain("https://example.test/verify?token=demo");
    });

    it("honors a custom `to`", async () => {
        expect.assertions(1);

        const shard = new TestMailShardDO(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.fetch(adminRequest({ to: "alice@example.test" }));

        const { entries } = readCapturedMail(database.sql);

        expect(entries[0]?.to).toBe("alice@example.test");
    });

    it("rejects a non-string `to` with a 400", async () => {
        expect.assertions(1);

        const shard = new TestMailShardDO(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const response = await shard.fetch(adminRequest({ to: 42 }));

        expect(response.status).toBe(400);
    });
});
