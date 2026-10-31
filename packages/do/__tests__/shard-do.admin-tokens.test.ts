import type { ImportShardResult, SchemaLike, SqlExec } from "@lunora/shard-engine";
import { ADMIN_FUNCTIONS, applyCdcChanges, createShardCtxDb, importShardRows, runShardMigrations } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ADMIN_SIGNAL_HEADER, mintAdminSignal } from "../../../shared/admin-token";
import { mintWsAdminToken } from "../../../shared/ws-admin-token";
import type { RunShardApplyCdcArgs, RunShardImportArgs, RunShardWriteArgs, RunShardWriteResult, ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const ROOT = "root-admin-token";
const DIGEST = "d".repeat(64);

const rpc = (functionPath: string, args: Record<string, unknown>, headers: Record<string, string>): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args, functionPath }),
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
    });

const asRoot = (functionPath: string, args: Record<string, unknown> = {}): Request => rpc(functionPath, args, { authorization: `Bearer ${ROOT}` });

const asSignal = (signal: string, functionPath: string, args: Record<string, unknown> = {}): Request =>
    rpc(functionPath, args, { [ADMIN_SIGNAL_HEADER]: signal });

class TokenShard extends ShardDO {
    /** Each `writeRow` parks until the test releases it, so two admin calls can be interleaved at will. */
    private readonly parked: ((release: (result: RunShardWriteResult) => void) => void)[] = [];

    /** Resolves with the release handle of the next `writeRow` to reach the store. */
    public nextParkedWrite(): Promise<(result: RunShardWriteResult) => void> {
        return new Promise((resolve) => {
            this.parked.push(resolve);
        });
    }

    // eslint-disable-next-line class-methods-use-this -- abstract hook; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }

    protected override runShardWrite(_args: RunShardWriteArgs): Promise<RunShardWriteResult> {
        return new Promise((resolve) => {
            this.parked.shift()?.(resolve);
        });
    }
}

const NOTES_SCHEMA: SchemaLike = { tables: { notes: { indexes: [], shape: { body: { kind: "string" } } } } };

/** The admin write seams wired to the real schema-aware writer, as the generated shard wires them. */
class WriterShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- abstract hook; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }

    protected override async runShardApplyCdc(args: RunShardApplyCdcArgs): Promise<{ applied: number }> {
        await applyCdcChanges(this.writer(), args.changes);

        return { applied: args.changes.length };
    }

    protected override runShardImport(args: RunShardImportArgs): Promise<ImportShardResult> {
        return importShardRows(this.writer(), NOTES_SCHEMA, args);
    }

    protected override async runShardWrite(args: RunShardWriteArgs): Promise<RunShardWriteResult> {
        const id = await this.writer().insert(args.table, args.doc ?? {});

        return { id, op: "insert" };
    }

    private writer(): ReturnType<typeof createShardCtxDb> {
        return createShardCtxDb({ broadcast: () => undefined, schema: NOTES_SCHEMA, sql: this.sql as SqlExec });
    }
}

const errorCode = async (response: Response): Promise<string | undefined> => {
    const body = await response.json<{ error?: { code?: string } }>();

    return body.error?.code;
};

describe("shardDO named admin tokens", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let shard: TokenShard;

    beforeEach(() => {
        database = createSqliteExec();

        const state: ShardDOState = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };

        shard = new TokenShard(state, { LUNORA_ADMIN_TOKEN: ROOT });
    });

    afterEach(() => {
        database.close();
    });

    it("stores a digest the root token can verify, and lists it without the digest", async () => {
        expect.assertions(4);

        const created = await shard.fetch(asRoot(ADMIN_FUNCTIONS.createAdminToken, { digest: DIGEST, name: "ci" }));

        expect(created.status).toBe(200);

        const good = await shard.fetch(asRoot(ADMIN_FUNCTIONS.verifyAdminToken, { digest: DIGEST, name: "ci" }));
        const bad = await shard.fetch(asRoot(ADMIN_FUNCTIONS.verifyAdminToken, { digest: "e".repeat(64), name: "ci" }));

        await expect(good.json()).resolves.toStrictEqual({ result: { createdAt: expect.any(Number), ok: true } });
        await expect(bad.json()).resolves.toStrictEqual({ result: { known: true, ok: false } });

        const listed = await shard.fetch(asRoot(ADMIN_FUNCTIONS.listAdminTokens));

        await expect(listed.text()).resolves.not.toContain(DIGEST);
    });

    it("admits a worker-minted signal for ordinary admin ops and files its audit rows under the token name", async () => {
        expect.assertions(2);

        const signal = await mintAdminSignal(ROOT, "ci");
        const response = await shard.fetch(asSignal(signal, ADMIN_FUNCTIONS.rebuildCompanions));

        expect(response.status).toBe(200);

        const auditResponse = await shard.fetch(asRoot(ADMIN_FUNCTIONS.getAuditLog));
        const audit = await auditResponse.json<{ result: { entries: { detail?: Record<string, unknown>; op: string }[] } }>();

        expect(audit.result.entries.find((entry) => entry.op === "rebuildCompanions")?.detail).toStrictEqual({ adminToken: "ci" });
    });

    it("attributes each of two interleaved admin calls to its own token", async () => {
        expect.assertions(1);

        const write = async (name: string, id: string): Promise<Response> =>
            shard.fetch(asSignal(await mintAdminSignal(ROOT, name), ADMIN_FUNCTIONS.writeRow, { id, op: "delete", table: "messages" }));

        const firstParked = shard.nextParkedWrite();
        const first = write("alpha", "m1");
        const releaseFirst = await firstParked;
        const secondParked = shard.nextParkedWrite();
        const second = write("beta", "m2");
        const releaseSecond = await secondParked;

        // Release the FIRST call while the second is still parked mid-flight.
        releaseFirst({ id: "m1", op: "delete" });
        await first;
        releaseSecond({ id: "m2", op: "delete" });
        await second;

        const auditResponse = await shard.fetch(asRoot(ADMIN_FUNCTIONS.getAuditLog));
        const audit = await auditResponse.json<{ result: { entries: { detail?: Record<string, unknown>; id?: string; op: string }[] } }>();

        expect(audit.result.entries.map((entry) => [entry.id, entry.detail?.adminToken])).toStrictEqual([
            ["m2", "beta"],
            ["m1", "alpha"],
        ]);
    });

    it.each([
        ADMIN_FUNCTIONS.createAdminToken,
        ADMIN_FUNCTIONS.listAdminTokens,
        ADMIN_FUNCTIONS.revokeAdminToken,
        ADMIN_FUNCTIONS.verifyAdminToken,
        ADMIN_FUNCTIONS.pitrRestore,
        ADMIN_FUNCTIONS.runAs,
        ADMIN_FUNCTIONS.recordAuthEvent,
        ADMIN_FUNCTIONS.recordContainerEvent,
        ADMIN_FUNCTIONS.recordMail,
        ADMIN_FUNCTIONS.recordQueueMessage,
    ])("refuses %s to a named token", async (functionPath) => {
        expect.assertions(2);

        const response = await shard.fetch(asSignal(await mintAdminSignal(ROOT, "ci"), functionPath, { digest: DIGEST, name: "ci2" }));

        expect(response.status).toBe(403);
        await expect(errorCode(response)).resolves.toBe("ADMIN_ROOT_REQUIRED");
    });

    describe("the token table", () => {
        const TABLE = "__lunora_admin_tokens__";
        const callers = ["named", "root"] as const;

        const build = async (who: (typeof callers)[number]): Promise<(functionPath: string, args: Record<string, unknown>) => Request> => {
            if (who === "root") {
                return (functionPath, args) => asRoot(functionPath, args);
            }

            const signal = await mintAdminSignal(ROOT, "ci");

            return (functionPath, args) => asSignal(signal, functionPath, args);
        };

        const writerShard = (): WriterShard => {
            runShardMigrations(database.sql, NOTES_SCHEMA);

            return new WriterShard(
                {
                    acceptWebSocket() {},
                    getWebSockets() {
                        return [];
                    },
                    storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
                },
                { LUNORA_ADMIN_TOKEN: ROOT },
            );
        };

        const answers = async (target: ShardDO, requests: Request[]): Promise<string[]> => {
            const responses = await Promise.all(requests.map(async (request) => target.fetch(request)));

            return Promise.all(responses.map(async (response) => `${String(response.status)} ${await response.text()}`));
        };

        const reachable = [
            'SELECT digest FROM "__lunora_admin_tokens__"',
            "SELECT digest FROM __lunora_admin_tokens__",
            'SELECT digest FROM "__LUNORA_ADMIN_TOKENS__"',
            "SELECT digest FROM `__lunora_admin_tokens__`",
            "SELECT digest FROM [__lunora_admin_tokens__]",
            'SELECT digest FROM main."__lunora_admin_tokens__"',
            'WITH t AS (SELECT digest FROM "__lunora_admin_tokens__") SELECT * FROM t',
            'SELECT * FROM (SELECT digest FROM "__lunora_admin_tokens__")',
            'SELECT (SELECT digest FROM "__lunora_admin_tokens__" LIMIT 1)',
            "SELECT * FROM pragma_table_info('__lunora_admin_tokens__')",
            "SELECT * FROM pragma_table_info('__lunora_admin_'||'tokens__')",
            "SELECT * FROM dbstat",
            "SELECT * FROM __lunora_admin_tokens__ -- c",
            "SELECT digest FROM /* x */ __lunora_admin_tokens__",
        ];

        it.each(callers)("refuses a %s caller's SQL that reaches it, to run or to lint", async (who) => {
            expect.assertions(2);

            const request = await build(who);

            await shard.fetch(asRoot(ADMIN_FUNCTIONS.createAdminToken, { digest: DIGEST, name: "ci" }));

            const ran = await answers(
                shard,
                reachable.map((sql) => request(ADMIN_FUNCTIONS.runSql, { sql })),
            );
            // The linter reports a refusal as a diagnostic and plans nothing.
            const linted = await answers(
                shard,
                reachable.map((sql) => request(ADMIN_FUNCTIONS.lintSql, { sql })),
            );

            expect(ran.filter((reply) => !reply.startsWith("400 ") || reply.includes(DIGEST))).toStrictEqual([]);
            expect(linted.filter((reply) => !reply.includes('"plan":[]') || !reply.includes("reserved framework storage"))).toStrictEqual([]);
        });

        it.each(callers)("keeps it out of every table-taking admin read and write for a %s caller", async (who) => {
            expect.assertions(2);

            const request = await build(who);
            const writer = writerShard();

            await writer.fetch(asRoot(ADMIN_FUNCTIONS.createAdminToken, { digest: DIGEST, name: "ci" }));

            const replies = await answers(
                writer,
                [
                    ADMIN_FUNCTIONS.readTablePage,
                    ADMIN_FUNCTIONS.facetColumn,
                    ADMIN_FUNCTIONS.describeTable,
                    ADMIN_FUNCTIONS.listTableIndexes,
                    ADMIN_FUNCTIONS.rankPage,
                    ADMIN_FUNCTIONS.deleteRows,
                    ADMIN_FUNCTIONS.clearTable,
                    ADMIN_FUNCTIONS.patchRows,
                    ADMIN_FUNCTIONS.writeRow,
                ].map((functionPath) =>
                    request(functionPath, { column: "digest", doc: { digest: "x" }, ids: ["ci"], op: "insert", table: TABLE, tables: [TABLE] }),
                ),
            );

            expect(replies.filter((reply) => reply.includes(DIGEST) || reply.includes('"digest"'))).toStrictEqual([]);
            expect(database.raw(`SELECT name FROM "${TABLE}"`).map((row) => row["name"])).toStrictEqual(["ci"]);
        });

        it.each(callers)("is absent from listings and exports for a %s caller", async (who) => {
            expect.assertions(1);

            const request = await build(who);

            await shard.fetch(asRoot(ADMIN_FUNCTIONS.createAdminToken, { digest: DIGEST, name: "ci" }));

            const replies = await answers(
                shard,
                [ADMIN_FUNCTIONS.listTables, ADMIN_FUNCTIONS.describeTables, ADMIN_FUNCTIONS.listTablesIndexes, ADMIN_FUNCTIONS.exportShard].map(
                    (functionPath) => request(functionPath, {}),
                ),
            );

            expect(replies.filter((reply) => reply.includes(TABLE) || reply.includes(DIGEST))).toStrictEqual([]);
        });
    });

    it("keeps a named token's admin writes out of the token table", async () => {
        expect.assertions(3);

        runShardMigrations(database.sql, NOTES_SCHEMA);

        const writer = new WriterShard(
            {
                acceptWebSocket() {},
                getWebSockets() {
                    return [];
                },
                storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
            },
            { LUNORA_ADMIN_TOKEN: ROOT },
        );
        const signal = await mintAdminSignal(ROOT, "ci");
        const planted = { created_at: 1, digest: DIGEST, name: "planted" };
        const table = "__lunora_admin_tokens__";

        await writer.fetch(asRoot(ADMIN_FUNCTIONS.createAdminToken, { digest: DIGEST, name: "ci" }));
        await writer.fetch(asSignal(signal, ADMIN_FUNCTIONS.writeRow, { doc: planted, op: "insert", table }));
        await writer.fetch(asSignal(signal, ADMIN_FUNCTIONS.importShard, { rows: [{ doc: planted, table }] }));
        await writer.fetch(asSignal(signal, ADMIN_FUNCTIONS.applyCdc, { changes: [{ doc: planted, id: "planted", op: "insert", seq: 1, table, ts: 1 }] }));

        // The control: the same signal does write a declared table.
        const control = await writer.fetch(asSignal(signal, ADMIN_FUNCTIONS.writeRow, { doc: { body: "hi" }, op: "insert", table: "notes" }));

        expect(control.status).toBe(200);

        const verified = await writer.fetch(asRoot(ADMIN_FUNCTIONS.verifyAdminToken, { digest: DIGEST, name: "planted" }));

        await expect(verified.json()).resolves.toStrictEqual({ result: { known: false, ok: false } });

        expect(database.raw(`SELECT name FROM "${table}"`).map((row) => row["name"])).toStrictEqual(["ci"]);
    });

    it("revokes only the issuance named, so a stale revoke leaves a re-created token alone", async () => {
        expect.assertions(4);

        // Two issuances of one name need distinct createdAt values, which two creates in one millisecond do not have.
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(1000);

        const first = await shard.fetch(asRoot(ADMIN_FUNCTIONS.createAdminToken, { digest: DIGEST, name: "ci" }));
        const { result: issued } = await first.json<{ result: { createdAt: number } }>();

        await shard.fetch(asRoot(ADMIN_FUNCTIONS.revokeAdminToken, { createdAt: issued.createdAt, name: "ci" }));
        vi.setSystemTime(2000);
        await shard.fetch(asRoot(ADMIN_FUNCTIONS.createAdminToken, { digest: "e".repeat(64), name: "ci" }));
        vi.useRealTimers();

        // The first revoke arrives again, after the name was re-created: it must not delete the new token.
        const stale = await shard.fetch(asRoot(ADMIN_FUNCTIONS.revokeAdminToken, { createdAt: issued.createdAt, name: "ci" }));
        const live = await shard.fetch(asRoot(ADMIN_FUNCTIONS.verifyAdminToken, { digest: "e".repeat(64), name: "ci" }));

        await expect(stale.json()).resolves.toStrictEqual({ result: { revoked: false } });
        await expect(live.json()).resolves.toMatchObject({ result: { ok: true } });

        const unqualified = await shard.fetch(asRoot(ADMIN_FUNCTIONS.revokeAdminToken, { name: "ci" }));

        expect(unqualified.status).toBe(400);
        expect(database.raw('SELECT name FROM "__lunora_admin_tokens__"').map((row) => row["name"])).toStrictEqual(["ci"]);
    });

    it("stores the issuance identity the worker chose, so it can sit past every revoked one", async () => {
        expect.assertions(2);

        const created = await shard.fetch(asRoot(ADMIN_FUNCTIONS.createAdminToken, { createdAt: 777, digest: DIGEST, name: "ci" }));
        const listed = await shard.fetch(asRoot(ADMIN_FUNCTIONS.listAdminTokens, {}));

        await expect(created.json()).resolves.toMatchObject({ result: { createdAt: 777, name: "ci" } });
        await expect(listed.json()).resolves.toMatchObject({ result: { tokens: [{ createdAt: 777, name: "ci" }] } });
    });

    it("answers a token create or revoke that committed even when its audit write fails", async () => {
        expect.assertions(4);

        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const failingAudit = {
            ...database.sql,
            exec: (query: string, ...bindings: unknown[]) => {
                if (query.includes('INSERT INTO "__lunora_audit__"')) {
                    throw new Error("disk full");
                }

                return database.sql.exec(query, ...bindings);
            },
        };
        const auditless = new TokenShard(
            {
                acceptWebSocket() {},
                getWebSockets() {
                    return [];
                },
                storage: { sql: failingAudit },
            },
            { LUNORA_ADMIN_TOKEN: ROOT },
        );

        const created = await auditless.fetch(asRoot(ADMIN_FUNCTIONS.createAdminToken, { digest: DIGEST, name: "ci" }));
        const { result: issued } = await created.clone().json<{ result: { createdAt: number } }>();
        const revoked = await auditless.fetch(asRoot(ADMIN_FUNCTIONS.revokeAdminToken, { createdAt: issued.createdAt, name: "ci" }));

        const logged = errors.mock.calls.length;

        errors.mockRestore();

        expect(created.status).toBe(200);
        expect(revoked.status).toBe(200);
        await expect(revoked.json()).resolves.toStrictEqual({ result: { revoked: true } });
        // Both audit writes really failed, and each failure was logged.
        expect(logged).toBe(2);
    });

    it("refuses a tampered, foreign-key, expired or misplaced signal", async () => {
        expect.assertions(5);

        const signal = await mintAdminSignal(ROOT, "ci");
        const wsToken = await mintWsAdminToken(ROOT);
        const [version, exp, , sig] = signal.split(".");
        const candidates: Request[] = [
            asSignal(`${String(version)}.${String(exp)}.root.${String(sig)}`, ADMIN_FUNCTIONS.listTables),
            asSignal(await mintAdminSignal("some-other-key", "ci"), ADMIN_FUNCTIONS.listTables),
            // Minted at the epoch, so it expired decades before any run.
            asSignal(await mintAdminSignal(ROOT, "ci", 0), ADMIN_FUNCTIONS.listTables),
            // A WebSocket sub-token is not a signal, and a signal is not a bearer.
            asSignal(wsToken.token, ADMIN_FUNCTIONS.listTables),
            rpc(ADMIN_FUNCTIONS.listTables, {}, { authorization: `Bearer ${signal}` }),
        ];

        for (const request of candidates) {
            // eslint-disable-next-line no-await-in-loop -- one shard, sequential requests keep the assertions ordered
            const response = await shard.fetch(request);

            expect(response.status).toBe(403);
        }
    });
});
