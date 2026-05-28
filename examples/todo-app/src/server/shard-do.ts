import type { SchemaLike, ShardDOState, SqlExec } from "@cirrus/do";
import { createShardCtxDb, runShardMigrations, ShardDO as ShardDOBase } from "@cirrus/do";

import schema from "../../cirrus/schema.js";
import { add, list, remove, toggle } from "../../cirrus/todos.js";

type FunctionKind = "action" | "mutation" | "query";

type RegisteredFn = {
    readonly args: Record<string, unknown>;
    readonly handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> | unknown;
    readonly kind?: FunctionKind;
};

const REGISTRY: Record<string, RegisteredFn> = {
    "todos:add": add as unknown as RegisteredFn,
    "todos:list": list as unknown as RegisteredFn,
    "todos:remove": remove as unknown as RegisteredFn,
    "todos:toggle": toggle as unknown as RegisteredFn,
};

const dispatch = async (expected: FunctionKind, functionPath: string, args: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
    const fn = REGISTRY[functionPath];

    if (!fn) {
        throw new Error(`unknown function: ${functionPath}`);
    }

    if (fn.kind && fn.kind !== expected) {
        throw new Error(`ctx.run${expected[0]!.toUpperCase()}${expected.slice(1)}: "${functionPath}" is registered as a ${fn.kind}, not a ${expected}`);
    }

    return fn.handler(ctx, args);
};

export class ShardDO extends ShardDOBase {
    private migrated = false;

    public constructor(state: ShardDOState, env: unknown) {
        super(state, env);
    }

    public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        const fn = REGISTRY[functionPath];

        if (!fn) {
            throw new Error(`unknown function: ${functionPath}`);
        }

        this.ensureMigrated();

        return fn.handler(this.buildCtx(), args);
    }

    private ensureMigrated(): void {
        if (this.migrated) {
            return;
        }

        runShardMigrations(this.sql as SqlExec, schema as unknown as SchemaLike);
        this.migrated = true;
    }

    private buildCtx(): unknown {
        const userId = this.getCurrentUserId();
        const identity = this.getCurrentIdentity();

        const ctx: Record<string, unknown> = {
            auth: {
                getIdentity: async () => identity,
                userId,
            },
            db: createShardCtxDb({
                broadcast: (delta) => {
                    this.broadcastDelta(delta);
                },
                schema: schema as unknown as SchemaLike,
                sql: this.sql as SqlExec,
            }),
            fetch: globalThis.fetch.bind(globalThis),
            scheduler: {
                cancel: async () => {
                    throw new Error("ctx.scheduler: this example does not bind a SchedulerDO");
                },
                runAfter: async () => {
                    throw new Error("ctx.scheduler: this example does not bind a SchedulerDO");
                },
                runAt: async () => {
                    throw new Error("ctx.scheduler: this example does not bind a SchedulerDO");
                },
            },
            storage: {
                delete: async () => {
                    throw new Error("ctx.storage: this example does not bind an R2 bucket");
                },
                download: async () => {
                    throw new Error("ctx.storage: this example does not bind an R2 bucket");
                },
                getSignedUrl: async () => {
                    throw new Error("ctx.storage: this example does not bind an R2 bucket");
                },
                list: async () => {
                    throw new Error("ctx.storage: this example does not bind an R2 bucket");
                },
                upload: async () => {
                    throw new Error("ctx.storage: this example does not bind an R2 bucket");
                },
            },
        };

        ctx.runAction = (fn: { __cirrusRef: string }, fnArgs: Record<string, unknown>) => dispatch("action", fn.__cirrusRef, fnArgs, ctx);
        ctx.runMutation = (fn: { __cirrusRef: string }, fnArgs: Record<string, unknown>) => dispatch("mutation", fn.__cirrusRef, fnArgs, ctx);
        ctx.runQuery = (fn: { __cirrusRef: string }, fnArgs: Record<string, unknown>) => dispatch("query", fn.__cirrusRef, fnArgs, ctx);

        return ctx;
    }
}
