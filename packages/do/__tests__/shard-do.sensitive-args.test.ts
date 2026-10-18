import { readRequestLog, SENSITIVE_ARG_MASK } from "@lunora/observability";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A `v.sensitive` argument is masked by what it IS, not what it is called. The
 * shard asks its function registry which argument names are marked; this suite
 * marks an innocuously named `value` argument and checks that no request-log row,
 * dev capture or error row carries the secret, while a sibling argument is logged
 * as usual.
 */
const SECRET = "hunter2-the-real-secret";

class SensitiveShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- test double: the dispatch result is fixed, no shard state is needed
    public override async handleRpc(functionPath: string, args: Record<string, unknown> = {}): Promise<unknown> {
        if (functionPath === "vault:fail") {
            throw new Error(`rejected ${String(args["value"])}`);
        }

        return { ok: true };
    }

    // eslint-disable-next-line class-methods-use-this -- test double: the marked names are fixed per path
    protected override sensitiveArgNames(functionPath: string): ReadonlySet<string> {
        return functionPath.startsWith("vault:") ? new Set(["value"]) : new Set();
    }
}

const makeState = (database: ReturnType<typeof createSqliteExec>): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets() {
            return [];
        },
        storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

const rpc = (functionPath: string, args: Record<string, unknown>): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

describe("shardDO request log masks v.sensitive arguments", () => {
    it("masks a marked argument named `value` and keeps its unmarked sibling", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            const shard = new SensitiveShard(makeState(database), {});

            await shard.fetch(rpc("vault:store", { label: "primary", value: SECRET }));

            const [row] = readRequestLog(database.sql);

            expect(row?.redactedArgs).toStrictEqual({ label: "primary", value: SENSITIVE_ARG_MASK });
            expect(JSON.stringify(readRequestLog(database.sql))).not.toContain(SECRET);
            expect(JSON.stringify(row)).toContain('"label":"primary"');
        } finally {
            database.close();
        }
    });

    it("keeps masking in a development environment, where raw capture is on", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new SensitiveShard(makeState(database), { ENVIRONMENT: "development" });

            await shard.fetch(rpc("vault:store", { label: "primary", value: SECRET }));

            const [row] = readRequestLog(database.sql);

            expect(row?.redactedArgs).toStrictEqual({ label: "primary", value: SENSITIVE_ARG_MASK });
            expect(JSON.stringify(readRequestLog(database.sql))).not.toContain(SECRET);
        } finally {
            database.close();
        }
    });

    it("masks the marked argument on an error row, where the thrown message quotes it", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            const shard = new SensitiveShard(makeState(database), {});

            await shard.fetch(rpc("vault:fail", { label: "primary", value: SECRET }));

            const [row] = readRequestLog(database.sql, { outcome: "error" });

            expect(row?.redactedArgs).toStrictEqual({ label: "primary", value: SENSITIVE_ARG_MASK });
            expect(JSON.stringify(readRequestLog(database.sql))).not.toContain(SECRET);
        } finally {
            database.close();
        }
    });

    it("leaves an unmarked function's arguments exactly as sent", async () => {
        expect.assertions(1);

        const database = createSqliteExec();

        try {
            const shard = new SensitiveShard(makeState(database), {});

            await shard.fetch(rpc("notes:save", { label: "primary", value: SECRET }));

            const [row] = readRequestLog(database.sql);

            expect(row?.redactedArgs).toStrictEqual({ label: "primary", value: SECRET });
        } finally {
            database.close();
        }
    });
});
