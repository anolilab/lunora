/**
 * `ProvisionJob` → a plain-data plan the Alchemy program interprets.
 *
 * Pure and dependency-free so it is unit-tested from `apps/cloud/__tests__`
 * without Alchemy installed. Everything tenant-controlled (binding names,
 * class names, var and secret names, asset paths) is validated here and only
 * ever travels as data — the program is a static, reviewed file; no tenant
 * string is ever interpolated into source.
 *
 * Resource names are NOT derived here: the control plane computes them with the
 * contract's `tenantResourceName` and sends each one as `resourceName` on the
 * binding, so the naming scheme has exactly one implementation.
 *
 * Two targets (`ProvisionTarget` in the contract). A `dispatch-namespace` job
 * (`cloudflare-wfp`) lands in the cell's own account: a Worker in the namespace
 * (the stage), queue consumers attached to the control plane. An `account` job
 * (`cloudflare-workers`) lands in a customer's account: a plain Worker on its
 * `workers.dev` subdomain with its own cron triggers, consuming its own queues,
 * on stage `account-<id>`. The token never enters the plan — the server hands
 * it to the Alchemy child as process env, and the plan names only the account
 * id — and the STATE still lives in the platform's account (`state:
 * "platform"`), never the customer's.
 */

/**
 * @typedef {import("../../src/targets/provision-box/contract").ProvisionJob} ContractJob
 * @typedef {import("../../src/provision-contract").BindingRequirement & { resourceName?: string }} JobBinding
 * @typedef {Extract<ContractJob, { action: "deploy" }>["spec"]} ContractSpec
 * @typedef {Omit<ContractSpec, "manifest"> & { manifest: Omit<ContractSpec["manifest"], "bindings"> & { bindings: JobBinding[] } }} JobSpec
 * @typedef {{ action: "deploy", spec: JobSpec } | Extract<ContractJob, { action: "destroy" }>} ProvisionJob
 * @typedef {"d1" | "kv" | "queue" | "r2"} ProjectResourceKind
 * @typedef {{ id: string, kind: ProjectResourceKind, name: string }} ProjectResource
 * @typedef {{ id: string, queueId: string, scriptName: string }} QueueConsumer
 * @typedef {{ consumers: QueueConsumer[], resources: ProjectResource[], stackName: string }} ProjectStack
 * @typedef {{ binding: string, id: string, kind: "ref", resource: ProjectResourceKind } | { binding: string, kind: "ai" | "browser" | "images" } | { binding: string, className: string, kind: "durable_object" } | { binding: string, dataset: string, kind: "analytics_engine" }} WorkerBinding
 * @typedef {{ headers?: string, htmlHandling?: string, notFoundHandling?: string, redirects?: string, runWorkerFirst?: boolean | string[] }} AssetsConfig
 * @typedef {{ id: string, queueId: string }} WorkerConsumer
 * @typedef {{ assets?: { config: AssetsConfig }, bindings: WorkerBinding[], compatibility: { date: string, flags: string[] }, consumers: WorkerConsumer[], crons: string[], namespace?: string, secretNames: string[], stackName: string, tags: string[], tailConsumers: string[], vars: Record<string, string>, workerName: string }} WorkerStack
 * @typedef {{ kind: "project" | "worker", op: "deploy" | "destroy", stackName: string }} Step
 * @typedef {{ accountId: string, kind: "account" } | { kind: "dispatch-namespace", namespace: string }} PlanTarget
 * @typedef {{ project?: ProjectStack, stage: string, steps: Step[], target: PlanTarget, worker?: WorkerStack }} Plan
 * @typedef {{ apiToken: string, stateStore: { token: string, url: string } }} AccountCredentials
 * @typedef {{ credentials?: AccountCredentials, plan: Plan }} PlannedJob
 */

/** Platform default, used when the manifest does not declare its own. */
const DEFAULT_COMPATIBILITY_DATE = "2026-06-10";
/** Platform default, used when the manifest does not declare its own. */
const DEFAULT_COMPATIBILITY_FLAGS = ["nodejs_compat"];

/** A job that cannot be provisioned. The message is written for the tenant and is safe to echo. */
class PlanError extends Error {}

// Control-plane-issued identifiers. They name Alchemy stacks and the stage (which
// must also satisfy Alchemy's `--stage` pattern) and Cloudflare scripts.
const LABEL = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
// The deployment alias: one DNS label of dash-separated `[a-z0-9]` runs, at most
// 63 characters. A copy of `RELEASE_ALIAS_PATTERN` / `MAX_RELEASE_ALIAS_LENGTH`
// in `@lunora/config/celld`, the rule's one home: this file ships as plain JS
// in the provision container and cannot import it, so
// `__tests__/provision-plan.test.ts` pins the two together.
const ALIAS_PATTERN = /^[a-z\d]+(?:-[a-z\d]+)*$/u;
const MAX_ALIAS_LENGTH = 63;
// `env` property names: JavaScript identifiers, as the deploy handler enforces.
const BINDING_NAME = /^[A-Za-z_]\w{0,63}$/u;
const CLASS_NAME = /^[A-Za-z_$][\w$]{0,127}$/u;
// What `tenantResourceName` emits (Analytics Engine swaps `-` for `_`).
const RESOURCE_NAME = /^[a-z0-9][\w-]{0,62}$/u;
// A Cloudflare account id.
const ACCOUNT_ID = /^[\da-f]{32}$/u;
// The platform's Alchemy state store: an https origin on workers.dev.
const STATE_STORE_URL = /^https:\/\/[\w.-]+\.workers\.dev\/?$/u;
// One cron expression: five or six fields of the characters cron syntax uses.
const CRON = /^[\d*/,?#A-Za-z-]+(?: [\d*/,?#A-Za-z-]+){4,5}$/u;
/** The control plane's own cap on a release's crons (`startRelease`); Cloudflare's per-account limit is enforced by Cloudflare. */
const MAX_CRONS = 50;

/**
 * Assert a tenant- or control-plane-supplied value matches its grammar.
 * @param {unknown} value The value to check.
 * @param {RegExp} pattern The grammar it must match in full.
 * @param {string} what What the value is, for the error message.
 * @returns {string} The value, now known to be a matching string.
 */
const expect = (value, pattern, what) => {
    if (typeof value !== "string" || !pattern.test(value)) {
        throw new PlanError(`${what} ${JSON.stringify(value)} is not valid`);
    }

    return value;
};

/**
 * Assert a job's alias follows the alias rule ({@link ALIAS_PATTERN}).
 * @param {unknown} value The job's untrusted alias.
 * @returns {string} The alias.
 */
const expectAlias = (value) => {
    const alias = expect(value, ALIAS_PATTERN, "alias");

    if (alias.length > MAX_ALIAS_LENGTH) {
        throw new PlanError(`alias ${JSON.stringify(alias)} is not valid`);
    }

    return alias;
};

/**
 * Validate where a job lands. An account job's token and platform state store
 * are validated here and returned beside the plan, never in it: they are the
 * server's to hand to the Alchemy child, and `plan.json` is written to disk.
 * Whose state store holds a stack follows from the target: an account job's is
 * the platform's (reached over HTTP), a namespace job's the cell's own.
 * @param {unknown} target The job's untrusted `ProvisionTarget`.
 * @returns {{ credentials?: AccountCredentials, stage: string, target: PlanTarget }} The stage, the target as the program reads it, and an account job's credentials.
 */
const planTarget = (target) => {
    const candidate =
        /** @type {{ accountId?: unknown, apiToken?: unknown, dispatchNamespace?: unknown, kind?: unknown, state?: unknown } | null | undefined} */ (target);

    if (candidate?.kind === "dispatch-namespace") {
        const namespace = expect(candidate.dispatchNamespace, LABEL, "dispatch namespace");

        return { stage: namespace, target: { kind: "dispatch-namespace", namespace } };
    }

    if (candidate?.kind === "account") {
        const accountId = expect(candidate.accountId, ACCOUNT_ID, "account id");

        if (typeof candidate.apiToken !== "string" || candidate.apiToken === "") {
            throw new PlanError(`the job carries no token for account ${accountId}`);
        }

        // Without the platform's store the state would land in the customer's account; refuse instead.
        const { state: rawState } = candidate;
        const state = /** @type {{ token?: unknown, url?: unknown } | undefined} */ (rawState);

        if (typeof state?.token !== "string" || state.token === "" || typeof state.url !== "string" || !STATE_STORE_URL.test(state.url)) {
            throw new PlanError("the job names no platform state store, and an account job never keeps its state in the customer's account");
        }

        return {
            credentials: { apiToken: candidate.apiToken, stateStore: { token: state.token, url: state.url } },
            stage: `account-${accountId}`,
            target: { accountId, kind: "account" },
        };
    }

    throw new PlanError(`unknown target ${JSON.stringify(candidate?.kind)}`);
};

/**
 * @param {string} alias The project alias.
 * @returns {string} The Alchemy stack owning the project's resources.
 */
const projectStackName = (alias) => `lunora-project-${alias}`;

/**
 * The project's one Worker, named by its alias and converged in place by every
 * deploy and rollback, so its Durable Object storage outlives releases.
 * @param {string} alias The project alias — also the Worker's script name.
 * @returns {string} The Alchemy stack owning the project's Worker.
 */
const workerStackName = (alias) => `lunora-worker-${alias}`;

/**
 * Resolve one asset's URL path to a path relative to the assets directory,
 * refusing anything that could land outside it.
 * @param {unknown} path The tenant-supplied URL path, e.g. `/index.html`.
 * @returns {string} A relative POSIX path with no `.`/`..` segments.
 */
const assetRelativePath = (path) => {
    if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0") || path.includes("\\")) {
        throw new PlanError(`asset path ${JSON.stringify(path)} is not valid`);
    }

    const segments = path.slice(1).split("/");

    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        throw new PlanError(`asset path ${JSON.stringify(path)} is not valid`);
    }

    return segments.join("/");
};

/**
 * @param {JobBinding} requirement A provisioned binding.
 * @returns {string} The control plane's resource name for it, validated.
 */
const resourceName = (requirement) => {
    if (requirement.resourceName === undefined) {
        throw new PlanError(`binding ${requirement.binding} (${requirement.type}) arrived without a resourceName`);
    }

    return expect(requirement.resourceName, RESOURCE_NAME, `resource name for ${requirement.binding}`);
};

/**
 * What one binding contributes to the Worker, creating its project resource on the way.
 * @param {JobBinding} requirement The manifest entry (never a `queue_consumer`).
 * @param {string} binding Its validated `env` name.
 * @param {{ assets: JobSpec["assets"], consumed: Set<string | undefined>, consumers: WorkerConsumer[], controlPlaneScript: string | undefined, project: ProjectStack, provision: (requirement: JobBinding, kind: ProjectResourceKind) => string, target: PlanTarget }} context The deploy being planned.
 * @returns {WorkerBinding | undefined} The Worker's `env` entry, if the binding has one of its own.
 */
const planBinding = (requirement, binding, context) => {
    switch (requirement.type) {
        case "ai":
        case "browser":
        case "images": {
            return { binding, kind: requirement.type };
        }
        case "analytics_engine": {
            // A dataset is binding metadata only — it has no lifecycle, so it is
            // declared on the Worker rather than owned by the project.
            return { binding, dataset: resourceName(requirement), kind: "analytics_engine" };
        }
        case "assets": {
            // Alchemy always binds uploaded assets as `ASSETS` (WorkerProvider.ts);
            // any other name would be undefined at runtime.
            if (binding !== "ASSETS") {
                throw new PlanError(`the assets binding must be named ASSETS, not ${binding}`);
            }

            if (context.assets === undefined) {
                throw new PlanError("the manifest binds ASSETS but no asset files were uploaded");
            }

            // The upload is the Worker's `assets` prop; `ASSETS` comes with it.
            return undefined;
        }
        case "d1":
        case "kv":
        case "r2": {
            return { binding, id: context.provision(requirement, requirement.type), kind: "ref", resource: requirement.type };
        }
        case "durable_object": {
            // Alchemy creates every new class SQLite-backed (WorkerProvider.ts); a
            // KV-storage class still works there, as that API is a subset of SQLite's.
            return { binding, className: expect(requirement.className, CLASS_NAME, `class name for ${binding}`), kind: "durable_object" };
        }
        case "queue_producer": {
            const id = context.provision(requirement, "queue");

            if (requirement.resource !== undefined && context.consumed.has(requirement.resource)) {
                if (context.target.kind === "account") {
                    // A plain Worker consumes its own queue; attached once the Worker exists, in its stack.
                    context.consumers.push({ id: `${id}-consumer`, queueId: id });
                } else {
                    // A dispatch-namespace Worker cannot consume: the control plane drains the queue for it.
                    context.project.consumers.push({
                        id: `${id}-consumer`,
                        queueId: id,
                        scriptName: expect(context.controlPlaneScript, LABEL, "LUNORA_CONTROL_PLANE_SCRIPT"),
                    });
                }
            }

            return { binding, id, kind: "ref", resource: "queue" };
        }
        case "workflow": {
            // Alchemy registers a Workflow with the account-level `putWorkflow`
            // (Workflows/Workflow.ts), which has no dispatch-namespace variant, and
            // only for an Effect-native Workflow — not a prebuilt bundle's class.
            throw new PlanError(`workflow binding ${binding}: Workflows cannot be registered for a prebuilt Worker yet`);
        }
        default: {
            throw new PlanError(`binding ${binding} has type ${JSON.stringify(requirement.type)}, which Lunora Cloud does not provision`);
        }
    }
};

/**
 * The Worker's own cron triggers — only a plain Worker in an account carries them.
 * @param {unknown} crons The job's untrusted `crons`.
 * @param {PlanTarget} target Where the job lands.
 * @returns {string[]} The validated expressions.
 */
const planCrons = (crons, target) => {
    if (crons === undefined) {
        return [];
    }

    if (!Array.isArray(crons) || crons.length > MAX_CRONS) {
        throw new PlanError(`crons must be a list of at most ${MAX_CRONS} expressions`);
    }

    if (crons.length > 0 && target.kind !== "account") {
        throw new PlanError("a dispatch-namespace Worker cannot carry cron triggers; the control plane fans them out");
    }

    return crons.map((cron) => expect(cron, CRON, "cron expression"));
};

/**
 * @param {JobSpec} spec The deploy job's spec.
 * @param {string | undefined} controlPlaneScript The Worker that consumes routed queues.
 * @param {PlanTarget} target Where the job lands.
 * @returns {{ project: ProjectStack, worker: WorkerStack }} Both stacks' declarations.
 */
const planDeploy = (spec, controlPlaneScript, target) => {
    const alias = expectAlias(spec.alias);

    if (typeof spec.bundle !== "string" || spec.bundle === "") {
        throw new PlanError("the job carries no bundle");
    }

    // Checked up front so a bad path refuses the job before anything is written.
    for (const file of spec.assets?.files ?? []) {
        assetRelativePath(file.path);
    }

    /** @type {ProjectStack} */
    const project = { consumers: [], resources: [], stackName: projectStackName(alias) };
    const envNames = new Set();
    const resourceKeys = new Set();

    /**
     * @param {unknown} name A binding, var or secret name.
     * @returns {string} The name, validated and not yet used.
     */
    const claim = (name) => {
        const checked = expect(name, BINDING_NAME, "binding name");

        if (envNames.has(checked)) {
            throw new PlanError(`binding name ${checked} is declared more than once`);
        }

        envNames.add(checked);

        return checked;
    };

    /**
     * @param {JobBinding} requirement A provisioned binding.
     * @param {ProjectResourceKind} kind The resource it needs.
     * @returns {string} The resource's logical id in the project stack.
     */
    const provision = (requirement, kind) => {
        const name = resourceName(requirement);

        // Two bindings mapping to one resource would silently share data.
        if (resourceKeys.has(`${kind}:${name}`)) {
            throw new PlanError(`bindings resolve to the same ${kind} resource ${name}`);
        }

        resourceKeys.add(`${kind}:${name}`);

        // Logical ids derive from the validated name, never the raw binding.
        const id = `${kind}-${name}`;

        project.resources.push({ id, kind, name });

        return id;
    };

    /** @type {WorkerConsumer[]} */
    const consumers = [];
    const context = {
        assets: spec.assets,
        consumed: new Set(spec.manifest.bindings.flatMap((requirement) => (requirement.type === "queue_consumer" ? [requirement.resource] : []))),
        consumers,
        controlPlaneScript,
        project,
        provision,
        target,
    };
    // A queue consumer entry binds nothing: its queue is attached as the producer's consumer above.
    const bindings = spec.manifest.bindings.flatMap((requirement) =>
        requirement.type === "queue_consumer" ? [] : (planBinding(requirement, claim(requirement.binding), context) ?? []),
    );

    // Null prototype: a `__proto__` var stays an ordinary own key.
    const plainVariables = /** @type {Record<string, string>} */ (Object.create(null));

    for (const [name, value] of Object.entries(spec.vars ?? {})) {
        if (typeof value !== "string") {
            throw new PlanError(`var ${name} must be a string`);
        }

        plainVariables[claim(name)] = value;
    }

    const secretNames = Object.entries(spec.secrets).map(([name, value]) => {
        if (typeof value !== "string") {
            throw new PlanError(`secret ${name} must be a string`);
        }

        return claim(name);
    });
    const { _headers: headers, _redirects: redirects, ...assetsConfig } = spec.assets?.config ?? {};

    return {
        project,
        worker: {
            ...(spec.assets === undefined
                ? {}
                : {
                      assets: {
                          // Alchemy's `Workers.Worker` assets props: `headers` / `redirects`
                          // are the raw `_headers` / `_redirects` contents, which its
                          // Cloudflare client sends as `metadata.assets.config._headers` /
                          // `._redirects` — what wrangler sends for those files.
                          config: {
                              headers,
                              htmlHandling: assetsConfig.html_handling,
                              notFoundHandling: assetsConfig.not_found_handling,
                              redirects,
                              runWorkerFirst: assetsConfig.run_worker_first,
                          },
                      },
                  }),
            bindings,
            compatibility: {
                date: spec.manifest.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
                flags: [...(spec.manifest.compatibilityFlags ?? DEFAULT_COMPATIBILITY_FLAGS)],
            },
            consumers,
            crons: planCrons(spec.crons, target),
            ...(target.kind === "dispatch-namespace" ? { namespace: target.namespace } : {}),
            secretNames,
            stackName: workerStackName(alias),
            tags: [...spec.tags],
            tailConsumers: [...(spec.tailConsumers ?? [])],
            vars: plainVariables,
            workerName: alias,
        },
    };
};

/**
 * Plan a job: which stacks to deploy or destroy, in order, and what each declares.
 *
 * Deploy converges the project stack first (the Worker references its
 * resources), then the Worker. Destroy is only ever sent for a project that is
 * gone: it removes the Worker, then the project stack and its data.
 * @param {ProvisionJob} job The validated-by-the-handler, still-untrusted job.
 * @param {{ controlPlaneScript: string | undefined }} options `controlPlaneScript` consumes the producer queues.
 * @returns {PlannedJob} The plan `program.mjs` interprets, and the validated credentials an account job runs with — kept out of the plan.
 */
const planJob = (job, options) => {
    if (job.action === "destroy") {
        const alias = expectAlias(job.alias);
        const { credentials, ...placed } = planTarget(job.target);

        return {
            ...(credentials === undefined ? {} : { credentials }),
            plan: {
                ...placed,
                steps: [
                    { kind: "worker", op: "destroy", stackName: workerStackName(alias) },
                    { kind: "project", op: "destroy", stackName: projectStackName(alias) },
                ],
            },
        };
    }

    if (job.action !== "deploy") {
        throw new PlanError(`unknown action ${JSON.stringify(/** @type {{ action: unknown }} */ (job).action)}`);
    }

    const { credentials, ...placed } = planTarget(job.spec?.target);
    const { project, worker } = planDeploy(job.spec, options.controlPlaneScript, placed.target);

    return {
        ...(credentials === undefined ? {} : { credentials }),
        plan: {
            ...placed,
            project,
            steps: [
                { kind: "project", op: "deploy", stackName: project.stackName },
                { kind: "worker", op: "deploy", stackName: worker.stackName },
            ],
            worker,
        },
    };
};

export { ALIAS_PATTERN, assetRelativePath, DEFAULT_COMPATIBILITY_DATE, MAX_ALIAS_LENGTH, PlanError, planJob };
