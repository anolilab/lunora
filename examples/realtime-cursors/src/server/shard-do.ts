import type { ShardDOState } from "@cirrus/do";
import { ShardDO as ShardDOBase } from "@cirrus/do";

import { joinRoom, listCursors, updateCursor } from "../../cirrus/cursors.js";

type RegisteredFn = {
    readonly args: Record<string, unknown>;
    readonly handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> | unknown;
};

const REGISTRY: Record<string, RegisteredFn> = {
    "cursors:listCursors": listCursors as unknown as RegisteredFn,
    "cursors:joinRoom": joinRoom as unknown as RegisteredFn,
    "cursors:updateCursor": updateCursor as unknown as RegisteredFn,
};

export class ShardDO extends ShardDOBase {
    public constructor(state: ShardDOState, env: unknown) {
        super(state, env);
    }

    public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        const fn = REGISTRY[functionPath];

        if (!fn) {
            throw new Error(`unknown function: ${functionPath}`);
        }

        return fn.handler(this.buildCtx(), args);
    }

    private buildCtx(): unknown {
        return {
            auth: { userId: null, getIdentity: async () => null },
            db: {
                get: async () => null,
                query: () => {
                    return {
                        collect: async () => [],
                        filter() {
                            return this;
                        },
                        first: async () => null,
                        take: async () => [],
                        withIndex() {
                            return this;
                        },
                    };
                },
                insert: async () => "id_stub" as unknown,
                patch: async () => undefined,
                replace: async () => undefined,
                delete: async () => undefined,
            },
            scheduler: { runAfter: async () => "stub", runAt: async () => "stub" },
            storage: {
                delete: async () => undefined,
                getSignedUrl: async (key: string) => `https://files.example.com/${key}`,
                getUrl: (key: string) => `https://files.example.com/${key}`,
            },
            fetch: globalThis.fetch.bind(globalThis),
            runAction: async () => undefined as unknown,
            runMutation: async () => undefined as unknown,
            runQuery: async () => undefined as unknown,
        };
    }
}
