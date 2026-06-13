/**
 * `@cirrus/container/do` — the workerd-only half of the package.
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
 * export class TranscoderContainer extends CirrusContainer {
 *     constructor(ctx: DurableObjectState, env: Env) {
 *         super(ctx, env, transcoder, "transcoder");
 *     }
 * }
 * ```
 */
class CirrusContainer<Env = unknown> extends Container<Env> {
    /** The `cirrus/containers.ts` export name, for lifecycle log correlation. */
    private readonly cirrusName: string;

    public constructor(context: DurableObjectContext, env: Env, definition: ContainerDefinition, exportName?: string) {
        super(context, env, {
            defaultPort: definition.defaultPort,
            envVars: resolveContainerEnvVariables(definition, env as Record<string, unknown>, exportName),
            sleepAfter: definition.sleepAfter,
        });

        if (definition.enableInternet !== undefined) {
            this.enableInternet = definition.enableInternet;
        }

        this.cirrusName = exportName ?? "container";
    }

    public override onError(error: unknown): unknown {
        const envelope = emitContainerLifecycle(this.cirrusName, this.instanceId(), "error", error instanceof Error ? error.message : String(error));

        this.surfaceInStudioLogs(envelope);

        return super.onError(error);
    }

    public override async onStart(): Promise<void> {
        const envelope = emitContainerLifecycle(this.cirrusName, this.instanceId(), "start");

        this.surfaceInStudioLogs(envelope);

        await super.onStart();
    }

    public override async onStop(parameters: StopParams): Promise<void> {
        const envelope = emitContainerLifecycle(this.cirrusName, this.instanceId(), "stop", `${parameters.reason} (exit ${String(parameters.exitCode)})`);

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
        reportContainerLifecycle(this.env, envelope).catch(() => {});
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

export default CirrusContainer;
