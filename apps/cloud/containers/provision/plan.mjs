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
 */

/**
 * @typedef {import("../../src/provision-contract").ProvisionJob} ContractJob
 * @typedef {import("../../src/provision-contract").BindingRequirement & { resourceName?: string }} JobBinding
 * @typedef {Extract<ContractJob, { action: "deploy" }>["spec"]} ContractSpec
 * @typedef {Omit<ContractSpec, "manifest"> & { manifest: Omit<ContractSpec["manifest"], "bindings"> & { bindings: JobBinding[] } }} JobSpec
 * @typedef {{ action: "deploy", spec: JobSpec } | Extract<ContractJob, { action: "destroy" }>} ProvisionJob
 * @typedef {"d1" | "kv" | "queue" | "r2"} ProjectResourceKind
 * @typedef {{ id: string, kind: ProjectResourceKind, name: string }} ProjectResource
 * @typedef {{ id: string, queueId: string, scriptName: string }} QueueConsumer
 * @typedef {{ consumers: QueueConsumer[], resources: ProjectResource[], stackName: string }} ProjectStack
 * @typedef {{ binding: string, id: string, kind: "ref", resource: ProjectResourceKind } | { binding: string, kind: "ai" | "browser" | "images" } | { binding: string, className: string, kind: "durable_object" } | { binding: string, dataset: string, kind: "analytics_engine" }} ReleaseBinding
 * @typedef {{ htmlHandling?: string, notFoundHandling?: string, runWorkerFirst?: boolean | string[] }} AssetsConfig
 * @typedef {{ assets?: { config: AssetsConfig }, bindings: ReleaseBinding[], compatibility: { date: string, flags: string[] }, namespace: string, secretNames: string[], stackName: string, tags: string[], tailConsumers: string[], vars: Record<string, string>, workerName: string }} ReleaseStack
 * @typedef {{ kind: "project" | "release", op: "deploy" | "destroy", stackName: string }} Step
 * @typedef {{ project?: ProjectStack, release?: ReleaseStack, stage: string, steps: Step[] }} Plan
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
const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
// `env` property names: JavaScript identifiers, as the deploy handler enforces.
const BINDING_NAME = /^[A-Za-z_]\w{0,63}$/u;
const CLASS_NAME = /^[A-Za-z_$][\w$]{0,127}$/u;
// What `tenantResourceName` emits (Analytics Engine swaps `-` for `_`).
const RESOURCE_NAME = /^[a-z0-9][\w-]{0,62}$/u;

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
 * @param {string} alias The project alias.
 * @returns {string} The Alchemy stack owning the project's resources.
 */
const projectStackName = (alias) => `lunora-project-${alias}`;

/**
 * @param {string} scriptName The release's script name.
 * @returns {string} The Alchemy stack owning the release's Worker.
 */
const releaseStackName = (scriptName) => `lunora-release-${scriptName}`;

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
 * What one binding contributes to the release, creating its project resource on the way.
 * @param {JobBinding} requirement The manifest entry (never a `queue_consumer`).
 * @param {string} binding Its validated `env` name.
 * @param {{ assets: JobSpec["assets"], consumed: Set<string | undefined>, controlPlaneScript: string | undefined, project: ProjectStack, provision: (requirement: JobBinding, kind: ProjectResourceKind) => string }} context The deploy being planned.
 * @returns {ReleaseBinding | undefined} The release `env` entry, if the binding has one of its own.
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
            // declared on the release rather than owned by the project.
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
                context.project.consumers.push({
                    id: `${id}-consumer`,
                    queueId: id,
                    scriptName: expect(context.controlPlaneScript, LABEL, "LUNORA_CONTROL_PLANE_SCRIPT"),
                });
            }

            return { binding, id, kind: "ref", resource: "queue" };
        }
        case "workflow": {
            // Alchemy registers a Workflow with the account-level `putWorkflow`
            // (Workflows/Workflow.ts), which has no dispatch-namespace variant.
            throw new PlanError(`workflow binding ${binding}: Workflows cannot be registered for a Workers for Platforms script yet`);
        }
        default: {
            throw new PlanError(`binding ${binding} has type ${JSON.stringify(requirement.type)}, which Lunora Cloud does not provision`);
        }
    }
};

/**
 * @param {JobSpec} spec The deploy job's spec.
 * @param {string | undefined} controlPlaneScript The Worker that consumes routed queues.
 * @returns {{ project: ProjectStack, release: ReleaseStack }} Both stacks' declarations.
 */
const planDeploy = (spec, controlPlaneScript) => {
    const alias = expect(spec.alias, LABEL, "alias");
    const scriptName = expect(spec.scriptName, SCRIPT_NAME, "script name");

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

    const context = {
        assets: spec.assets,
        consumed: new Set(spec.manifest.bindings.filter((requirement) => requirement.type === "queue_consumer").map((requirement) => requirement.resource)),
        controlPlaneScript,
        project,
        provision,
    };
    // Queue consumers are routed: the control plane consumes the producer queue.
    const bindings = spec.manifest.bindings
        .filter((requirement) => requirement.type !== "queue_consumer")
        .flatMap((requirement) => planBinding(requirement, claim(requirement.binding), context) ?? []);

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
    const assetsConfig = spec.assets?.config;

    return {
        project,
        release: {
            ...(spec.assets === undefined
                ? {}
                : {
                      assets: {
                          config: {
                              htmlHandling: assetsConfig?.html_handling,
                              notFoundHandling: assetsConfig?.not_found_handling,
                              runWorkerFirst: assetsConfig?.run_worker_first,
                          },
                      },
                  }),
            bindings,
            compatibility: {
                date: spec.manifest.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
                flags: [...(spec.manifest.compatibilityFlags ?? DEFAULT_COMPATIBILITY_FLAGS)],
            },
            namespace: expect(spec.dispatchNamespace, LABEL, "dispatch namespace"),
            secretNames,
            stackName: releaseStackName(scriptName),
            tags: [...spec.tags],
            tailConsumers: [...(spec.tailConsumers ?? [])],
            vars: plainVariables,
            workerName: scriptName,
        },
    };
};

/**
 * Plan a job: which stacks to deploy or destroy, in order, and what each declares.
 *
 * Deploy converges the project stack first (the release references its
 * resources), then the release. Destroy removes the release, then — only when
 * asked — the project and its data.
 * @param {ProvisionJob} job The validated-by-the-handler, still-untrusted job.
 * @param {{ controlPlaneScript: string | undefined }} options `controlPlaneScript` consumes the producer queues.
 * @returns {Plan} The plan `program.mjs` interprets.
 */
const planJob = (job, options) => {
    if (job.action === "destroy") {
        const alias = expect(job.alias, LABEL, "alias");
        const scriptName = expect(job.scriptName, SCRIPT_NAME, "script name");
        /** @type {Step[]} */
        const steps = [{ kind: "release", op: "destroy", stackName: releaseStackName(scriptName) }];

        if (job.deleteProjectResources) {
            steps.push({ kind: "project", op: "destroy", stackName: projectStackName(alias) });
        }

        return { stage: expect(job.dispatchNamespace, LABEL, "dispatch namespace"), steps };
    }

    if (job.action !== "deploy") {
        throw new PlanError(`unknown action ${JSON.stringify(/** @type {{ action: unknown }} */ (job).action)}`);
    }

    const { project, release } = planDeploy(job.spec, options.controlPlaneScript);

    return {
        project,
        release,
        stage: release.namespace,
        steps: [
            { kind: "project", op: "deploy", stackName: project.stackName },
            { kind: "release", op: "deploy", stackName: release.stackName },
        ],
    };
};

export { assetRelativePath, DEFAULT_COMPATIBILITY_DATE, PlanError, planJob };
