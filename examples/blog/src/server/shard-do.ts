import type { SchemaLike, ShardDOState, SqlExec } from "@cirrus/do";
import { createShardCtxDb, runShardMigrations, ShardDO as ShardDOBase } from "@cirrus/do";
import type { DurableObjectNamespaceLike } from "@cirrus/scheduler";
import { createScheduler } from "@cirrus/scheduler";
import type { R2BucketLike } from "@cirrus/storage";
import { createStorage } from "@cirrus/storage";

import { purgeStaleDrafts } from "../../cirrus/cleanup.js";
import { listMine, save } from "../../cirrus/drafts.js";
import { get, list, publish, requestImageUpload } from "../../cirrus/posts.js";
import schema from "../../cirrus/schema.js";

type FunctionKind = "action" | "mutation" | "query";

type RegisteredFn = {
    readonly args: Record<string, unknown>;
    readonly handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> | unknown;
    readonly kind?: FunctionKind;
};

const REGISTRY: Record<string, RegisteredFn> = {
    "cleanup:purgeStaleDrafts": purgeStaleDrafts as unknown as RegisteredFn,
    "drafts:listMine": listMine as unknown as RegisteredFn,
    "drafts:save": save as unknown as RegisteredFn,
    "posts:get": get as unknown as RegisteredFn,
    "posts:list": list as unknown as RegisteredFn,
    "posts:publish": publish as unknown as RegisteredFn,
    "posts:requestImageUpload": requestImageUpload as unknown as RegisteredFn,
};

interface ShardEnv {
    CIRRUS_WORKER_ORIGIN?: string;
    FILES?: R2BucketLike;
    PUBLIC_STORAGE_BASE_URL?: string;
    SCHEDULER?: DurableObjectNamespaceLike;
    STORAGE_SECRET?: string;
}

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
        const env = (this.env ?? {}) as ShardEnv;
        const userId = this.getCurrentUserId();
        const identity = this.getCurrentIdentity();

        const ctx: Record<string, unknown> = {
            auth: {
                getIdentity: async () => identity,
                userId,
            },
            db: createShardCtxDb({
                broadcast: (delta) => this.broadcastDelta(delta),
                schema: schema as unknown as SchemaLike,
                sql: this.sql as SqlExec,
            }),
            fetch: globalThis.fetch.bind(globalThis),
        };

        ctx.runAction = (fn: { __cirrusRef: string }, fnArgs: Record<string, unknown>) => dispatch("action", fn.__cirrusRef, fnArgs, ctx);
        ctx.runMutation = (fn: { __cirrusRef: string }, fnArgs: Record<string, unknown>) => dispatch("mutation", fn.__cirrusRef, fnArgs, ctx);
        ctx.runQuery = (fn: { __cirrusRef: string }, fnArgs: Record<string, unknown>) => dispatch("query", fn.__cirrusRef, fnArgs, ctx);

        if (env.SCHEDULER && env.CIRRUS_WORKER_ORIGIN) {
            ctx.scheduler = createScheduler({ namespace: env.SCHEDULER, originUrl: env.CIRRUS_WORKER_ORIGIN });
        } else {
            ctx.scheduler = {
                cancel: async () => {
                    throw new Error("ctx.scheduler: SCHEDULER + CIRRUS_WORKER_ORIGIN bindings required");
                },
                runAfter: async () => {
                    throw new Error("ctx.scheduler: SCHEDULER + CIRRUS_WORKER_ORIGIN bindings required");
                },
                runAt: async () => {
                    throw new Error("ctx.scheduler: SCHEDULER + CIRRUS_WORKER_ORIGIN bindings required");
                },
            };
        }

        if (env.FILES) {
            ctx.storage = createStorage({
                bucket: env.FILES,
                publicBaseUrl: env.PUBLIC_STORAGE_BASE_URL,
                signingSecret: env.STORAGE_SECRET,
            });
        } else {
            ctx.storage = {
                delete: async () => {
                    throw new Error("ctx.storage: FILES (R2) binding required");
                },
                download: async () => {
                    throw new Error("ctx.storage: FILES (R2) binding required");
                },
                getSignedUrl: async () => {
                    throw new Error("ctx.storage: FILES (R2) binding required");
                },
                list: async () => {
                    throw new Error("ctx.storage: FILES (R2) binding required");
                },
                upload: async () => {
                    throw new Error("ctx.storage: FILES (R2) binding required");
                },
            };
        }

        return ctx;
    }
}
