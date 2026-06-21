# Security Policy

Thanks for helping keep Lunora and its users safe.

## Reporting a vulnerability

**Email `security@anolilab.de`** with as much detail as you can share. PGP / encrypted mail is welcome — request a key in your first message if you'd like to use one.

Alternatively, file a [GitHub Security Advisory](https://github.com/anolilab/lunora/security/advisories/new) directly. **Do not** open a public issue or discussion for security problems.

Useful things to include:

- A clear description of the vulnerability and the affected package(s) (`@lunora/runtime`, `@lunora/auth`, etc.).
- Reproduction steps — a minimal repro repo, proof-of-concept script, or `curl` invocation is ideal.
- Impact assessment as you see it (data exposure, RCE, auth bypass, DoS, …).
- The commit SHA or package version you tested against.
- Your name or handle if you'd like public credit once the issue is fixed.

## What to expect from us

- **Acknowledgement within 72 hours** of receipt.
- A coordinated disclosure timeline negotiated with you. Default target: a fix shipped within 30 days of confirmation for high-severity issues; longer is fine if the bug is low-severity or hard to reproduce.
- Credit in the release notes and (eventually) a security hall of fame, unless you prefer to stay anonymous.
- No legal action against good-faith research that follows this policy.

## Supported versions

Lunora is **v0.1-alpha**. Only the current `alpha` branch and the latest published alpha tag of each package are supported. Once we ship a stable release line, this table will reflect actual version support.

| Version          | Supported          |
| ---------------- | ------------------ |
| `alpha` (latest) | :white_check_mark: |
| anything older   | :x:                |

## Scope

In scope:

- Code in this repository, including all packages under `packages/` and apps under `apps/`.
- The default behaviour of `@lunora/cli` (init, dev, deploy, run, reset, codegen).
- Public APIs surfaced by `@lunora/server`, `@lunora/runtime`, `@lunora/client`, `@lunora/react`, and the rest of the published packages.

Out of scope (report to Cloudflare directly):

- Vulnerabilities in Cloudflare Workers, Durable Objects, D1, R2, Queues, or any other Cloudflare product itself.
- Vulnerabilities in upstream dependencies — please report to the dependency's maintainers; if it materially affects Lunora we'll handle the coordinated upgrade.

## Hall of fame

TBD — once we have our first credited report it goes here. Be the first.
