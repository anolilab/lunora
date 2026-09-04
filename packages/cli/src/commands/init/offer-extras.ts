/**
 * The post-scaffold "which features do you want?" offer for `lunora init`.
 *
 * The multi-select, the auth-provider sub-select, and the registry apply step
 * are all injected ({@link OfferDeps}) so this logic is pure and unit-testable
 * without a TTY or the network: the CLI wires real readline prompts +
 * `runAddCommand`, tests pass fakes. Skipped entirely in a non-interactive
 * context (CI / `--yes` / no TTY) — it prints a one-line hint instead of
 * blocking automation.
 */
import type { Logger } from "../../util/logger";
import { promptDatabaseName, withAuthDatabaseName } from "../add/auth-database";
import type { FeatureItem } from "../add/features";
import { AUTH_UI_REACT_NATIVE_REFUSAL, EMAIL_ITEM, promptAuthProvider } from "../add/features";
import { MAIL_DESTINATION_PROMPT, resolveTypedDestination, withMailDestination } from "../add/mail";
import { promptBucketName, withStorageBucketName } from "../add/storage";
import type { RegistryManifest } from "../registry/types";

/**
 * A feature offered in the post-scaffold multi-select. `auth`/`email` carry a
 * sub-prompt or alias; every other value IS the registry item name applied
 * directly (`storage` → the `storage` registry item, etc.).
 */
type StackFeature =
    | "ai"
    | "auth"
    | "auth-ui"
    | "backup"
    | "browser"
    | "cloudflare-access"
    | "crons"
    | "email"
    | "flags"
    | "hyperdrive"
    | "payment"
    | "presence"
    | "queue"
    | "storage"
    | "workflow";

/** Customize a resolved manifest before it is written (e.g. inject the chosen R2 bucket name). */
type OfferTransformManifest = (manifest: RegistryManifest) => RegistryManifest;

const STACK_FEATURE_OPTIONS: ReadonlyArray<{ description: string; label: string; value: StackFeature }> = [
    { description: "LLMs via Workers AI (summarize, generate, stream)", label: "AI", value: "ai" },
    { description: "Sign-up / sign-in (asks which provider)", label: "Authentication", value: "auth" },
    { description: "Copy-in auth screens for your framework (sign in/up, reset, 2FA)", label: "Auth UI", value: "auth-ui" },
    { description: "Snapshot + restore your Durable Object data", label: "Backups", value: "backup" },
    { description: "Headless browser screenshots + PDFs", label: "Browser rendering", value: "browser" },
    { description: "Zero Trust identity via Cloudflare Access", label: "Cloudflare Access", value: "cloudflare-access" },
    { description: "Scheduled jobs via Cron Triggers (@lunora/scheduler)", label: "Cron jobs", value: "crons" },
    { description: "Cloudflare Email Workers + a dev mail catcher", label: "Transactional email", value: "email" },
    { description: "OpenFeature feature flags (ctx.flags)", label: "Feature flags", value: "flags" },
    { description: "External Postgres/MySQL via Hyperdrive", label: "Hyperdrive", value: "hyperdrive" },
    { description: "Stripe-first payments (checkout, subscription, webhooks)", label: "Payments", value: "payment" },
    { description: "Live presence / who's-online over hibernated WebSockets", label: "Presence", value: "presence" },
    { description: "Async message queues (push/pull consumers)", label: "Queues", value: "queue" },
    { description: "Typed R2 buckets + signed URLs (@lunora/storage)", label: "File storage", value: "storage" },
    { description: "Durable long-running workflows (step.do, sleep, branch)", label: "Workflows", value: "workflow" },
];

/** The selectable feature values, for validating a `--add` list. */
const STACK_FEATURE_VALUES: ReadonlyArray<StackFeature> = STACK_FEATURE_OPTIONS.map((option) => option.value);

/** Map a feature value to the registry item it applies as (most are identity; `email` → the mail item). */
const featureItem = (feature: StackFeature): string => (feature === "email" ? EMAIL_ITEM : feature);

/**
 * Parse a comma-separated `--add` list into known features, in first-seen order,
 * warning on (and dropping) anything unrecognized. Deduplicates.
 */
const parseFeatureList = (raw: string, warn: (message: string) => void): StackFeature[] => {
    const features: StackFeature[] = [];

    for (const part of raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)) {
        if ((STACK_FEATURE_VALUES as ReadonlyArray<string>).includes(part)) {
            if (!features.includes(part as StackFeature)) {
                features.push(part as StackFeature);
            }
        } else {
            warn(`init: unknown --add feature "${part}" — expected ${STACK_FEATURE_VALUES.join(" | ")}; skipping.`);
        }
    }

    return features;
};

/**
 * One feature ready to apply: the registry item name(s), an optional manifest
 * transform, and a short `label` (the feature value) shown on the combined
 * progress line. Built up-front by the collectors so every prompt is answered
 * before any apply runs.
 */
interface FeatureApply {
    label: string;
    names: ReadonlyArray<string>;
    transformManifest?: OfferTransformManifest;
}

interface OfferDeps {
    /**
     * Apply the collected features into the new project in one batch — resolves
     * `true` when every item succeeds. The CLI renders this as a single progress
     * line whose label changes per feature; each plan's `transformManifest`
     * customizes that item's manifest before it is written.
     */
    applyAll: (plans: ReadonlyArray<FeatureApply>) => Promise<boolean>;
    /** When `false`, skip all prompts and print the later-setup hint. */
    interactive: boolean;
    logger: Logger;
    /** Multi-select among the stack features to add (TTY-backed in production). */
    multiSelect: (
        message: string,
        options: ReadonlyArray<{ description?: string; label: string; value: StackFeature }>,
        settings?: { defaults?: ReadonlyArray<StackFeature> },
    ) => Promise<StackFeature[]>;

    /**
     * Features chosen non-interactively (the `--add` flag). When set, the
     * multi-select and every sub-prompt are skipped — each feature is applied with
     * its shipped defaults (base registry item, placeholder bindings).
     */
    preselected?: ReadonlyArray<StackFeature>;
    /** The new project's name — seeds smart defaults like the `project-uploads` bucket name. */
    projectName: string;

    /**
     * Resolve which per-framework auth-UI item (`auth-ui-react|vue|…`) fits the
     * scaffolded project. Injected by the CLI (detected from the template's deps);
     * defaults to `auth-ui-react` when absent so this module stays pure/testable.
     *
     * `undefined` is a REFUSAL, not "unknown": no auth-UI item fits this project
     * (React Native). `lunora add auth-ui` already refuses there, and this offer
     * used to `?? "auth-ui-react"` its way past that — copying ~85 DOM files into
     * an Expo app and exiting 0.
     */
    resolveAuthUiItem?: () => string | undefined;
    /** Single-select among the auth providers (TTY-backed in production). */
    select: (
        message: string,
        options: ReadonlyArray<{ description?: string; label: string; value: FeatureItem }>,
        settings?: { default?: FeatureItem },
    ) => Promise<FeatureItem | undefined>;
    /** Single-line text input (TTY-backed in production) — used for the storage bucket-name prompt. */
    text: (message: string, settings?: { default?: string; placeholder?: string }) => Promise<string>;
}

/**
 * The auth-UI item for the scaffolded project, or `undefined` when none fits.
 *
 * `resolveAuthUiItem` being ABSENT (tests, a caller with no project to read) is
 * not the same as it ANSWERING `undefined` — the first means "nobody looked",
 * the second is the React Native refusal. Collapsing the two with `?.()` is what
 * let the refusal read as a missing injection and fall through to the default.
 */
const authUiItem = (deps: OfferDeps): string | undefined => (deps.resolveAuthUiItem === undefined ? "auth-ui-react" : deps.resolveAuthUiItem());

/**
 * Auth: pick a provider, then prompt for the D1 database name. Every provider
 * (Clerk / Auth0 included) pulls in the base `auth` item via `requires`, and
 * that's what carries the D1 binding — so the name applies regardless of choice.
 */
const collectAuthFeature = async (deps: OfferDeps): Promise<FeatureApply> => {
    const provider = await promptAuthProvider(deps.select);
    const databaseName = await promptDatabaseName(deps.text, deps.projectName);

    return { label: "auth", names: [provider], transformManifest: (manifest) => withAuthDatabaseName(manifest, databaseName) };
};

/**
 * Email: ask for a verified destination address (the send-email binding ships a
 * placeholder). A blank or invalid answer keeps the placeholder to set later.
 */
const collectEmailFeature = async (deps: OfferDeps): Promise<FeatureApply> => {
    const answer = await deps.text(MAIL_DESTINATION_PROMPT, { placeholder: "you@yourdomain.com" });
    const destination = resolveTypedDestination(answer, (message) => {
        deps.logger.warn(message);
    });

    return {
        label: "email",
        names: [EMAIL_ITEM],
        transformManifest: destination === undefined ? undefined : (manifest) => withMailDestination(manifest, destination),
    };
};

/**
 * Auth UI: resolve the per-framework item (detected from the scaffolded project)
 * and — because it `requires` the base `auth` item — prompt for the D1 database
 * name, reusing the same transform as {@link collectAuthFeature} so Auth UI alone
 * is enough to stand up a working auth setup.
 *
 * `authAlsoPicked` skips that prompt when Authentication was selected too: the
 * two sit next to each other in the multi-select and are a natural pair, and
 * asking the same question twice invites two different answers for one `auth`
 * item.
 */
const collectAuthUiFeature = async (deps: OfferDeps, authAlsoPicked: boolean): Promise<FeatureApply | undefined> => {
    const item = authUiItem(deps);

    if (item === undefined) {
        deps.logger.error(`init: ${AUTH_UI_REACT_NATIVE_REFUSAL}`);

        return undefined;
    }

    if (authAlsoPicked) {
        return { label: "auth-ui", names: [item] };
    }

    const databaseName = await promptDatabaseName(deps.text, deps.projectName);

    return { label: "auth-ui", names: [item], transformManifest: (manifest) => withAuthDatabaseName(manifest, databaseName) };
};

/**
 * Storage: prompt for the R2 bucket name (default `project-uploads`, sanitized).
 * R2 names are strict and wrangler rejects an invalid one on dev/deploy, so we
 * ask up front rather than ship a placeholder the user has to chase down.
 */
const collectStorageFeature = async (deps: OfferDeps): Promise<FeatureApply> => {
    const bucketName = await promptBucketName(deps.text, deps.projectName);

    return { label: "storage", names: ["storage"], transformManifest: (manifest) => withStorageBucketName(manifest, bucketName) };
};

/**
 * Map the `--add` list onto plans with each feature's shipped defaults — no
 * multi-select, no sub-prompts (scriptable / repeatable). `refused` reports
 * whether a feature was dropped because nothing fits this project, which the
 * caller folds into the exit code.
 */
const preselectedPlans = (deps: OfferDeps, preselected: ReadonlyArray<StackFeature>): { plans: FeatureApply[]; refused: boolean } => {
    const plans: FeatureApply[] = [];
    let refused = false;

    for (const feature of preselected) {
        // `auth-ui` resolves to a per-framework item; everything else maps 1:1
        // (with `email` → the mail item). The base `auth` item keeps its
        // placeholder D1 name here, since no sub-prompt runs.
        if (feature !== "auth-ui") {
            plans.push({ label: feature, names: [featureItem(feature)] });

            continue;
        }

        const item = authUiItem(deps);

        if (item === undefined) {
            deps.logger.error(`init: ${AUTH_UI_REACT_NATIVE_REFUSAL}`);
            refused = true;

            continue;
        }

        plans.push({ label: feature, names: [item] });
    }

    return { plans, refused };
};

/** Per-feature collectors that need a sub-prompt; everything else applies as its bare item name. */
const FEATURE_COLLECTORS: Partial<Record<StackFeature, (deps: OfferDeps, picked: ReadonlyArray<StackFeature>) => Promise<FeatureApply | undefined>>> = {
    auth: collectAuthFeature,
    "auth-ui": async (deps, picked) => collectAuthUiFeature(deps, picked.includes("auth")),
    email: collectEmailFeature,
    storage: collectStorageFeature,
};

/**
 * Offer the stack features (ai, auth, backup, browser, cloudflare-access,
 * crons, email, flags, hyperdrive, payment, presence, queue, storage,
 * workflow) in ONE multi-select after a successful scaffold. Auth,
 * presence, backups) in ONE multi-select after a successful scaffold. Auth,
 * email, and storage run a follow-up prompt (provider / destination / bucket
 * name); every other feature value is applied as its registry item directly.
 *
 * Every question is asked FIRST (in selection order), then the picked features
 * are applied together via {@link OfferDeps.applyAll} — the CLI renders that as a
 * single progress line whose label changes per feature, instead of one spinner
 * per item. Non-interactive: prints how to add them later and changes nothing.
 */
const offerRegistryExtras = async (deps: OfferDeps): Promise<boolean> => {
    // `--add`: apply the named features with their shipped defaults — no
    // multi-select, no sub-prompts (scriptable / repeatable).
    if (deps.preselected !== undefined && deps.preselected.length > 0) {
        const { plans, refused } = preselectedPlans(deps, deps.preselected);

        // Both halves reach the exit code: `--add` is the scriptable form, so a
        // feature that could not be added must fail the run — a refused one no
        // less than one whose apply errored. The INTERACTIVE offer below stays
        // best-effort — declining or failing an optional extra must not fail a
        // scaffold the user already saw succeed.
        const applied = await deps.applyAll(plans);

        return applied && !refused;
    }

    if (!deps.interactive) {
        deps.logger.info(
            // eslint-disable-next-line no-secrets/no-secrets -- the pipe-separated feature list in this tip is a UI prompt, not a credential
            "tip: add features later with `lunora add <ai|auth|backup|browser|cloudflare-access|crons|email|flags|hyperdrive|payment|presence|queue|storage|workflow>`.",
        );

        return true;
    }

    const picked = await deps.multiSelect("Which features do you want to add?", STACK_FEATURE_OPTIONS, { defaults: [] });

    if (picked.length === 0) {
        return true;
    }

    // Collect every answer first. Sequential by design: each sub-prompt asks the
    // user one at a time, so running them in parallel would interleave prompts.
    const plans: FeatureApply[] = [];

    for (const feature of picked) {
        const collect = FEATURE_COLLECTORS[feature];
        // eslint-disable-next-line no-await-in-loop -- serial by design (one prompt at a time).
        const plan = collect ? await collect(deps, picked) : { label: feature, names: [feature] };

        // A collector answering `undefined` refused this feature (and said why);
        // drop it rather than applying a payload that does not fit the project.
        if (plan !== undefined) {
            plans.push(plan);
        }
    }

    // Then apply them all in one batch — one progress line for the whole stack.
    // Best-effort by design: the scaffold has already been announced as complete.
    await deps.applyAll(plans);

    return true;
};

export { offerRegistryExtras, parseFeatureList, STACK_FEATURE_OPTIONS };
export type { FeatureApply, OfferDeps, OfferTransformManifest, StackFeature };
