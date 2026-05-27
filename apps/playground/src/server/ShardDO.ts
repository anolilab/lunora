import type { ShardDOState } from "@cirrus/do";
import { ShardDO as ShardDOBase } from "@cirrus/do";

import { getAvatar, uploadAvatar } from "../../cirrus/avatars.js";
import { create, list } from "../../cirrus/channels.js";
import { cleanupOldMessages } from "../../cirrus/cleanup.js";
import { list as messages_list, send } from "../../cirrus/messages.js";

type RegisteredFunction = {
    readonly args: Record<string, unknown>;
    readonly handler: (context: unknown, args: Record<string, unknown>) => Promise<unknown> | unknown;
};

/**
 * Map of `"&lt;file>:&lt;function>"` → registered function. Codegen will replace
 * this at build time with a fully-typed lookup; the inline map keeps the
 * smoke-test Worker self-contained for now.
 */
const REGISTRY: Record<string, RegisteredFunction> = {
    "avatars:getAvatar": getAvatar as unknown as RegisteredFunction,
    "avatars:uploadAvatar": uploadAvatar as unknown as RegisteredFunction,
    "channels:create": create as unknown as RegisteredFunction,
    "channels:list": list,
    "cleanup:cleanupOldMessages": cleanupOldMessages,
    "messages:list": messages_list as unknown as RegisteredFunction,
    "messages:send": send as unknown as RegisteredFunction,
};

/**
 * Concrete ShardDO for the playground. Dispatches incoming `&lt;file>:&lt;fn>`
 * RPC envelopes against the schema-discovered function map.
 *
 * The DO base class handles the actual transport — WebSocket upgrades,
 * subscription registry, delta broadcast. We only own dispatch + the
 * synthetic ctx the handlers receive.
 */
export class ShardDO extends ShardDOBase {
    public constructor(state: ShardDOState, env: unknown) {
        super(state, env);
    }

    public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        const function_ = REGISTRY[functionPath];

        if (!function_) {
            throw new Error(`unknown function: ${functionPath}`);
        }

        const context = this.buildCtx();

        return function_.handler(context, args);
    }

    /**
     * Build a no-op context for the smoke-test build. A real deployment
     * wires up `ctx.db` (via SQLite), `ctx.storage` (R2 signed URLs) and
     * `ctx.auth` (resolved from the session cookie).
     */
    private buildCtx(): unknown {
        return {
            auth: { getIdentity: async () => null, userId: null },
            db: {
                delete: async () => undefined,
                get: async () => null,
                insert: async () => "id_stub" as unknown,
                patch: async () => undefined,
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
                replace: async () => undefined,
            },
            fetch: globalThis.fetch.bind(globalThis),
            runAction: async () => undefined as unknown,
            runMutation: async () => undefined as unknown,
            runQuery: async () => undefined as unknown,
            scheduler: {
                runAfter: async () => "scheduled_stub",
                runAt: async () => "scheduled_stub",
            },
            storage: {
                delete: async () => undefined,
                getSignedUrl: async (key: string) => `https://files.example.com/${key}`,
                getUrl: (key: string) => `https://files.example.com/${key}`,
            },
        };
    }
}
