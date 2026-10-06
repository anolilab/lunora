import { LunoraError } from "@lunora/errors";
import { LUNORA_ROLE_PREFIX } from "@lunora/shard-engine";

/** The framework roles that can share the shard class; anything unprefixed is a shard. */
type MergedRole = "registry" | "scheduler";

/** The lifecycle handlers the Workers runtime invokes on a Durable Object. */
interface DurableObjectHandlers {
    alarm?: (alarmInfo?: AlarmInvocationInfo) => Promise<void> | void;
    fetch?: (request: Request) => Promise<Response> | Response;
    webSocketClose?: (ws: WebSocket, code: number, reason: string, wasClean: boolean) => Promise<void> | void;
    webSocketError?: (ws: WebSocket, error: unknown) => Promise<void> | void;
    webSocketMessage?: (ws: WebSocket, message: ArrayBuffer | string) => Promise<void> | void;
}

/** A Durable Object class one role is implemented by. */
type RoleClass<Env> = new (state: DurableObjectState, env: Env) => DurableObjectHandlers;

/** The classes {@link mergeDurableObjects} folds into one; `scheduler` and `registry` only when the app has them. */
interface MergedRoles<Env> {
    registry?: RoleClass<Env>;
    scheduler?: RoleClass<Env>;
    shard: RoleClass<Env>;
}

/** The namespace members {@link roleNamespace} wraps — the slice of `DurableObjectNamespace` the framework calls. */
interface RoleNamespaceTarget {
    get: (id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) => DurableObjectStub;
    getByName?: (name: string, options?: DurableObjectNamespaceGetDurableObjectOptions) => DurableObjectStub;
    idFromName: (name: string) => DurableObjectId;
    jurisdiction?: (jurisdiction: DurableObjectJurisdiction) => RoleNamespaceTarget;
}

/** The role an instance name belongs to: the segment after {@link LUNORA_ROLE_PREFIX}, or `shard` for every other name. */
const roleOf = (name: string | undefined): string => {
    if (!name?.startsWith(LUNORA_ROLE_PREFIX)) {
        return "shard";
    }

    const end = name.indexOf(":", LUNORA_ROLE_PREFIX.length);

    return end === -1 ? "" : name.slice(LUNORA_ROLE_PREFIX.length, end);
};

/**
 * One Durable Object class that hosts the shard, the scheduler and the shard
 * registry, so an app spends one of the account's Durable Object classes on the
 * framework instead of three (plan 462).
 *
 * Every framework stub is named, so the role is read from `ctx.id.name` once, in
 * the constructor: names reached through {@link roleNamespace} carry
 * `__lunora_do__:<role>:`, everything else is a shard. Each instance plays one
 * role for its whole life and keeps its own storage, alarm and WebSockets, so
 * the class only delegates the runtime's lifecycle calls to that role's object.
 * An app adopts this before its first deploy: an existing `ShardDO` namespace's
 * data does not move into the merged class.
 */
const mergeDurableObjects = <Env>(roles: MergedRoles<Env>): RoleClass<Env> =>
    class LunoraDO implements DurableObjectHandlers {
        readonly #role: DurableObjectHandlers;

        public constructor(state: DurableObjectState, env: Env) {
            const role = roleOf(state.id.name);
            const Role = role === "shard" ? roles.shard : roles[role as MergedRole];

            if (Role === undefined) {
                throw new LunoraError("INTERNAL", `no "${role}" role is merged into this Durable Object class (instance "${String(state.id.name)}")`);
            }

            this.#role = new Role(state, env);
        }

        public async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
            await this.#role.alarm?.(alarmInfo);
        }

        public async fetch(request: Request): Promise<Response> {
            if (this.#role.fetch === undefined) {
                throw new LunoraError("INTERNAL", "the merged Durable Object role has no fetch handler");
            }

            return await this.#role.fetch(request);
        }

        public async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
            await this.#role.webSocketClose?.(ws, code, reason, wasClean);
        }

        public async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
            await this.#role.webSocketError?.(ws, error);
        }

        public async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
            await this.#role.webSocketMessage?.(ws, message);
        }
    };

/**
 * `namespace` seen as one role of a {@link mergeDurableObjects} class: every name
 * it resolves is prefixed with `__lunora_do__:<role>:`, so the scheduler's
 * `"default"` and a shard called `"default"` stay different instances. Pass it
 * where the builder takes the role's namespace:
 * `.scheduler({ namespace: (env) => roleNamespace(env.SHARD, "scheduler") })`.
 */
const roleNamespace = (namespace: RoleNamespaceTarget, role: MergedRole): RoleNamespaceTarget => {
    const prefix = `${LUNORA_ROLE_PREFIX}${role}:`;
    const { getByName, jurisdiction } = namespace;

    return {
        get: (id, options) => namespace.get(id, options),
        // Called through the namespace, never detached: workerd rejects a native
        // method invoked without its own receiver ("Illegal invocation").
        ...(getByName === undefined
            ? {}
            : { getByName: (name: string, options?: DurableObjectNamespaceGetDurableObjectOptions) => getByName.call(namespace, `${prefix}${name}`, options) }),
        idFromName: (name) => namespace.idFromName(`${prefix}${name}`),
        ...(jurisdiction === undefined ? {} : { jurisdiction: (value: DurableObjectJurisdiction) => roleNamespace(jurisdiction.call(namespace, value), role) }),
    };
};

export type { DurableObjectHandlers, MergedRole, MergedRoles, RoleClass, RoleNamespaceTarget };
export { mergeDurableObjects, roleNamespace };
