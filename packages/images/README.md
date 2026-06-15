<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="images" />

</a>

<h3 align="center">Cloudflare Images for Cirrus: ctx.images transforms (resize/format/optimize) and signed delivery URLs</h3>

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

Cloudflare **Images** for Cirrus. Wraps the `IMAGES` binding (`env.IMAGES.input(stream).transform(...).output(...)`) with a small typed client for resize / reformat / optimize, plus pure URL builders for the `/cdn-cgi/image/...` transform endpoint and for **worker-signed, app-gated delivery URLs**.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @cirrus/images
```

```sh
pnpm add @cirrus/images
```

## Action-only — and why

`ctx.images` (the binding-backed `transform`/`info`) is **available on `ActionCtx` only**. The Images transform pipeline is network / compute I/O — a non-deterministic side effect — so it must not run inside a query or mutation, which Cirrus expects to be deterministic (see `@cirrus/advisor`'s `nondeterministic-query-mutation` lint). This is the same seam as `ctx.ai` and `ctx.fetch`.

The pure **URL builders** (`buildImageDeliveryUrl`, `buildSignedImageUrl`, `verifySignedImageUrl`) only mint / verify a string — they do no I/O, so they're deterministic and safe to import and call from **any** handler (query, mutation, or action).

## Usage — transform on serve, paired with R2 storage

The most common flow: an object lives in R2 (`@cirrus/storage`), and an action downloads it, transforms it, and returns the result.

```ts
import { action } from "@cirrus/server";

export const thumbnail = action({
    args: { key: v.string() },
    handler: async (ctx, { key }) => {
        // ctx.storage from @cirrus/storage, ctx.images from @cirrus/images — both on ActionCtx.
        const object = await ctx.storage.download(key);

        const result = await ctx.images.transform(
            object, // an R2 object body is accepted directly — its .body stream is read for you
            { width: 256, height: 256, fit: "cover" },
            { format: "image/webp", quality: 82 },
        );

        return result.response(); // a Response, ready to return or cache
    },
});
```

`transform` clamps `width`/`height` to a configurable ceiling and validates the output `format` against an allowlist, so a hostile request can't ask for a multi-gigapixel canvas or an unexpected content type.

## URL-based transform (no binding round-trip)

`buildImageDeliveryUrl` produces the Cloudflare on-the-fly transform path, `/cdn-cgi/image/<options>/<source>`, or the hosted-Images delivery-variant form. Pure string building — call it anywhere.

```ts
import { buildImageDeliveryUrl } from "@cirrus/images";

// /cdn-cgi/image/width=256,fit=cover/uploads/avatar.png
buildImageDeliveryUrl({ baseUrl: "https://cdn.acme.test", key: "uploads/avatar.png", transform: { width: 256, fit: "cover" } });

// hosted delivery variant: https://cdn.acme.test/<imageId>/thumbnail
buildImageDeliveryUrl({ baseUrl: "https://cdn.acme.test", imageId: "abc-123", variant: "thumbnail" });
```

## Signed, app-gated delivery

`buildSignedImageUrl` mints a Worker-signed URL (HMAC-SHA256) that resolves back through your Worker route, so the request still passes your app's gates — auth, per-image policy, rate limits — before `verifySignedImageUrl` validates the signature + expiry and you serve (or transform) the image. The requested transform is bound into the signature, so a client can't alter the render under the same URL.

```ts
import { buildSignedImageUrl, verifySignedImageUrl } from "@cirrus/images";

const url = await buildSignedImageUrl({
    baseUrl: "https://cdn.acme.test",
    key: "uploads/avatar.png",
    secret: env.IMAGES_SIGNING_SECRET,
    transform: { width: 256, fit: "cover" },
    expiresInSeconds: 600,
});

// In the Worker route:
const result = await verifySignedImageUrl(request.url, env.IMAGES_SIGNING_SECRET);
if (!result.valid) return new Response("Forbidden", { status: 403 }); // never echo result.reason to clients
```

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://cirrus.dev/docs/addons/images)**.

## Related

- [`@cirrus/storage`](https://www.npmjs.com/package/@cirrus/storage) — R2 source for the transform-on-serve flow; `ctx.storage.download(key)` pipes straight into `ctx.images.transform(...)`.
- [`@cirrus/server`](https://www.npmjs.com/package/@cirrus/server) — call `ctx.images` from actions.
- [`@cirrus/advisor`](https://www.npmjs.com/package/@cirrus/advisor) — the determinism lint that keeps the binding transform out of queries/mutations.

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

The Cirrus images package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/cirrus/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@cirrus/images?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@cirrus/images
[npm-downloads-badge]: https://img.shields.io/npm/dm/@cirrus/images?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@cirrus/images
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/cirrus/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
