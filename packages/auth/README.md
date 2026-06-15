<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="auth" />

</a>

<h3 align="center">Cookie-session auth for Cirrus: PBKDF2 email/password plus OAuth (PKCE), D1-backed, sessions in SessionDO</h3>

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

Cookie-session authentication for Cirrus. Wraps better-auth with PBKDF2 email/password and OAuth (PKCE), backs the user store on D1, and persists sessions in the Cirrus `SessionDO`.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @cirrus/auth
```

```sh
yarn add @cirrus/auth
```

```sh
pnpm add @cirrus/auth
```

## Usage

```ts
import { cirrusD1Adapter, createAuth, handleAuthRequest } from "@cirrus/auth";

const auth = createAuth({
    secret: env.AUTH_SECRET,
    database: cirrusD1Adapter(env.DB),
    emailAndPassword: { enabled: true },
});

// In your Worker's fetch handler:
const response = await handleAuthRequest(auth, request);
```

### Plugins & CAPTCHA

better-auth's plugin factories are re-exported from `@cirrus/auth/plugins` (so you don't need better-auth's deep import paths): `admin`, `anonymous`, `bearer`, `captcha`, `createAccessControl`, `customSession`, `deviceAuthorization`, `emailOTP`, `genericOAuth`, `haveIBeenPwned`, `jwt`, `magicLink`, `mcp`, `multiSession`, `oAuthProxy`, `oidcProvider`, `oneTimeToken`, `organization`, `passkey`, `phoneNumber`, `siwe`, `twoFactor`, `username`, and `withMcpAuth`.

For Cloudflare Turnstile on the **auth flow**, use the `captcha` plugin (`captcha({ provider: "cloudflare-turnstile", secretKey: env.TURNSTILE_SECRET_KEY })`); it reads the token from the `x-captcha-response` header. For **non-auth** procedures, the package root also exports standalone helpers — `verifyTurnstile` (pure `siteverify`) and `verifyTurnstileMiddleware` (a `.use()` middleware that takes the token from the function args).

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://cirrus.dev/docs/addons/auth)**.

## Related

- [`@cirrus/server`](https://www.npmjs.com/package/@cirrus/server) — define the queries and mutations that read the authenticated session.
- [`@cirrus/d1`](https://www.npmjs.com/package/@cirrus/d1) — the D1 adapter backing auth's user table.
- [`@cirrus/do`](https://www.npmjs.com/package/@cirrus/do) — `SessionDO`, where sessions are persisted.

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

The Cirrus auth package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/cirrus/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@cirrus/auth?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@cirrus/auth
[npm-downloads-badge]: https://img.shields.io/npm/dm/@cirrus/auth?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@cirrus/auth
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/cirrus/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
