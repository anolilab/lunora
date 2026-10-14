# {{name}}

A standalone Lunora Worker app (no frontend).

## Develop

Install dependencies and start the dev server with your package manager
(`npm`, `pnpm`, `yarn`, or `bun`):

```bash
<pm> install
<pm> run dev
```

Open <http://localhost:8787/> for the Lunora welcome page. All other routes
(RPC, WebSocket subscriptions, and the `/__lunora` Studio) are served by the
worker as usual.
