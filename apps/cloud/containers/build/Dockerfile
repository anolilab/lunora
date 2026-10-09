# The Lunora Cloud build box (GAPS.md A3).
#
# One throwaway container per build: it receives a repo tarball, installs the
# project's own dependencies, runs the project's own `lunora build`, and hands
# back the single Worker module the deploy path uploads. It runs UNTRUSTED
# tenant code — a `postinstall` script and a build script are both arbitrary
# code execution by design — so the isolation boundary is the container itself,
# and the container is expected to be started with egress restricted to the
# package registry (`enableInternet: false` + `allowedHosts` on the
# `defineContainer` side) and discarded afterwards.
#
# Debian slim rather than Alpine: native build steps are common in real
# projects, and musl is where they break in ways a tenant cannot diagnose from
# a build log. `node:22-slim` matches the repo's `engines` floor.
FROM node:22-slim

# `tar` extracts the source tarball; `ca-certificates` is what makes the
# registry reachable over TLS. Both are cheap and neither is guaranteed to
# survive a future slim rebase, so they are declared rather than assumed.
# `--no-install-recommends` keeps the layer from pulling a toolchain nobody asked for.
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates tar \
    && rm -rf /var/lib/apt/lists/*

# Corepack pins the package manager per project from its `packageManager`
# field, so a tenant's build runs the manager their lockfile was written by
# instead of whatever this image happens to ship.
RUN corepack enable

# The build server is the only thing in the image. It installs nothing —
# `node:http`, `node:child_process`, `node:crypto` — so there is no install
# step here. The one third-party file is the bundle scan's parser, vendored as
# the catalog-pinned release's own prebuilt `acorn.mjs` (zero dependencies,
# MIT, licence beside it) and copied like the rest: no registry access at image
# build, and the bytes are pinned by `__tests__/build-scan-vendor.test.ts`.
# `vendor/release-manifest.mjs` is the Cloudflare Worker runtime's config →
# release translation, bundled from `@lunora/config` / `@lunora/cli` source by
# `scripts/vendor-release-manifest.ts` (third-party licences beside it) and
# held to that source by `__tests__/build-box-worker-vendor.test.ts`.
# `shim-runtime.mjs` is never run here: the server reads its text at start-up
# and bundles it into each plain Worker (see `worker.mjs`).
WORKDIR /srv
COPY server.mjs workspace.mjs release.mjs scan.mjs worker.mjs shim-runtime.mjs ./
COPY vendor/acorn.mjs vendor/acorn.LICENSE vendor/release-manifest.mjs vendor/release-manifest.LICENSES ./vendor/

# Builds land under here, one directory per build, owned by the unprivileged
# user. Created in the image so the server never has to mkdir as root.
RUN mkdir -p /workspace && chown node:node /workspace /srv

# Never root. A build script that escapes the sandbox should land on a user
# that owns nothing but its own scratch directory.
USER node

# Where the package managers keep their caches. Left inside the container's own
# filesystem so a build cannot write outside it, and thrown away with the
# instance — a shared cache across tenants would be a cross-tenant channel.
ENV HOME=/workspace \
    NODE_ENV=development \
    npm_config_update_notifier=false

EXPOSE 8080

CMD ["node", "server.mjs"]
