/**
 * `@lunora/container/do` — the workerd-only half of the package.
 *
 * `@cloudflare/containers` imports `cloudflare:workers` at module scope, so
 * anything touching it lives behind this subpath: the package root stays
 * importable from Node tooling (codegen, config, app unit tests) while the
 * generated `_generated/containers.ts` imports the base class from here.
 */
import type { StopParams } from "@cloudflare/containers";
import { Container } from "@cloudflare/containers";

import { resolveContainerEnvVars as resolveContainerEnvVariables } from "../define-container";
import { emitContainerLifecycle } from "../lifecycle-event";
import type { ContainerDefinition } from "../types";
import type { DurableObjectJurisdiction } from "./report-lifecycle";
import { reportContainerLifecycle } from "./report-lifecycle";

type DurableObjectContext = ConstructorParameters<typeof Container>[0];

/**
 * Base class for the generated Container DO classes. Applies a
 * `defineContainer` definition onto `@cloudflare/containers`' `Container`:
 * port, sleep timeout, internet access, and the container environment (static
 * `env` merged with the declared Worker secrets — a declared-but-unset secret
 * fails fast here rather than starting a container without its credential).
 *
 * Generated subclasses stay one line of behavior:
 *
 * ```ts
 * export class TranscoderContainer extends LunoraContainer {
 *     constructor(ctx: DurableObjectState, env: Env) {
 *         super(ctx, env, transcoder, "transcoder");
 *     }
 * }
 * ```
 */
class LunoraContainer<Env = unknown> extends Container<Env> {
    /**
     * Data-residency jurisdiction the app's DOs are pinned to (codegen passes the
     * schema's `.jurisdiction("…")`). Used to pin the best-effort lifecycle report
     * to the same region as the root shard. `undefined` ⇒ un-pinned.
     */
    private readonly lunoraJurisdiction?: DurableObjectJurisdiction;
    /** The `lunora/containers.ts` export name, for lifecycle log correlation. */
    private readonly lunoraName: string;

    public constructor(
        context: DurableObjectContext,
        env: Env,
        definition: ContainerDefinition,
        exportName?: string,
        jurisdiction?: DurableObjectJurisdiction,
    ) {
        super(context, env, {
            defaultPort: definition.defaultPort,
            entrypoint: definition.entrypoint ? [...definition.entrypoint] : undefined,
            envVars: resolveContainerEnvVariables(definition, env as Record<string, unknown>, exportName),
            sleepAfter: definition.sleepAfter,
        });

        if (definition.enableInternet !== undefined) {
            this.enableInternet = definition.enableInternet;
        }

        // Multi-port + egress-firewall fields are `Container` instance
        // properties (not constructor options), applied here from the
        // definition. Each is guarded so an un-set field leaves the
        // `@cloudflare/containers` default in place.
        if (definition.requiredPorts !== undefined) {
            this.requiredPorts = [...definition.requiredPorts];
        }

        if (definition.interceptHttps !== undefined) {
            this.interceptHttps = definition.interceptHttps;
        }

        if (definition.allowedHosts !== undefined) {
            this.allowedHosts = [...definition.allowedHosts];
        }

        if (definition.deniedHosts !== undefined) {
            this.deniedHosts = [...definition.deniedHosts];
        }

        if (definition.pingEndpoint !== undefined) {
            this.pingEndpoint = definition.pingEndpoint;
        }

        this.lunoraName = exportName ?? "container";
        this.lunoraJurisdiction = jurisdiction;
    }

    public override onError(error: unknown): unknown {
        const envelope = emitContainerLifecycle(this.lunoraName, this.instanceId(), "error", error instanceof Error ? error.message : String(error));

        this.surfaceInStudioLogs(envelope);

        return super.onError(error);
    }

    public override async onStart(): Promise<void> {
        const envelope = emitContainerLifecycle(this.lunoraName, this.instanceId(), "start");

        this.surfaceInStudioLogs(envelope);

        await super.onStart();
    }

    public override async onStop(parameters: StopParams): Promise<void> {
        const envelope = emitContainerLifecycle(this.lunoraName, this.instanceId(), "stop", `${parameters.reason} (exit ${String(parameters.exitCode)})`);

        this.surfaceInStudioLogs(envelope);

        await super.onStop(parameters);
    }

    /**
     * Best-effort push of `envelope` into the root ShardDO's log buffer so it
     * also appears in the Studio Logs panel (the terminal already has it via
     * `emitContainerLifecycle`). Fire-and-forget and fully swallowed: a missing
     * `SHARD` binding, a missing admin token, or a fetch failure NEVER throws
     * out of a lifecycle hook — the `console` path stays the source of truth.
     */
    private surfaceInStudioLogs(envelope: ReturnType<typeof emitContainerLifecycle>): void {
        // Fire-and-forget. `reportContainerLifecycle` already swallows every
        // failure internally; the trailing `.catch` is belt-and-suspenders so a
        // rejected promise can never become an unhandled rejection out of a hook.
        reportContainerLifecycle(this.env, envelope, this.lunoraJurisdiction).catch(() => {});
    }

    /**
     * Per-instance correlation id: the Durable Object id, which Cloudflare also
     * injects into the container as `CLOUDFLARE_DURABLE_OBJECT_ID`. Read
     * defensively — the id shape varies and isn't worth crashing a hook over.
     */
    private instanceId(): string {
        try {
            const { id } = this.ctx as { id?: { toString: () => string } };

            return typeof id?.toString === "function" ? id.toString() : "unknown";
        } catch {
            return "unknown";
        }
    }
}

export { LunoraContainer };
// Re-exported so the generated `_generated/containers.ts` can surface it from the
// worker entry: the `Container` outbound-interception path (egress allow/deny
// lists, `interceptHttps`, runtime egress controls) routes container traffic
// through this WorkerEntrypoint, which the deployed worker must therefore export.
// Funneling it through `@lunora/container/do` keeps the app depending only on
// `@lunora/container`, never on `@cloudflare/containers` directly.
export { ContainerProxy } from "@cloudflare/containers";
