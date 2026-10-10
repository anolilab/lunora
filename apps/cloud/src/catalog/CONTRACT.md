# App catalog — shared contract

Every part of the catalog builds against this file. Change it here first, in the
same commit as the code that changes.

## Flow

1. **Publish (catalog CI).** `pnpm --filter @lunora/cloud run catalog:publish publish`
   reads each directory under `catalog/apps/` (an `app.json` and its `src/`), packs
   `<slug>-<version>.zip`, writes `<slug>-<version>.manifest.json` and its
   `.manifest.sig`, then writes the signed `index.json` and `index.sig` over the
   highest version of each slug. Nothing is written unless every app verifies.
2. **Browse (control plane).** `GET /v1/catalog` fetches the index, verifies its
   signature and freshness, verifies each listed app's manifest, and returns the
   apps with their install form. An app that fails a check is listed under `skipped`
   with a reason, never shown.
3. **Install (control plane).** `POST /v1/catalog/install` verifies the artifact
   (manifest signature, every file's size and sha256), validates the user's values
   against the form, stores the secrets sealed, mints a release key that expires with
   the install, runs the deploy core with the bundle, then revokes that key.

## Environment

- `CATALOG_INDEX_URL`: https URL of the official `index.json`. Absent means the catalog
  is empty, not an error.
- `CATALOG_PUBLIC_KEYS`: JSON array of `{ "keyId": string, "publicKey": string }`,
  where `publicKey` is the standard base64 of the raw 32-byte Ed25519 key. Absent or
  malformed means the catalog is refused with a clear error, never shown empty.

## HTTP

Both routes are session-authenticated (`auth: "session"`) and org-scoped.

`GET /v1/catalog?organizationId=ORG`

- Any member.
- 200 `{ apps, skipped, ok }` where
  `apps: { slug, version, name, summary, form: CatalogForm, installs: { projectId, deploymentId, version }[] }[]`
  and `skipped: { slug, version, reason }[]`.
- `installs` lists the org's projects that run this app (from `catalogInstalls`, live rows only).
- 200 with an empty `apps` list when `CATALOG_INDEX_URL` is absent. 503 `{ error }` when the
  configuration is malformed, or the index cannot be fetched or fails verification.

`POST /v1/catalog/install`

- Body `{ organizationId, projectId, slug, values: { vars: Record<string,string>, secrets: Record<string,string> } }`.
- Owner or admin only (checked against the caller's membership).
- 200 `{ deploymentId, url?, generated, kept, recorded }`. `generated` lists the secrets
  the install created; `kept` lists existing secrets it left as they were. Values are
  never returned. `recorded` is false when the release went live but the install row
  could not be marked live (the release itself is not rolled back).
- Failures carry `{ error, field?, code? }` and the status from one table,
  `STATUS_FOR` in `src/deploy/routes/catalog.ts`:

    | kind           | status | when                                                                              |
    | -------------- | ------ | --------------------------------------------------------------------------------- |
    | `invalidInput` | 400    | a required value is missing, or a value breaks the form                           |
    | `notFound`     | 404    | no app with that slug                                                             |
    | `busy`         | 409    | another install or release is already in flight                                   |
    | `conflict`     | 409    | the project has no production alias to replace                                    |
    | `verification` | 422    | the manifest or artifact fails verification (`code` is the `ArtifactErrorCode`)   |
    | `upstream`     | 502    | a file of the app cannot be fetched                                               |
    | `unavailable`  | 503    | the configuration is malformed, or the index cannot be read or fails verification |
    | `internal`     | 500    | anything else                                                                     |

## Index

`index.json` is `{ format: 1, issuedAt, apps }`, signed under the domain tag
`lunora-catalog-index:v1` (`index.sig` holds `{ keyId, signature }`).

- `issuedAt` is an ISO timestamp. An index older than 14 days, or dated more than 5
  minutes in the future, is refused. An isolate also refuses an index older than the newest
  one it has served. That high-water mark is module state, so the guarantee holds per isolate:
  a cold isolate accepts any index still inside the 14-day window.
- Each entry is `{ slug, version, name, summary?, artifactUrl, manifestUrl, manifestSha256, signatureUrl }`.
  `artifactUrl` is the zip. `manifestUrl` is the release's manifest, whose bytes hash to
  `manifestSha256`. `signatureUrl` is that manifest's signature. All three are https.
- `name` (1 to 80 characters) is the display name; `summary` (at most 200 characters) is one line.
  Both come from the app's `app.json`, not the manifest, so the install form stays the
  only thing the manifest carries for the UI.

The manifest (`manifest.json`) is `{ format: 1, slug, version, main, runtime?, bindings?, form?, files }`,
signed under `lunora-catalog-artifact:v1`. `runtime` is `worker` unless it says `lunora`.

## Types

- `CatalogManifest`, `CatalogForm`, `FormVariable`, `FormSecret`: `src/catalog/artifact.ts`.
- `verifyArtifact`, `parseManifest`, `parseForm`: `src/catalog/artifact.ts`.
- `packArtifact`: `src/catalog/pack.ts`.
- `verifyCatalogIndex` and the index entry type: `src/catalog/index.ts`.
- `listCatalog`, `installApp`, `InstallAdapters`, `InstallOutcome`: `src/catalog/service.ts`.
- `planInstall`, `runInstall`, `InstallPorts`, `InstallResult`: `src/catalog/install.ts`.
- The publisher core (`publishCatalog`, `writeCatalog`, `generateKeyPair`): `scripts/catalog/publish-core.ts`.

## Install mapping

- The main module's bytes become the deploy `bundle`, base64 encoded.
- Every other listed file becomes a static asset. `_headers` and `_redirects` travel
  as config, not as served files. A static file needs an `assets` binding, and an
  `assets` binding needs static files; either mismatch is refused.
- The manifest's `bindings` pass to the deploy manifest unchanged.
- Each form var becomes a plain var. A var may not share a name with a binding.
- Each form secret becomes a sealed tenant secret, stored with `environment: "production"`.
  A supplied value replaces the secret. A secret the project already has and the user
  does not supply is kept. A `generate` secret is generated only when absent.
- A missing required value is a 400 before anything is written. A missing optional
  value falls back to the var's default.

## Install safety

- **One install at a time.** `catalogInstalls` rows are claimed with status `installing`
  and a 35-minute lease. A live claim makes the next install `busy`. A stale claim is
  replaced.
- **Release key lifetime.** The install key is named `Catalog install (<installId>)`,
  is type `production`, and expires 35 minutes after minting. It is revoked when the
  install ends, success or failure.
- **Rollback.** Before any secret is written, the current production secrets are
  snapshotted. If the release does not go live, each secret is restored to its snapshot
  value, and secrets the install created are removed.

## Storage

`catalogInstalls` table (`lunora/tables/catalog.ts`):
`organizationId`, `projectId`, `slug`, `version`, `status` (`installing` | `live`),
`deploymentId`, `createdAt`, `installedBy` (user id). Indexed by org and by project.
Only `live` rows are listed.
