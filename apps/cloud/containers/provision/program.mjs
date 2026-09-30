/**
 * The one Alchemy program the provision box runs — a static, reviewed file.
 *
 * `server.mjs` invokes it through the Alchemy CLI once per stack
 * (`alchemy deploy|destroy program.mjs --stage <namespace> --yes`) and hands it
 * everything tenant-derived as data: the plan `plan.mjs` produced (a JSON file
 * named by `LUNORA_PROVISION_PLAN`) and the release's secrets (JSON in
 * `LUNORA_SECRETS`, bound as `Redacted` so they upload as `secret_text` and
 * never render in a plan). `LUNORA_PROVISION_STACK` picks the stack.
 *
 * State lives in Alchemy's Cloudflare state store (`state()`): a Worker in the
 * cell's own account, bootstrapped on first use (`--yes`), so an ephemeral
 * container needs nothing but the account id and API token.
 */
/* eslint-disable import/no-unresolved -- alchemy and effect are installed in the image from this directory's own lockfile, not in the pnpm workspace ESLint resolves against; the module is type-checked against them separately (see README). */
import { readFileSync } from "node:fs";

import { Stack } from "alchemy";
import { AnalyticsEngine, D1, Images, KV, Providers, providers, Queues, R2, state, Workers } from "alchemy/Cloudflare";
import { State } from "alchemy/State/State";
import { Effect, Option, Redacted } from "effect";
/* eslint-enable import/no-unresolved */

/** @typedef {import("./plan.mjs").Plan & { assetsDirectory: string, workerMain: string }} ProgramPlan */

const plan = /** @type {ProgramPlan} */ (JSON.parse(readFileSync(/** @type {string} */ (process.env.LUNORA_PROVISION_PLAN), "utf8")));
const kind = process.env.LUNORA_PROVISION_STACK === "project" ? "project" : "release";
const step = plan.steps.find((candidate) => candidate.kind === kind);

if (step === undefined) {
    throw new Error(`the plan has no ${kind} step`);
}

/**
 * Declare one per-project resource. Buckets are `forceDestroy` because the only
 * thing that destroys the project stack is deleting the project, which is meant
 * to take its data with it.
 * @param {import("./plan.mjs").ProjectResource} resource The resource from the plan.
 * @returns {Effect.Effect<unknown, never, Providers>} The declaration.
 */
const declareResource = (resource) => {
    switch (resource.kind) {
        case "d1": {
            return D1.Database(resource.id, { name: resource.name });
        }
        case "kv": {
            return KV.Namespace(resource.id, { title: resource.name });
        }
        case "queue": {
            return Queues.Queue(resource.id, { name: resource.name });
        }
        case "r2": {
            return R2.Bucket(resource.id, { forceDestroy: true, name: resource.name });
        }
        default: {
            throw new Error(`unhandled resource kind in plan: ${JSON.stringify(resource)}`);
        }
    }
};

/**
 * Declare again a resource this stack already owns but this job does not
 * mention, with the props it was last deployed with.
 * @param {string} resourceType The type Alchemy persisted on the state row.
 * @param {string} id The row's logical id.
 * @param {import("alchemy/State/ResourceState").Props} props The row's persisted props.
 * @returns {Effect.Effect<unknown, never, Providers> | undefined} The declaration, or `undefined` for a type this program never creates.
 */
const redeclare = (resourceType, id, props) => {
    switch (resourceType) {
        case "Cloudflare.D1Database": {
            return D1.Database(id, props);
        }
        case "Cloudflare.KV.Namespace": {
            return KV.Namespace(id, props);
        }
        case "Cloudflare.Queues.Consumer": {
            return Queues.Consumer(id, /** @type {Queues.ConsumerProps} */ (props));
        }
        case "Cloudflare.Queues.Queue": {
            return Queues.Queue(id, props);
        }
        case "Cloudflare.R2.Bucket": {
            return R2.Bucket(id, props);
        }
        default: {
            return undefined;
        }
    }
};

/**
 * The project stack: every per-project resource, plus the control plane's
 * consumer on each routed queue.
 *
 * Additive on purpose. A release that drops a binding must not delete the
 * resource: retained releases (rollback targets) still bind it, and it holds
 * data. So every resource already in this stack's state is declared again with
 * its persisted props; resources are only ever removed by destroying the stack.
 * @param {import("./plan.mjs").ProjectStack} project The project declarations.
 * @returns {Effect.Effect<void, unknown, Providers>} The stack body.
 */
const projectStack = (project) =>
    Effect.gen(function* projectStackBody() {
        const declared = new Set();
        /** @type {Record<string, Queues.Queue>} */
        const queues = {};

        for (const resource of project.resources) {
            const created = yield* declareResource(resource);

            declared.add(resource.id);

            if (resource.kind === "queue") {
                queues[resource.id] = /** @type {Queues.Queue} */ (created);
            }
        }

        for (const consumer of project.consumers) {
            yield* Queues.Consumer(consumer.id, {
                queueId: /** @type {Queues.Queue} */ (queues[consumer.queueId]).queueId,
                scriptName: consumer.scriptName,
            });
            declared.add(consumer.id);
        }

        // The stack's own state layer is in context (Stack.ts builds it into the
        // body's services); `serviceOption` reads it without widening the body's
        // declared requirements past what `Stack` accepts.
        const store = yield* Option.getOrThrowWith(yield* Effect.serviceOption(State), () => new Error("the stack's state store is not in context"));

        for (const fqn of yield* store.list({ stack: project.stackName, stage: plan.stage })) {
            const row = yield* store.get({ fqn, stack: project.stackName, stage: plan.stage });

            if (row !== undefined && "resourceType" in row && row.props !== undefined && !declared.has(row.logicalId)) {
                const declaration = redeclare(row.resourceType, row.logicalId, row.props);

                if (declaration !== undefined) {
                    yield* declaration;
                }
            }
        }
    });

/**
 * One `env` entry for the release Worker.
 * @param {import("./plan.mjs").ReleaseBinding} binding The binding from the plan.
 * @param {string} projectStackName The stack whose state holds the project's resources.
 * @returns {Effect.Effect<Workers.WorkerBindingResource>} The binding value to put on `env`.
 */
const envBinding = (binding, projectStackName) => {
    const reference = { stack: projectStackName, stage: plan.stage };

    switch (binding.kind) {
        case "ai": {
            return Effect.succeed(Workers.AI(binding.binding));
        }
        case "analytics_engine": {
            return AnalyticsEngine.Dataset(binding.binding, { dataset: binding.dataset });
        }
        case "browser": {
            return Effect.succeed(Workers.Browser(binding.binding));
        }
        case "durable_object": {
            return Effect.succeed(Workers.DurableObject(binding.binding, { className: binding.className }));
        }
        case "images": {
            return Effect.succeed(Images.Images(binding.binding));
        }
        case "ref": {
            // A typed reference into the project stack's state (Resource.ts `ref`),
            // classified by the Worker exactly like a locally declared resource.
            switch (binding.resource) {
                case "d1": {
                    return D1.Database.ref(binding.id, reference);
                }
                case "kv": {
                    return KV.Namespace.ref(binding.id, reference);
                }
                case "queue": {
                    return Queues.Queue.ref(binding.id, reference);
                }
                case "r2": {
                    return R2.Bucket.ref(binding.id, reference);
                }
                default: {
                    break;
                }
            }

            break;
        }
        default: {
            break;
        }
    }

    throw new Error(`unhandled binding in plan: ${JSON.stringify(binding)}`);
};

/**
 * The release stack: one Worker in the dispatch namespace, bound to the
 * project's resources by reference.
 * @param {import("./plan.mjs").ReleaseStack} release The release declarations.
 * @param {string} projectStackName The stack whose state holds the project's resources.
 * @returns {Effect.Effect<void, unknown, Providers>} The stack body.
 */
const releaseStack = (release, projectStackName) =>
    Effect.gen(function* releaseStackBody() {
        const secrets = /** @type {Record<string, string>} */ (JSON.parse(process.env.LUNORA_SECRETS ?? "{}"));
        // Null prototype: binding names are tenant data, and `__proto__` must stay
        // an own key rather than reach Object.prototype.
        /** @type {Workers.WorkerBindingProps} */
        const env = Object.create(null);

        for (const binding of release.bindings) {
            env[binding.binding] = yield* envBinding(binding, projectStackName);
        }

        for (const [name, value] of Object.entries(release.vars)) {
            env[name] = value;
        }

        for (const name of release.secretNames) {
            env[name] = Redacted.make(/** @type {string} */ (secrets[name]));
        }

        yield* Workers.Worker("Worker", {
            // The prebuilt module, uploaded byte-for-byte (`bundle: false`) rather
            // than through `script`, so a multi-megabyte bundle never lands in the
            // state store as a prop.
            bundle: false,
            compatibility: release.compatibility,
            env,
            main: plan.workerMain,
            name: release.workerName,
            namespace: release.namespace,
            tags: release.tags,
            tailConsumers: release.tailConsumers,
            ...(release.assets === undefined
                ? {}
                : {
                      assets: {
                          directory: plan.assetsDirectory,
                          ...Object.fromEntries(Object.entries(release.assets.config).filter(([, value]) => value !== undefined)),
                      },
                  }),
        });
    });

/**
 * The body of the stack this invocation addresses. A state-store or API failure
 * fails the run either way; `orDie` says so to the type `Stack` accepts.
 * @returns {Effect.Effect<void, never, Providers>} The stack body.
 */
const body = () => {
    // Destroy plans from state alone; declarations are irrelevant to it.
    if (step.op === "destroy") {
        return Effect.void;
    }

    if (kind === "project" && plan.project !== undefined) {
        return projectStack(plan.project).pipe(Effect.orDie);
    }

    if (kind === "release" && plan.release !== undefined) {
        const projectStackName = plan.steps.find((candidate) => candidate.kind === "project")?.stackName ?? "";

        return releaseStack(plan.release, projectStackName).pipe(Effect.orDie);
    }

    throw new Error(`the plan has no ${kind} declaration`);
};

export default Stack(step.stackName, { providers: providers(), state: state() }, body());
