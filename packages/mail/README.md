<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="mail" />

</a>

<h3 align="center">Email for Lunora: Resend adapter, TSX templates, and queue-backed sends</h3>

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

Transactional email for Lunora. Render TSX templates, send through Cloudflare Email Workers (the default) or the Resend adapter, and offload delivery to a Cloudflare Queue so requests return immediately. In `lunora dev` every send is captured into the studio's Mail inbox instead of hitting a provider.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/mail
```

```sh
yarn add @lunora/mail
```

```sh
pnpm add @lunora/mail
```

## Usage

Build a `Mailer` and send. `createMailer` needs `from` plus one transport: the
default is Cloudflare Email Workers (`cloudflareSend`), with Resend (`apiKey`) as
a bring-your-own-provider option. Pass a React Email element through `react` and
it renders to `html` + `text` for you (this file must be `.tsx`):

```tsx
import { createMailer } from "@lunora/mail";

import { WelcomeEmail } from "./emails/Welcome";

const mailer = createMailer({
    apiKey: env.RESEND_API_KEY,
    from: "Acme <noreply@acme.test>",
});

await mailer.send({
    to: "alice@example.com",
    subject: "Welcome",
    react: <WelcomeEmail name="Alice" />,
});
```

In a Worker, `createMailerFromEnv(env)` is usually what you want: it reads
`MAIL_FROM`, captures into the studio inbox in dev, and otherwise delivers via
the `SEND_EMAIL` binding (or `RESEND_API_KEY`).

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs/packages/mail)**.

## Related

- [`@lunora/server`](https://www.npmjs.com/package/@lunora/server) — call the mailer from actions.
- [`@lunora/scheduler`](https://www.npmjs.com/package/@lunora/scheduler) — queue-backed dispatch for deferred sends.
- [`@lunora/auth`](https://www.npmjs.com/package/@lunora/auth) — send verification and password-reset emails.

## Supported Node.js Versions

Libraries in this ecosystem make the best effort to track [Node.js' release schedule](https://github.com/nodejs/release#release-schedule).
Here's [a post on why we think this is important](https://medium.com/the-node-js-collection/maintainers-should-consider-following-node-js-release-schedule-ab08ed4de71a).

## Contributing

If you would like to help take a look at the [list of issues](https://github.com/anolilab/lunora/issues) and check our [Contributing](https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md) guidelines.

> **Note:** please note that this project is released with a Contributor Code of Conduct. By participating in this project you agree to abide by its terms.

## Credits

- [Daniel Bannert](https://github.com/prisis)
- [All Contributors](https://github.com/anolilab/lunora/graphs/contributors)

## Made with ❤️ at Anolilab

This is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Anolilab](https://www.anolilab.com/open-source) is a Development and AI Studio. Contact us at [hello@anolilab.com](mailto:hello@anolilab.com) if you need any help with these technologies or just want to say hi!

## License

The Lunora mail package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/mail?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/mail
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/mail?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/mail
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
