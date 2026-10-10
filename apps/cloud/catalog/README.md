# App catalog sources

Each folder under `apps/` is one catalog app: an `app.json` manifest input and a
`src/` tree that is the app's build. One command, `publish`, packs every app and
signs the release files and the `index.json` the control plane verifies. Run the
commands from `apps/cloud`.

## 1. Generate the signing key (once)

```bash
pnpm run catalog:publish keygen --key-id catalog-2026 --out catalog-signing.pem
```

The public line on stdout is the entry the control plane's `CATALOG_PUBLIC_KEYS`
env expects, for example `[{"keyId":"catalog-2026","publicKey":"..."}]` (wrap the
line in an array). The private key is written to the `--out` file with mode 600.
Store its contents as the `CATALOG_SIGNING_KEY` repository secret, set the
`CATALOG_KEY_ID` repository variable to the same key id, then delete the file. Never
commit it.

## 2. Publish

```bash
pnpm run catalog:publish publish --apps catalog/apps --key catalog-signing.pem \
    --key-id catalog-2026 --base-url https://catalog.example.com/apps --out dist/catalog
```

Each subdirectory of `--apps` is one app. `app.json` holds `slug`, `version` (semver,
`major.minor.patch`), `name` (at most 80 characters), `summary` (at most 200), `main`
(the Worker entry module, one of the files in `src/`), and optionally `runtime`
(`lunora` or `worker`, default `worker`), `bindings` and `form`. Static files go in
`src/` and need an `assets` binding, as the sample app's `app.json` shows.

`publish` packs each app from its `src/`, verifies every release with the artifact
verifier, and writes `index.json` and `index.sig` with each slug's highest version.
It writes `<slug>-<version>.zip`, `.manifest.json` and `.manifest.sig` for each listed
release, flat into `--out`. Nothing is written unless every app packs and verifies.
The base URL must be https.

## 3. Upload dist/catalog

Upload the contents of `dist/catalog` to the location `--base-url` names.

The catalog CI (`.github/workflows/catalog.yml`) runs the same steps on push to `alpha`
when this folder changes, and uploads `dist/catalog` as an artifact.

## 4. Install (owners and admins)

The Catalog tab lists the verified apps and the apps that failed verification, with
the reason. Choosing an app opens a form built from its `form`: a field per var and
per secret, with the declared default filled in.

- An install replaces the project's production release of the app. The form asks
  you to confirm that before it runs.
- A secret the app can generate is generated when the project does not have it, and
  its value is never shown. A secret the project already has, and that you leave
  blank, is kept as it is.
- Only one install runs per project at a time. A second one answers 409 until the
  first finishes or its lease expires (35 minutes).
- If the release does not go live, secrets are restored to the values they had
  before the install, and secrets it created are removed.
- Members who are neither owners nor admins can browse the catalog but cannot
  install from it.

## 5. Control plane configuration

- `CATALOG_INDEX_URL`: the https URL the uploaded `index.json` is served from.
- `CATALOG_PUBLIC_KEYS`: a JSON array of `{ "keyId", "publicKey" }`, one entry per
  signing key the control plane trusts.
- `RELEASES` (the release bucket) and `SECRET_ENCRYPTION_KEY`: already required by
  deploys. An install refuses to run without them.

With `CATALOG_INDEX_URL` unset the catalog is empty, not an error. With it set and
the keys missing or malformed, the catalog shows a refusal rather than an empty list.
The contract the control plane enforces is in `src/catalog/CONTRACT.md`.
