# {{name}}

A standalone Lunora Worker app (no frontend).

## Develop

```bash
pnpm install
pnpm dev
```

Open <http://localhost:8787/> for the Lunora welcome page. All other routes
(RPC, WebSocket subscriptions, and the `/_lunora` Studio) are served by the
worker as usual.
