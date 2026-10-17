import type { ShardDOState, SubscriptionOutcome } from "@lunora/do";
import { ShardDO } from "@lunora/do";
import type { SqlExec } from "@lunora/shard-engine";
import { runShardMigrations } from "@lunora/shard-engine";
import { DurableObject } from "cloudflare:workers";

const DELIVERY_TEST_SECRET = "delivery-authorization-workerd-fixture";

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
    public parkActions = false;
    private readonly mutations = new Set(["fixture:write"]);
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
            if (args.fail) {
                throw new Error("fixture rollback after receipt");
            }
            return result;
        });
    }

    protected override isMutationFunction(functionPath: string): boolean {
        return this.mutations.has(functionPath);
    }

    protected override executeSubscription(): Promise<SubscriptionOutcome> {
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
