/**
 * A shard that loads its procedures the way the `--lazy-functions` generated shard does, so the ingress preparation
 * runs under real workerd scheduling. `loadModule` mirrors the emitted `loadFunction`
 * (`packages/codegen/src/emit/functions.ts`): a settled load is shared, an in-flight one is not, and a resolved
 * module is looked up synchronously. `prepareFunction` mirrors the emitted override (`packages/codegen/src/emit/shard.ts`).
 *
 * Three module sets cover the loader shapes a deployment can produce:
 * - `import/*`: a real dynamic `import()` of a sibling module (Vite/rolldown chunked output, uploaded modules);
 * - `bundled/*`: esbuild's single-file wrapper, `Promise.resolve().then(() => (init(), exports))`;
 * - `eager/*`: resolved before the first request, so preparation never awaits (the eager control).
 */
import { DurableObject } from "cloudflare:workers";

import type { ShardDOState, SubscriptionOutcome } from "../../../src/shard-do";
import { ShardDO } from "../../../src/shard-do";
import type { LazyModule, LazySql } from "./procedures";
import { bump, evaluationCount, read, recordEvaluation, tick } from "./procedures";

const PROCEDURES: Record<string, LazyModule> = { inc: bump, "race-x": bump, "race-y": bump, ryw: bump, sub: read, tick, warm: bump };

type Loader = () => Promise<{ default: LazyModule }>;

const bundledLoader = (moduleId: string, procedure: LazyModule): Loader => {
    let exports: { default: LazyModule } | undefined;

    const init = (): { default: LazyModule } => {
        if (exports === undefined) {
            recordEvaluation(moduleId);
            exports = { default: procedure };
        }

        return exports;
    };

    return async () => await Promise.resolve().then(init);
};

const MODULE_LOADERS: Record<string, Loader> = {
    "import/inc": async () => await import("./inc"),
    "import/race-x": async () => await import("./race-x"),
    "import/race-y": async () => await import("./race-y"),
    "import/ryw": async () => await import("./ryw"),
    "import/sub": async () => await import("./sub"),
    "import/tick": async () => await import("./tick"),
    "import/warm": async () => await import("./warm"),
    ...Object.fromEntries(Object.entries(PROCEDURES).map(([name, procedure]) => [`bundled/${name}`, bundledLoader(`bundled/${name}`, procedure)])),
};

const settledLoads = new Map<string, Promise<{ default: LazyModule }>>();
const resolvedModules = new Map<string, LazyModule>();

/** Per module id: how often a cold load entered the hold, and how often a loader ran. */
const holds = new Map<string, number>();
const loaderCalls = new Map<string, number>();

for (const [name, procedure] of Object.entries(PROCEDURES)) {
    recordEvaluation(`eager/${name}`);
    resolvedModules.set(`eager/${name}`, procedure);
}

const increment = (counts: Map<string, number>, moduleId: string): void => {
    counts.set(moduleId, (counts.get(moduleId) ?? 0) + 1);
};

/** `<shape>/<module>:run` → `<shape>/<module>`; anything else is an always-loaded control procedure. */
const moduleIdOf = (functionPath: string): string | undefined => (functionPath.endsWith(":run") ? functionPath.slice(0, -":run".length) : undefined);

const loadModule = async (moduleId: string): Promise<void> => {
    let pending = settledLoads.get(moduleId);

    if (pending === undefined) {
        const loader = MODULE_LOADERS[moduleId];

        if (loader === undefined) {
            throw new Error(`no lazy module loader registered for "${moduleId}"`);
        }

        increment(loaderCalls, moduleId);

        const started = loader();
        const settle = (): void => {
            if (!settledLoads.has(moduleId)) {
                settledLoads.set(moduleId, started);
            }
        };

        // eslint-disable-next-line promise/catch-or-return -- `settle` is the rejection handler; the caller awaits `started` itself
        started.then(settle, settle);
        pending = started;
    }

    const loaded = await pending;

    resolvedModules.set(moduleId, loaded.default);
};

const loadedProcedure = (functionPath: string, kind: LazyModule["kind"]): LazyModule | undefined => {
    const moduleId = moduleIdOf(functionPath);
    const procedure = moduleId === undefined ? undefined : resolvedModules.get(moduleId);

    if (procedure === undefined) {
        throw new Error("a lazy function was invoked before it was prepared");
    }

    return procedure.kind === kind ? procedure : undefined;
};

class ConcreteLazyShard extends ShardDO {
    private migrated = false;

    public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        this.ensureMigrated();

        const sql = this.sql as LazySql;

        if (functionPath === "lazy:log") {
            return sql
                .exec("SELECT tag FROM lazy_log WHERE key = ? ORDER BY seq", args.key)
                .toArray()
                .map((row) => row.tag);
        }

        if (functionPath === "lazy:stats") {
            const modules = args.modules as string[];

            return Object.fromEntries(
                modules.map((moduleId) => [
                    moduleId,
                    { evaluations: evaluationCount(moduleId), holds: holds.get(moduleId) ?? 0, loads: loaderCalls.get(moduleId) ?? 0 },
                ]),
            );
        }

        const mutation = loadedProcedure(functionPath, "mutation");

        if (mutation !== undefined) {
            const result = await this.runInTransaction(async () => await mutation.run(sql, args));

            this.recordChangedTable("lazy_counter");

            return result;
        }

        return loadedProcedure(functionPath, "query")?.run(sql, args);
    }

    protected override ensureMigrated(): void {
        if (this.migrated) {
            return;
        }

        const sql = this.sql as LazySql;

        sql.exec("CREATE TABLE IF NOT EXISTS lazy_counter (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
        sql.exec("CREATE TABLE IF NOT EXISTS lazy_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, tag TEXT NOT NULL)");
        this.migrated = true;
    }

    protected override prepareFunction(functionPath: string): Promise<void> | undefined {
        const moduleId = moduleIdOf(functionPath);

        if (moduleId === undefined || resolvedModules.has(moduleId)) {
            return undefined;
        }

        increment(holds, moduleId);

        return this.holdShardWhileLoading(async () => {
            await loadModule(moduleId);
        });
    }

    // eslint-disable-next-line class-methods-use-this -- pure predicate over the path, mirroring the codegen override
    protected override isMutationFunction(functionPath: string): boolean {
        const moduleId = moduleIdOf(functionPath);

        return moduleId !== undefined && PROCEDURES[moduleId.slice(moduleId.indexOf("/") + 1)]?.kind === "mutation";
    }

    protected override async executeSubscription(functionPath: string, args: Record<string, unknown>): Promise<SubscriptionOutcome | null> {
        const preparation = this.prepareFunction(functionPath);

        if (preparation !== undefined) {
            await preparation;
        }

        this.ensureMigrated();

        const query = loadedProcedure(functionPath, "query");

        return query === undefined ? null : { result: query.run(this.sql as LazySql, args), tables: new Set(["lazy_counter"]) };
    }

    protected override executeStream(functionPath: string, args: Record<string, unknown>): null | { iterator: () => AsyncIterable<unknown> } {
        const stream = loadedProcedure(functionPath, "stream");

        return stream === undefined ? null : { iterator: () => stream.run(this.sql as LazySql, args) as AsyncIterable<unknown> };
    }
}

export default class TestLazyShardDO extends DurableObject {
    private readonly shard: ConcreteLazyShard;

    public constructor(context: DurableObjectState, env: unknown) {
        super(context, env as never);
        this.shard = new ConcreteLazyShard(context as unknown as ShardDOState, env);
    }

    public override fetch(request: Request): Promise<Response> {
        return this.shard.fetch(request);
    }

    public override webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
        return this.shard.webSocketMessage(ws, message);
    }

    public override webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
        return this.shard.webSocketClose(ws, code, reason, wasClean);
    }
}
