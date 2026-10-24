import { runInNewContext } from "node:vm";

import { ts } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitShard } from "../src/emit";

/**
 * A `.unique()` index added over rows that already hold duplicates cannot be
 * built. If the cold-start migration threw for it, the shard would never open and
 * the de-dup data migration (an admin call, which migrates first) could never
 * run. So the emitted shard defers the blocked index: the admin path migrates the
 * rest, and only user dispatch refuses until the index exists.
 */
const emitted = emitShard({ schema: { tables: [], vectorIndexes: [] } });

/** The body of the emitted method starting at `signature`, up to its closing brace. */
const methodBody = (signature: string): string => {
    const start = emitted.indexOf(signature);

    if (start === -1) {
        throw new Error(`emitted shard has no ${signature}`);
    }

    return emitted.slice(start, emitted.indexOf("\n        }", start));
};

describe("emitShard — blocked unique index", () => {
    it("migrates the base schema without throwing for a blocked unique index", () => {
        expect.assertions(4);

        const body = methodBody("protected override ensureMigrated()");

        expect(body).toContain("deferBlockedUniqueIndexes: true");
        expect(body).toContain("this.blockedUniqueIndexes = runShardMigrations(");
        expect(body).toContain("this.migrated = this.blockedUniqueIndexes.length === 0;");
        expect(body).not.toContain("throw");
    });

    it("refuses user dispatch while an index is outstanding", () => {
        expect.assertions(2);

        expect(methodBody("private ensureServable()")).toContain('throw new LunoraError("INTERNAL", this.blockedUniqueIndexes.join("; "))');
        expect(methodBody("public override async handleRpc(")).toContain("this.ensureServable();");
    });

    it("keeps the admin data-migration path on the tolerant migrate", () => {
        expect.assertions(2);

        const body = methodBody("protected override async runShardDataMigration(");

        expect(body).toContain("this.ensureMigrated();");
        expect(body).not.toContain("ensureServable");
    });
});

/** The whole method (signature through closing brace), so it can be compiled on its own. */
const methodSource = (signature: string): string => `${methodBody(signature)}\n        }`;

/**
 * The emitted migration state machine, compiled on its own: the three fields and
 * the three methods that gate a blocked index, run against a stubbed
 * `runShardMigrations` so the scan can be counted. The rest of the shard (the DO
 * base, the SQL handle) is not what is under test.
 */
const compileShard = () => {
    const fields = [...emitted.matchAll(/^ {8}private (?:blockedUniqueIndexes|migrated|migrationRetryAt)\b[^;\n]*;/gm)].map((match) => match[0]).join("\n");
    const retryMs = Number(/const BLOCKED_MIGRATION_RETRY_MS = ([\d_]+);/.exec(emitted)?.[1]?.replaceAll("_", ""));
    const source = [
        "class Shard extends Base {",
        fields,
        methodSource("protected override ensureMigrated()"),
        methodSource("private ensureServable()"),
        methodSource("protected override async runShardDataMigration("),
        "}",
        "Shard;",
    ].join("\n");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });

    return {
        build: (runShardMigrations: () => string[], onDataMigration: () => void = () => {}) => {
            class Base {
                public readonly sql = {};
                public readonly companionMemo = new Set<string>();

                public adminWriter(): object {
                    return this.sql;
                }

                public flushMigrationProgress(): object {
                    return this.sql;
                }
            }
            class LunoraError extends Error {
                public constructor(_code: string, message: string) {
                    super(message);
                }
            }
            // eslint-disable-next-line sonarjs/code-eval -- runs the emitter's own output in a sandbox of stubs
            const Shard = runInNewContext(outputText, {
                // The host's Date, so the fake timers drive the emitted clock reads.
                Date,
                BLOCKED_MIGRATION_RETRY_MS: retryMs,
                Base,
                buildReprojectionMigration: () => {},
                config: {},
                LUNORA_MIGRATIONS: { dedupe: {} },
                LunoraError,
                runDataMigration: async () => {
                    onDataMigration();

                    return {};
                },
                runShardMigrations,
                schema: {},
            }) as new () => {
                ensureMigrated: () => void;
                ensureServable: () => void;
                runShardDataMigration: (args: { id: string }) => Promise<unknown>;
            };

            return new Shard();
        },
        retryMs,
    };
};

describe("emitShard — blocked unique index retry", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("does not rescan on every refused call, only once per retry interval", () => {
        expect.assertions(8);

        const { build, retryMs } = compileShard();
        const scan = vi.fn<() => string[]>(() => ["unique index users_email blocked by duplicates"]);
        const shard = build(scan);

        // Cold start migrates, then the next calls inside the interval answer from the cached diagnostic.
        for (let call = 0; call < 5; call += 1) {
            expect(() => {
                shard.ensureServable();
            }).toThrow("blocked by duplicates");
        }

        expect(scan).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(retryMs + 1);

        expect(() => {
            shard.ensureServable();
        }).toThrow("blocked by duplicates");
        expect(scan).toHaveBeenCalledTimes(2);
    });

    it("stops migrating once nothing is blocked", () => {
        expect.assertions(2);

        const { build, retryMs } = compileShard();
        const scan = vi.fn<() => string[]>(() => []);
        const shard = build(scan);

        shard.ensureServable();
        vi.advanceTimersByTime(retryMs * 10);
        shard.ensureServable();

        expect(scan).toHaveBeenCalledTimes(1);
        expect(() => {
            shard.ensureServable();
        }).not.toThrow();
    });

    it("retries at once after an admin data migration, whatever the interval", async () => {
        expect.assertions(4);

        const { build } = compileShard();
        let duplicates = true;
        const scan = vi.fn<() => string[]>(() => (duplicates ? ["unique index users_email blocked by duplicates"] : []));
        const shard = build(scan, () => {
            duplicates = false;
        });

        expect(() => {
            shard.ensureServable();
        }).toThrow("blocked by duplicates");
        expect(scan).toHaveBeenCalledTimes(1);

        // The de-dup migration is an admin call: it must not rescan, but must unblock the next dispatch immediately.
        await shard.runShardDataMigration({ id: "dedupe" });

        expect(scan).toHaveBeenCalledTimes(1);
        expect(() => {
            shard.ensureServable();
        }).not.toThrow();
    });
});

/**
 * The emitted shard-init gate against a base that behaves like `ShardDO`: `ensureShardInit` memoizes
 * `runShardInit` once per instance and absorbs its failure, `dispatchShardInit` fires the hooks.
 */
const compileInitShard = () => {
    const fields = [...emitted.matchAll(/^ {8}private (?:blockedUniqueIndexes|migrated|migrationRetryAt|shardInitDeferred|deferredShardInit)\b[^;\n]*;/gm)]
        .map((match) => match[0])
        .join("\n");
    const source = [
        "class Shard extends Base {",
        fields,
        methodSource("protected override ensureMigrated()"),
        methodSource("private ensureServable()"),
        methodSource("protected override async runShardInit("),
        methodSource("protected override async ensureShardInit("),
        "}",
        "Shard;",
    ].join("\n");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });

    return (runShardMigrations: () => string[], onHook: () => void) => {
        class Base {
            public readonly sql = {};
            public readonly companionMemo = new Set<string>();

            private once?: Promise<void>;

            public async ensureShardInit(): Promise<void> {
                this.once ??= (async (): Promise<void> => {
                    try {
                        await (this as unknown as { runShardInit: () => Promise<void> }).runShardInit();
                    } catch {
                        // absorbed, as the real base does
                    }
                })();

                await this.once;
            }

            public async dispatchShardInit(): Promise<void> {
                // The real hook goes through `handleRpc`, which refuses while an index is blocked.
                (this as unknown as { ensureServable: () => void }).ensureServable();
                onHook();
            }
        }
        class LunoraError extends Error {
            public constructor(_code: string, message: string) {
                super(message);
            }
        }
        // eslint-disable-next-line sonarjs/code-eval -- runs the emitter's own output in a sandbox of stubs
        const Shard = runInNewContext(outputText, {
            Date,
            BLOCKED_MIGRATION_RETRY_MS: 0,
            Base,
            config: {},
            LunoraError,
            runShardMigrations,
            schema: {},
        }) as new () => { ensureShardInit: () => Promise<void> };

        return new Shard();
    };
};

describe("emitShard — onShardInit while a unique index is blocked", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("defers the hooks through the blocked window and runs them exactly once after the de-dup", async () => {
        expect.assertions(4);

        let duplicates = true;
        const hook = vi.fn<() => void>();
        const shard = compileInitShard()(() => (duplicates ? ["unique index users_email blocked by duplicates"] : []), hook);

        // Cold start during the blocked window: the init does not dispatch a hook that could only fail.
        await shard.ensureShardInit();
        await shard.ensureShardInit();

        expect(hook).not.toHaveBeenCalled();

        // The de-dup lands; the next entry point finds nothing blocked and runs the hooks before its dispatch.
        duplicates = false;
        vi.advanceTimersByTime(1);
        await Promise.all([shard.ensureShardInit(), shard.ensureShardInit()]);

        expect(hook).toHaveBeenCalledTimes(1);

        await shard.ensureShardInit();

        expect(hook).toHaveBeenCalledTimes(1);

        // A shard that was never blocked still runs its hooks once, at init.
        const clean = vi.fn<() => void>();

        await compileInitShard()(() => [], clean).ensureShardInit();

        expect(clean).toHaveBeenCalledTimes(1);
    });
});
