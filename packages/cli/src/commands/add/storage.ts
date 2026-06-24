/**
 * Storage-feature helpers shared by `lunora init`'s post-scaffold offer and
 * `lunora add storage`.
 *
 * The `storage` manifest ships an R2 binding with a placeholder `bucket_name`.
 * Cloudflare bucket names are strict — lowercase letters, digits and hyphens,
 * 3–63 chars, starting and ending alphanumeric — and wrangler validates them on
 * `dev`/`deploy`, so an invalid name blocks the dev server from even starting.
 * Rather than ship a name the user must hunt down and hand-fix, the front doors
 * prompt for one and rewrite the manifest binding before it lands in wrangler.jsonc.
 */
import type { TextPrompt } from "../../util/tui-prompts";
import type { RegistryManifest } from "../registry/types";
import { setBindingField } from "../registry/types";
import toKebabSlug from "./slug";

/** The R2 bucket binding name the `storage` item declares (and the functions read via `env.UPLOADS`). */
const UPLOADS_BINDING = "UPLOADS";

/** The bucket-name prompt shared by both front doors, so the wording can't drift. */
const STORAGE_BUCKET_PROMPT = "Name your R2 bucket (you can rename it in wrangler.jsonc later)";

/**
 * Coerce arbitrary text into a Cloudflare-valid R2 bucket name, or `undefined`
 * when nothing valid can be salvaged. R2 names are lowercase a–z/0–9/`-`, 3–63
 * chars, first and last char alphanumeric — exactly {@link toKebabSlug}'s shape.
 */
const sanitizeBucketName = (input: string): string | undefined => toKebabSlug(input, 3, 63);

/** A safe fallback when the project name yields nothing usable (e.g. all-symbol names). */
const FALLBACK_BUCKET_NAME = "lunora-uploads";

/**
 * The default bucket name offered in the prompt: the project name suffixed with
 * `-uploads`, sanitized. Falls back to {@link FALLBACK_BUCKET_NAME} if the
 * project name can't produce a valid one.
 */
const deriveBucketName = (projectName: string): string => sanitizeBucketName(`${projectName}-uploads`) ?? FALLBACK_BUCKET_NAME;

/**
 * Prompt for the bucket name (defaulting to the project-derived name) and
 * sanitize the answer, falling back to the default. Shared by both front doors
 * so the prompt + default + sanitize flow can't drift between them.
 */
const promptBucketName = async (text: TextPrompt, projectName: string): Promise<string> => {
    const fallback = deriveBucketName(projectName);

    return sanitizeBucketName(await text(STORAGE_BUCKET_PROMPT, { default: fallback, placeholder: fallback })) ?? fallback;
};

/**
 * Return a copy of `manifest` with the `UPLOADS` R2 binding's `bucket_name` set
 * to `bucketName`. No-ops on items without a matching binding, so it's safe to
 * pass as a {@link RegistryManifest} transform for any item.
 */
const withStorageBucketName = (manifest: RegistryManifest, bucketName: string): RegistryManifest =>
    setBindingField(manifest, "r2_buckets", { key: "binding", value: UPLOADS_BINDING }, "bucket_name", bucketName);

export { deriveBucketName, promptBucketName, sanitizeBucketName, STORAGE_BUCKET_PROMPT, UPLOADS_BINDING, withStorageBucketName };
