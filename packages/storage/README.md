<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="storage" />

</a>

<h3 align="center">R2-backed storage for Cirrus: typed buckets and signed URLs</h3>

<!-- END_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<br />

<div align="center">

[![typescript-image][typescript-badge]][typescript-url]
[![FSL-1.1-Apache-2.0 licence][license-badge]][license]
[![npm version][npm-version-badge]][npm-version]
[![npm downloads][npm-downloads-badge]][npm-downloads]
[![PRs Welcome][prs-welcome-badge]][prs-welcome]

</div>

---

<div align="center">
    <p>
        <sup>
            Daniel Bannert's open source work is supported by the community on <a href="https://github.com/sponsors/prisis">GitHub Sponsors</a>
        </sup>
    </p>
</div>

---

R2-backed file storage for Cirrus. Wraps a Cloudflare `R2Bucket` binding with a small typed API (`upload`, `download`, `delete`, `list`, multipart), worker-signed URLs for app-gated access, and native S3 presigned URLs for direct-to-R2 transfer.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @cirrus/storage
```

```sh
yarn add @cirrus/storage
```

```sh
pnpm add @cirrus/storage
```

## Usage

```ts
import { createStorage } from "@cirrus/storage";

const storage = createStorage({
    bucket: env.UPLOADS,
    publicBaseUrl: "https://cdn.acme.test",
    signingSecret: env.STORAGE_SIGNING_SECRET,
});

await storage.upload("uploads/avatar.png", bytes, { contentType: "image/png" });

const url = await storage.getSignedUrl("uploads/avatar.png", { expiresInSeconds: 600 });
```

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://cirrus.dev/docs/addons/storage)**.

## Related

- [`@cirrus/server`](https://www.npmjs.com/package/@cirrus/server) — call storage from queries, mutations, and actions.
- [`@cirrus/runtime`](https://www.npmjs.com/package/@cirrus/runtime) — the Worker runtime that serves gated `GET /storage/:key` routes.
- [`@cirrus/d1`](https://www.npmjs.com/package/@cirrus/d1) — store object metadata alongside your data.

## Supported Node.js Versions

Libraries in this ecosystem make the best effort to track [Node.js' release schedule](https://github.com/nodejs/release#release-schedule).
Here's [a post on why we think this is important](https://medium.com/the-node-js-collection/maintainers-should-consider-following-node-js-release-schedule-ab08ed4de71a).

## Contributing

If you would like to help take a look at the [list of issues](https://github.com/anolilab/cirrus/issues) and check our [Contributing](https://github.com/anolilab/cirrus/blob/alpha/.github/CONTRIBUTING.md) guidelines.

> **Note:** please note that this project is released with a Contributor Code of Conduct. By participating in this project you agree to abide by its terms.

## Credits

- [Daniel Bannert](https://github.com/prisis)
- [All Contributors](https://github.com/anolilab/cirrus/graphs/contributors)

## Made with ❤️ at Anolilab

This is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Anolilab](https://www.anolilab.com/open-source) is a Development and AI Studio. Contact us at [hello@anolilab.com](mailto:hello@anolilab.com) if you need any help with these technologies or just want to say hi!

## License

The Cirrus storage package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/cirrus/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@cirrus/storage?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@cirrus/storage
[npm-downloads-badge]: https://img.shields.io/npm/dm/@cirrus/storage?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@cirrus/storage
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/cirrus/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
