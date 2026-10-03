/**
 * Compile-time only (checked by `tsc --noEmit`): `ctx.storage` is typed as the
 * object the runtime actually puts there.
 *
 * In an action, `ctx.storage` IS `@lunora/storage`'s `Storage` (tagged with
 * `bucket(name)` by `asBucketStorage`, or a `createBucketStorage` accessor).
 * `@lunora/server` mirrors that surface structurally rather than importing it, so
 * the two drift silently unless something pins them together — which is how
 * `createMultipartUpload` / `resumeMultipartUpload` / `list` went untyped (#940).
 * `@lunora/storage` is a dev-only dependency here: the check below is the whole
 * reason for it.
 */
import type { BucketStorage, Storage as RuntimeStorage } from "@lunora/storage";

import type { ActionCtx, MutationCtx, QueryCtx, Storage, StorageListResult, StorageMultipartUpload, StorageUploadedPart } from "../src/index";
import { initLunora } from "../src/index";

type Assert<T extends true> = T;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- canonical type-equality idiom; each fresh `T` in the two function signatures is structurally load-bearing (relaxing it breaks the invariance check).
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

// No member of the runtime `Storage` is missing from the action's `ctx.storage` type.
type MissingFromCtx = Exclude<keyof RuntimeStorage, keyof Storage>;
type CheckNoneMissing = Assert<Equal<MissingFromCtx, never>>;

// No member is typed on `ctx.storage` that the runtime object lacks (`bucket` is
// the one `asBucketStorage` / `createBucketStorage` adds on top).
type PhantomOnCtx = Exclude<keyof Storage, keyof RuntimeStorage | "bucket">;
type CheckNonePhantom = Assert<Equal<PhantomOnCtx, never>>;

// The runtime object satisfies every signature the ctx type promises. This is the
// return-type direction only: parameters are contravariant, so a runtime method
// that ACCEPTS more than the ctx type declares still passes here.
type CheckRuntimeSatisfiesCtx = Assert<RuntimeStorage extends Omit<Storage, "bucket"> ? true : false>;
type CheckBucketStorageSatisfiesCtx = Assert<BucketStorage extends Storage ? true : false>;

// The parameter direction, per member: the ctx type accepts everything the runtime
// does. Catches a widened union — the `store` body that once refused
// `ArrayBufferView` / `string` the runtime takes.
type SharedMember = Exclude<keyof RuntimeStorage, "bucketName">;
type NarrowedParams = { [K in SharedMember]: Parameters<RuntimeStorage[K]> extends Parameters<Storage[K]> ? never : K }[SharedMember];
type CheckNoNarrowedParams = Assert<Equal<NarrowedParams, never>>;

// Stricter still: the parameter lists are IDENTICAL, which also catches an option
// field the runtime grew (an object with an extra optional key is assignable
// either way, so `extends` alone misses it). The one deliberate exception:
// `getSignedUrl` is on every tier, and its runtime `{ method: "PUT", contentType }`
// would mint an upload URL from a query — upload URLs are action-only, through
// `generateUploadUrl`.
type DifferingParams = { [K in SharedMember]: Equal<Parameters<RuntimeStorage[K]>, Parameters<Storage[K]>> extends true ? never : K }[SharedMember];
type CheckParamsIdentical = Assert<Equal<DifferingParams, "getSignedUrl">>;

declare const queryCtx: QueryCtx;
declare const mutationCtx: MutationCtx;
declare const actionCtx: ActionCtx;
declare const body: ReadableStream;

const check = (): void => {
    const { action } = initLunora.dataModel().create();

    // The issue's handler, with no cast and no `@ts-expect-error`.
    const upload = action.input({}).action(async ({ ctx }) => {
        const mpu = await ctx.storage.createMultipartUpload("big/file.pdf", { contentType: "application/pdf" });
        const part = await mpu.uploadPart(1, body);
        const stored = await mpu.complete([part]);

        const resumed = ctx.storage.resumeMultipartUpload(mpu.key, mpu.uploadId);

        await resumed.abort();

        const page = await ctx.storage.list("chat-uploads/", { cursor: undefined, limit: 100 });

        await Promise.all(page.objects.map(async (object) => ctx.storage.delete(object.key)));

        const uploaded = await ctx.storage.upload("small.txt", "hello", { maxSize: 1024 });

        return { etag: stored.etag, httpEtag: uploaded.httpEtag, truncated: page.truncated };
    });

    // A named bucket keeps the full action surface.
    const bucketPage = actionCtx.storage.bucket("avatars").list();

    type CheckMultipart = Assert<Equal<Awaited<ReturnType<ActionCtx["storage"]["createMultipartUpload"]>>, StorageMultipartUpload>>;
    type CheckResume = Assert<Equal<ReturnType<ActionCtx["storage"]["resumeMultipartUpload"]>, StorageMultipartUpload>>;
    type CheckList = Assert<Equal<Awaited<typeof bucketPage>, StorageListResult>>;
    type CheckPart = Assert<Equal<Awaited<ReturnType<StorageMultipartUpload["uploadPart"]>>, StorageUploadedPart>>;

    // Multipart, listing and raw upload are action-only: a query reads, and a
    // mutation runs in a transaction that cannot roll an R2 write back.
    // @ts-expect-error -- no multipart upload from a query
    queryCtx.storage.createMultipartUpload("big/file.pdf");
    // @ts-expect-error -- no multipart resume from a query
    queryCtx.storage.resumeMultipartUpload("big/file.pdf", "upload-id");
    // @ts-expect-error -- no listing from a query; enumerate through `ctx.db.system.query("_storage")`
    queryCtx.storage.list("chat-uploads/");
    // @ts-expect-error -- no raw upload from a query
    queryCtx.storage.upload("small.txt", "hello");
    // @ts-expect-error -- no multipart upload from a mutation
    mutationCtx.storage.createMultipartUpload("big/file.pdf");
    // @ts-expect-error -- no multipart resume from a mutation
    mutationCtx.storage.resumeMultipartUpload("big/file.pdf", "upload-id");
    // @ts-expect-error -- no listing from a mutation
    mutationCtx.storage.list("chat-uploads/");
    // @ts-expect-error -- no raw upload from a mutation
    mutationCtx.storage.upload("small.txt", "hello");

    const assertions = null as unknown as [
        typeof upload,
        CheckBucketStorageSatisfiesCtx,
        CheckList,
        CheckMultipart,
        CheckNoneMissing,
        CheckNonePhantom,
        CheckNoNarrowedParams,
        CheckParamsIdentical,
        CheckPart,
        CheckResume,
        CheckRuntimeSatisfiesCtx,
    ];

    // eslint-disable-next-line no-void, sonarjs/void-use -- marks the type-assertion tuple as used so its `@ts-expect-error`/`Equal<>` checks are evaluated
    void assertions;
};

export default check;
