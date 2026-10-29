import type { ShardDOState, SubscriptionOutcome } from "@lunora/do";
import { ShardDO } from "@lunora/do";
import type { SchemaLike, SocketAttachment, SqlExec } from "@lunora/shard-engine";
import {
    createShardCtxDb,
    migrateShapePokeCursor,
    readCdcCursor,
    runShardMigrations,
    writeGlobalShapeSnapshot,
    writeShapePokeCursor,
} from "@lunora/shard-engine";
import { DurableObject } from "cloudflare:workers";

const DELIVERY_TEST_SECRET = "delivery-authorization-workerd-fixture";
const settlementSchema: SchemaLike = { tables: { unrelated: { indexes: [], shape: { value: { kind: "number" } } } } };

interface Policy {
    allowed: boolean;
    epoch: number;
}

interface DeliverySnapshot {
    attachments: { deliveryPermits: Record<string, { epoch: number; scope: string }>; subscriptionIds: string[] }[];
    attempts: number;
    boot: string;
    fences: { epoch: number; scope: string }[];
    permits: { epoch: number; identity: string; mutation_id: string; scope: string }[];
    receipts: { identity: string; mutation_id: string; result_json: string }[];
    runs: number | undefined;
}

// Import the package export so this regression runs the built ShardDO shipped to users.
class AuthorizedShard extends ShardDO {
    public attempts = 0;
    public shapeReads = 0;
    public queryCalls = 0;
    public parkActions = false;
    private readonly mutations = new Set(["fixture:unrelated", "fixture:write"]);
    private readonly rooms = new Map([["room:fixture", "fixture:room"]]);
    private readonly subscriptionResult = { value: "private" };
    private readonly actions = new Map<number, { entered: PromiseWithResolvers<undefined>; released: PromiseWithResolvers<undefined> }>();

    public constructor(
        state: ShardDOState,
        private readonly policy: Policy,
    ) {
        super(
            state,
            { LUNORA_RELAY_SECRET: DELIVERY_TEST_SECRET },
            {
                deliveryAuthorization: ({ identity }) =>
                    Promise.resolve(identity.userId === "alice" && policy.allowed ? { scope: "fixture-scope", epoch: policy.epoch } : undefined),
            },
        );
    }

    public action(epoch: number) {
        let action = this.actions.get(epoch);
        if (!action) {
            action = { entered: Promise.withResolvers<undefined>(), released: Promise.withResolvers<undefined>() };
            this.actions.set(epoch, action);
        }
        return action;
    }

    public override handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        if (functionPath === "fixture:unrelated") {
            return this.runInTransaction(async () => {
                const writer = createShardCtxDb({ sql: this.sql as SqlExec, schema: settlementSchema, cdc: true, broadcast: () => {} });
                const result = await writer.insert("unrelated", { value: 1 });
                this.recordChangedTable("unrelated");
                this.commitMutationBookkeeping(result);
                return result;
            });
        }
        if (functionPath === "fixture:room") {
            (this.sql as SqlExec).exec("INSERT INTO delivery_room_events(kind) VALUES (?)", String(args.kind));
            (args.socket as { broadcast: (value: unknown) => void }).broadcast({ roomEvent: args.kind });
            return Promise.resolve(undefined);
        }
        if (functionPath === "fixture:action") {
            this.attempts += 1;
            const { epoch } = this.policy;
            const action = this.action(epoch);
            action.entered.resolve(undefined);
            return this.parkActions
                ? action.released.promise.then(() => {
                      return { epoch };
                  })
                : Promise.resolve({ epoch });
        }
        return this.runInTransaction(() => {
            this.attempts += 1;
            const sql = this.sql as SqlExec;
            sql.exec("UPDATE delivery_fixture SET runs = runs + 1");
            const result = { runs: sql.exec<{ runs: number }>("SELECT runs FROM delivery_fixture").toArray()[0]?.runs };
            this.commitMutationBookkeeping(result);
            this.recordChangedTable("delivery_fixture");
            if (args.fail) {
                throw new Error("fixture rollback after receipt");
            }
            return result;
        });
    }

    public retainShapes(socket: WebSocket): void {
        const { connectionId } = socket.deserializeAttachment() as SocketAttachment;
        if (connectionId === undefined) {
            throw new Error("Accepted socket has no connection id");
        }
        // Model attachments persisted by the deployment before delivery authorization was enabled.
        for (const name of ["local", "global"]) {
            if (this.shapeSubscribe(socket, name, { name }) !== "ok") {
                throw new Error("Could not retain shape registration");
            }
        }
        const sql = this.sql as SqlExec;
        migrateShapePokeCursor(sql);
        writeShapePokeCursor(sql, connectionId, "local", 7);
        writeGlobalShapeSnapshot(sql, connectionId, "global", new Map([["old-row", '{"private":true}']]));
    }

    protected override resolveShape(name: string): { global?: boolean; table: string } {
        this.shapeReads += 1;
        return { global: name === "global", table: "delivery_fixture" };
    }

    protected override readGlobalShapeRows(): Promise<{ doc: Record<string, unknown>; id: string }[]> {
        this.shapeReads += 1;
        return Promise.resolve([]);
    }

    protected override isMutationFunction(functionPath: string): boolean {
        return this.mutations.has(functionPath);
    }

    protected override roomHandlerPath(topic: string): string | undefined {
        return this.rooms.get(topic);
    }

    protected override executeSubscription(): Promise<SubscriptionOutcome> {
        this.queryCalls += 1;
        return Promise.resolve({ result: this.subscriptionResult, tables: new Set(["delivery_fixture"]) });
    }
}

class DeliveryAuthorizationTestDO extends DurableObject {
    private readonly boot = crypto.randomUUID();
    private readonly policy: Policy = { allowed: true, epoch: 0 };
    private readonly shard: AuthorizedShard;

    public constructor(context: DurableObjectState, env: Cloudflare.Env) {
        super(context, env);
        runShardMigrations(context.storage.sql as unknown as SqlExec, { tables: {} });
        context.storage.sql.exec("CREATE TABLE IF NOT EXISTS delivery_fixture(runs INTEGER NOT NULL)");
        context.storage.sql.exec("CREATE TABLE IF NOT EXISTS delivery_room_events(kind TEXT NOT NULL)");
        context.storage.sql.exec("INSERT INTO delivery_fixture SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM delivery_fixture)");
        this.shard = new AuthorizedShard(context as unknown as ShardDOState, this.policy);
    }

    public setPolicy(epoch: number, allowed = true): void {
        this.policy.epoch = epoch;
        this.policy.allowed = allowed;
    }

    public rejectEpochZeroMarker(): void {
        this.ctx.storage.sql.exec(
            "CREATE TRIGGER reject_old_marker BEFORE INSERT ON __lunora_delivery_receipt WHEN NEW.epoch = 0 BEGIN SELECT RAISE(FAIL, 'marker unavailable'); END",
        );
    }

    public rejectEpochOneRow(): void {
        this.ctx.storage.sql.exec(
            `CREATE TRIGGER reject_new_row BEFORE INSERT ON __idempotency WHEN NEW.result_json = '{"epoch":1}' BEGIN SELECT RAISE(FAIL, 'row unavailable'); END`,
        );
    }

    public parkActions(): void {
        this.shard.parkActions = true;
    }

    public waitForAction(epoch: number): Promise<void> {
        return this.shard.action(epoch).entered.promise;
    }

    public releaseAction(epoch: number): void {
        this.shard.action(epoch).released.resolve(undefined);
    }

    public enableSettlementFixture(): void {
        runShardMigrations(this.ctx.storage.sql as unknown as SqlExec, settlementSchema, { cdc: true });
    }

    public settlementSnapshot(): { cursor: number | undefined; queryCalls: number; rows: number | undefined } {
        const sql = this.ctx.storage.sql as unknown as SqlExec;
        return {
            cursor: readCdcCursor(sql),
            queryCalls: this.shard.queryCalls,
            rows: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM unrelated").toArray()[0]?.count,
        };
    }

    public retainRooms(): void {
        // Seed the attachment state an earlier deployment persisted; guarded joins remain unsupported.
        for (const socket of this.ctx.getWebSockets()) {
            const attachment = socket.deserializeAttachment() as SocketAttachment;
            socket.serializeAttachment({ ...attachment, whispers: ["room:fixture", "presence"] });
        }
    }

    public roomSnapshot(): { events: { kind: string }[]; memberships: string[][] } {
        return {
            events: this.ctx.storage.sql.exec<{ kind: string }>("SELECT kind FROM delivery_room_events").toArray(),
            memberships: this.ctx.getWebSockets().map((socket) => (socket.deserializeAttachment() as SocketAttachment).whispers ?? []),
        };
    }

    public async retainShapes(): Promise<void> {
        for (const socket of this.ctx.getWebSockets()) {
            this.shard.retainShapes(socket);
        }
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }

    public async shapeSnapshot(): Promise<{
        alarm: number | null;
        cursors: { sub_id: string }[];
        shapeIds: string[];
        shapeReads: number;
        snapshots: { sub_id: string }[];
    }> {
        const { sql } = this.ctx.storage;
        return {
            alarm: await this.ctx.storage.getAlarm(),
            shapeReads: this.shard.shapeReads,
            shapeIds: this.ctx.getWebSockets().flatMap((socket) => Object.keys((socket.deserializeAttachment() as SocketAttachment).shapes ?? {})),
            cursors: sql.exec<{ sub_id: string }>("SELECT sub_id FROM __shape_poke_cursor").toArray(),
            snapshots: sql.exec<{ sub_id: string }>("SELECT sub_id FROM __global_shape_snapshot").toArray(),
        };
    }

    public override alarm(): Promise<void> {
        return this.shard.alarm();
    }

    public snapshot(): DeliverySnapshot {
        const { sql } = this.ctx.storage;
        return {
            attempts: this.shard.attempts,
            boot: this.boot,
            runs: sql.exec<{ runs: number }>("SELECT runs FROM delivery_fixture").toArray()[0]?.runs,
            receipts: sql
                .exec<{ identity: string; mutation_id: string; result_json: string }>("SELECT identity, mutation_id, result_json FROM __idempotency")
                .toArray(),
            permits: sql
                .exec<{ epoch: number; identity: string; mutation_id: string; scope: string }>(
                    "SELECT identity, mutation_id, scope, epoch FROM __lunora_delivery_receipt",
                )
                .toArray(),
            fences: sql.exec<{ epoch: number; scope: string }>("SELECT scope, epoch FROM __lunora_delivery_fence").toArray(),
            attachments: this.ctx.getWebSockets().map((socket) => {
                const attachment = socket.deserializeAttachment() as {
                    deliveryPermits: Record<string, { epoch: number; scope: string }>;
                    subs: Record<string, unknown>;
                };
                return { subscriptionIds: Object.keys(attachment.subs), deliveryPermits: attachment.deliveryPermits };
            }),
        };
    }

    public override fetch(request: Request): Promise<Response> {
        return this.shard.fetch(request);
    }

    public override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
        return this.shard.webSocketMessage(socket, message);
    }

    public override webSocketClose(socket: WebSocket, code: number, reason: string, clean: boolean): Promise<void> {
        return this.shard.webSocketClose(socket, code, reason, clean);
    }

    public override webSocketError(socket: WebSocket, error: unknown): Promise<void> {
        return this.shard.webSocketError(socket, error);
    }
}

export { DELIVERY_TEST_SECRET, DeliveryAuthorizationTestDO };
