# The Lunora Cloud provision box.
#
# Runs Alchemy 2 against one cell's Cloudflare account: it receives a
# ProvisionJob, converges the project and release stacks, and streams
# ProvisionEvent NDJSON back. It holds the cell's API token, so unlike the build
# box it only ever runs TRUSTED code — this image's own program.mjs through the
# pinned Alchemy CLI. Tenant bundles and assets are written to disk as data and
# uploaded, never executed.
#
# Debian slim, matching the build box and the repo's `engines` floor. Alchemy's
# bundler (rolldown) ships glibc binaries, another reason not to use Alpine.
FROM node:22-slim

# `ca-certificates` makes api.cloudflare.com reachable over TLS; declared rather
# than assumed so a slim rebase cannot silently drop it.
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# Alchemy and Effect, pinned by the committed lockfile (not a pnpm workspace
# member). `--ignore-scripts`: nothing in the tree needs an install script, and
# not running any keeps the image build from executing registry code.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY plan.mjs program.mjs server.mjs ./

# Never root. Jobs run in a fresh `mkdtemp` under /tmp, removed afterwards.
USER node

ENV NODE_ENV=production \
    npm_config_update_notifier=false

EXPOSE 8080

CMD ["node", "server.mjs"]
