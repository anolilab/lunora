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
