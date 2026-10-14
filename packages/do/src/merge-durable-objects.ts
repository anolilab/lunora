import { LunoraError } from "@lunora/errors";
import { LUNORA_ROLE_PREFIX } from "@lunora/platform";

/** The framework roles that can share the shard class, named after their generated `_generated/` modules. */
const MERGED_ROLES = ["scheduler", "shardRegistry"] as const;

/** One of {@link MERGED_ROLES}. */
type MergedRole = (typeof MERGED_ROLES)[number];

/** The lifecycle handlers the Workers runtime invokes on a Durable Object. */
interface DurableObjectHandlers {
    alarm?: (alarmInfo?: AlarmInvocationInfo) => Promise<void> | void;
    fetch?: (request: Request) => Promise<Response> | Response;
    webSocketClose?: (ws: WebSocket, code: number, reason: string, wasClean: boolean) => Promise<void> | void;
    webSocketError?: (ws: WebSocket, error: unknown) => Promise<void> | void;
    webSocketMessage?: (ws: WebSocket, message: ArrayBuffer | string) => Promise<void> | void;
}

/**
 * A Durable Object class one role is implemented by. Its parameters are typed
 * `never` so any role class fits — each framework class declares the structural
 * slice of `DurableObjectState` / env it reads, and those slices differ.
 */
type RoleClass = new (state: never, env: never) => DurableObjectHandlers;

/** The classes {@link mergeDurableObjects} folds into one; `scheduler` and `shardRegistry` only when the app has them. */
type MergedRoles = Partial<Record<MergedRole, RoleClass>> & { shard: RoleClass };

/** The merged class: every lifecycle handler is defined, delegating to the instance's role. */
type MergedDurableObject<Env> = new (state: DurableObjectState, env: Env) => Required<DurableObjectHandlers>;

/** The one namespace member every selector shape shares — what {@link roleNamespace} needs to be handed. */
interface RoleNamespaceTarget {
    idFromName: (name: string) => unknown;
}

/** A callable member read off a namespace. */
const isCallable = (value: unknown): value is (...arguments_: unknown[]) => unknown => typeof value === "function";

/** Whether a `jurisdiction()` view is itself a namespace that can be wrapped. */
const isNamespace = (value: unknown): value is RoleNamespaceTarget =>
    typeof value === "object" && value !== null && "idFromName" in value && isCallable(value.idFromName);

/** The role an instance name belongs to: `shard` for an unprefixed name, `undefined` for a prefixed name with no known role. */
const roleOf = (name: string | undefined): MergedRole | "shard" | undefined => {
    if (!name?.startsWith(LUNORA_ROLE_PREFIX)) {
        return "shard";
    }

    const role = name.slice(LUNORA_ROLE_PREFIX.length, name.indexOf(":", LUNORA_ROLE_PREFIX.length));

    return MERGED_ROLES.find((candidate) => candidate === role);
};

/**
 * One Durable Object class that hosts the shard, the scheduler and the shard
 * registry, so an app spends one account class on the framework instead of
 * three (plan 462). The role is read from `ctx.id.name` once, in the
 * constructor — {@link roleNamespace} names carry `__lunora_do__:<role>:`,
 * every other name is a shard — and each instance keeps that role, with its own
 * storage, alarm and WebSockets, for life.
 */
const mergeDurableObjects = <Env = unknown>(roles: MergedRoles): MergedDurableObject<Env> =>
    class LunoraDO implements Required<DurableObjectHandlers> {
        readonly #role: DurableObjectHandlers;

        public constructor(state: DurableObjectState, env: Env) {
            const role = roleOf(state.id.name);
            const Role = role === undefined ? undefined : roles[role];

            if (Role === undefined) {
                throw new LunoraError("INTERNAL", `instance "${String(state.id.name)}" names no role merged into this Durable Object class`);
            }

            // The role classes type their own slices of state and env (see `RoleClass`).
            this.#role = new Role(state as never, env as never);
        }

        public async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
            await this.#role.alarm?.(alarmInfo);
        }

        // Every role answers requests, so a missing `fetch` is a wiring bug worth
        // surfacing; the other handlers are legitimately absent on some roles.
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
 *
 * A `Proxy`, so the result keeps the namespace's own type — whichever selector
 * shape the caller has — and every member the framework does not name by
 * (`get`, `idFromString`, …) passes through untouched. Methods are bound to the
 * namespace: workerd rejects a native method called on another receiver
 * ("Illegal invocation").
 */
const roleNamespace = <Namespace extends RoleNamespaceTarget>(namespace: Namespace, role: MergedRole): Namespace => {
    const prefix = `${LUNORA_ROLE_PREFIX}${role}:`;

    return new Proxy(namespace, {
        get: (target, property) => {
            const member: unknown = Reflect.get(target, property);

            if (!isCallable(member)) {
                return member;
            }

            if (property === "idFromName" || property === "getByName") {
                return (name: string, ...rest: unknown[]) => member.call(target, `${prefix}${name}`, ...rest);
            }

            if (property === "jurisdiction") {
                return (...arguments_: unknown[]) => {
                    const view = member.apply(target, arguments_);

                    return isNamespace(view) ? roleNamespace(view, role) : view;
                };
            }

            return member.bind(target);
        },
    });
};

export type { DurableObjectHandlers, MergedDurableObject, MergedRole, MergedRoles, RoleClass, RoleNamespaceTarget };
export { MERGED_ROLES, mergeDurableObjects, roleNamespace };
