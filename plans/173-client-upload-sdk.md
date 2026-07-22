# Plan 173 — Client-side upload SDK (progress / pause-resume / resumable)

- **Category**: feat (competitive parity — Wave 14 deep-pass, in `plans/README.md`)
- **Priority**: P2
- **Effort**: S–M · **Risk**: LOW
- **Status**: TODO
- **Baseline**: `70331e9b` (2026-07-21)
- **Goal**: give end-user browsers a real upload story — progress, pause/resume,
  large-file resumable uploads — matching Firebase `uploadBytesResumable`,
  Supabase TUS, and Convex's upload flow, by **adopting `@visulima/storage-client`**
  rather than hand-rolling the client. The **server primitives already exist**;
  only the client DX layer is missing.

> **Reuse (visulima) — nearly the whole plan.** `@visulima/storage-client` already
> ships browser-safe hooks for exactly this: `useUpload()`, `useMultipartUpload()`,
> `useTusUpload()`, `useChunkedRestUpload()`, `useBatchUpload()` — with real-time
> progress, pause/resume (TUS), and first-class React/Vue/Solid/Svelte support
> (`UploadControl`, `UploadError`). On the server, **`@visulima/storage`** abstracts
> **Cloudflare R2** (S3-compatible) with a **`@visulima/storage/handler/http/cloudflare`
> edge adapter**, presigned URLs, multipart, and TUS/REST handlers. So this plan is
> mostly **integration + an RLS-gated presign procedure**, not a build — effort M →
> S–M. Caveat: the hooks require **TanStack Query**; wrap the framework-agnostic
> core (`UploadControl`) if that clashes with `@lunora/react`'s own `useQuery`.

## Context (verified)

Server side is covered: `packages/storage/src/signed-url.ts` exports
`createMultipartUpload` + `buildPresignedUrl` over R2 native multipart. The only
client upload today is the **admin-gated Studio path**
(`packages/client/src/lunora-client.ts:2321` `uploadStorageObject`, hits the
admin-gated `storageUpload` fn with an `adminToken`). There is **no** end-user
`useUpload` hook in any framework adapter (zero `storage|upload` hits in
`packages/react/src`), and no progress/pause/resume in `packages/client/src`.

## Phase 1 — RLS-gated presign + client wiring

- [ ] A non-admin client upload flow: an RLS-gated user procedure issues presigned
      multipart (or TUS) URLs — reuse `@lunora/storage` `createMultipartUpload` /
      `buildPresignedUrl` (optionally the `@visulima/storage` cloudflare handler).
- [ ] Wire `@visulima/storage-client` against that endpoint; verify progress,
      pause/resume, cancel, per-part retry against a live R2 bucket.

## Phase 2 — Framework hooks

- [ ] Re-export / thin-wrap the `@visulima/storage-client` `useUpload()` family
      through `@lunora/react` (then Vue/Solid/Svelte), reconciling the TanStack
      Query dependency with `@lunora/react`'s own query layer.
- [ ] Example: a drag-drop uploader with a progress bar over a large file.

## Exit criteria

- [ ] A large file uploads with a live progress bar, survives a pause/resume, and
      resumes after a dropped connection — RLS enforced (not admin-gated).
- [ ] Docs + example; tests over the presign + resume integration.

## Non-goals

- A new storage backend — this rides the existing R2 multipart + presigned server API.
- Rebuilding the client uploader — adopt `@visulima/storage-client`, don't hand-roll.
