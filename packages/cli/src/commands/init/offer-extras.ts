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
import { EMAIL_ITEM, promptAuthProvider } from "../add/features";
import { MAIL_DESTINATION_PROMPT, resolveTypedDestination, withMailDestination } from "../add/mail";
import { promptBucketName, withStorageBucketName } from "../add/storage";
import type { RegistryManifest } from "../registry/types";

/**
 * A feature offered in the post-scaffold multi-select. `auth`/`email` carry a
 * sub-prompt or alias; every other value IS the registry item name applied
 * directly (`storage` → the `storage` registry item, etc.).
 */
type StackFeature = "auth" | "backup" | "crons" | "email" | "presence" | "ratelimit" | "storage";

/** Customize a resolved manifest before it is written (e.g. inject the chosen R2 bucket name). */
type OfferTransformManifest = (manifest: RegistryManifest) => RegistryManifest;

const STACK_FEATURE_OPTIONS: ReadonlyArray<{ description: string; label: string; value: StackFeature }> = [
    { description: "Sign-up / sign-in (asks which provider)", label: "Authentication", value: "auth" },
    { description: "Cloudflare Email Workers + a dev mail catcher", label: "Transactional email", value: "email" },
    { description: "Typed R2 buckets + signed URLs (@lunora/storage)", label: "File storage", value: "storage" },
    { description: "Token-bucket / sliding-window limits (@lunora/ratelimit)", label: "Rate limiting", value: "ratelimit" },
    { description: "Scheduled jobs via Cron Triggers (@lunora/scheduler)", label: "Cron jobs", value: "crons" },
    { description: "Live presence / who's-online over hibernated WebSockets", label: "Presence", value: "presence" },
    { description: "Snapshot + restore your Durable Object data", label: "Backups", value: "backup" },
];

interface OfferDeps {
    /**
     * Apply one or more registry items into the new project; resolves `true` on
     * success. `options.transformManifest` customizes each item's manifest before
     * it is written (used to inject the user-chosen R2 bucket name for storage).
     */
    apply: (names: ReadonlyArray<string>, options?: { transformManifest?: OfferTransformManifest }) => Promise<boolean>;
    /** When `false`, skip all prompts and print the later-setup hint. */
    interactive: boolean;
    logger: Logger;
    /** Multi-select among the stack features to add (TTY-backed in production). */
    multiSelect: (
        message: string,
        options: ReadonlyArray<{ description?: string; label: string; value: StackFeature }>,
        settings?: { defaults?: ReadonlyArray<StackFeature> },
    ) => Promise<StackFeature[]>;
    /** The new project's name — seeds smart defaults like the `project-uploads` bucket name. */
    projectName: string;
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
 * Auth: pick a provider, then prompt for the D1 database name. Every provider
 * (Clerk / Auth0 included) pulls in the base `auth` item via `requires`, and
 * that's what carries the D1 binding — so the name applies regardless of choice.
 */
const applyAuthFeature = async (deps: OfferDeps): Promise<void> => {
    const provider = await promptAuthProvider(deps.select);
    const databaseName = await promptDatabaseName(deps.text, deps.projectName);

    await deps.apply([provider], { transformManifest: (manifest) => withAuthDatabaseName(manifest, databaseName) });
};

/**
 * Email: ask for a verified destination address (the send-email binding ships a
 * placeholder). A blank or invalid answer keeps the placeholder to set later.
 */
const applyEmailFeature = async (deps: OfferDeps): Promise<void> => {
    const answer = await deps.text(MAIL_DESTINATION_PROMPT, { placeholder: "you@yourdomain.com" });
    const destination = resolveTypedDestination(answer, (message) => {
        deps.logger.warn(message);
    });

    await deps.apply([EMAIL_ITEM], destination === undefined ? undefined : { transformManifest: (manifest) => withMailDestination(manifest, destination) });
};

/**
 * Storage: prompt for the R2 bucket name (default `project-uploads`, sanitized).
 * R2 names are strict and wrangler rejects an invalid one on dev/deploy, so we
 * ask up front rather than ship a placeholder the user has to chase down.
 */
const applyStorageFeature = async (deps: OfferDeps): Promise<void> => {
    const bucketName = await promptBucketName(deps.text, deps.projectName);

    await deps.apply(["storage"], { transformManifest: (manifest) => withStorageBucketName(manifest, bucketName) });
};

/** Per-feature handlers that need a sub-prompt; everything else applies as its bare item name. */
const FEATURE_HANDLERS: Partial<Record<StackFeature, (deps: OfferDeps) => Promise<void>>> = {
    auth: applyAuthFeature,
    email: applyEmailFeature,
    storage: applyStorageFeature,
};

/**
 * Offer the stack features (auth, email, storage, rate limiting, crons,
 * presence, backups) in ONE multi-select after a successful scaffold. Auth,
 * email, and storage run a follow-up prompt (provider / destination / bucket
 * name); every other feature value is applied as its registry item directly.
 * Picked items are applied in selection order. Non-interactive: prints how to
 * add them later and changes nothing.
 */
const offerRegistryExtras = async (deps: OfferDeps): Promise<void> => {
    if (!deps.interactive) {
        // eslint-disable-next-line no-secrets/no-secrets -- a pipe-separated feature list, not a secret
        deps.logger.info("tip: add features later with `lunora add <auth|email|storage|ratelimit|crons|presence|backup>`.");

        return;
    }

    const picked = await deps.multiSelect("Which features do you want to add?", STACK_FEATURE_OPTIONS, { defaults: [] });

    // Sequential by design: the sub-prompts and each registry apply both mutate
    // shared project files (package.json, wrangler.jsonc) and prompt the user one
    // at a time — running them in parallel would interleave prompts and race the
    // file writes.
    for (const feature of picked) {
        const handler = FEATURE_HANDLERS[feature];

        // eslint-disable-next-line no-await-in-loop -- serial by design (shared file writes + one prompt at a time).
        await (handler ? handler(deps) : deps.apply([feature]));
    }
};

export { offerRegistryExtras, STACK_FEATURE_OPTIONS };
export type { OfferDeps, OfferTransformManifest, StackFeature };
