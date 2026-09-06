import type { ExecutionContextLike, ScheduledControllerLike, ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "../lunora/_generated/app.js";

interface Env extends Record<string, unknown> {
    SHARD: ShardNamespaceLike;
}

/**
 * Worker entry, composed with the generated `defineApp` builder. It exposes one
 * fluent method per capability THIS app uses — right now just `.shard()`. Add
 * `@lunora/storage` / `@lunora/scheduler` / `@lunora/auth` or a `.global()`
 * table and codegen surfaces `.storage()` / `.scheduler()` / `.auth()` /
 * `.global()` here automatically (IntelliSense lists what you can configure).
 * `defineApp` is sugar over `createWorker` / `createShardDO`, which stay usable
 * directly if you need an option the builder doesn't sugar yet (via `.extend()`).
 */
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    // Demo/local default: this app has no auth, so shard access is left OPEN
    // (any caller may target any shard) and data is protected by per-row RLS.
    // A PRODUCTION sharded app must gate this instead — e.g.
    // `.extend(() => ({ authorizeShard: ({ identity, shardKey }) => shardKey === "__root__" || identity?.userId === ownerOf(shardKey) }))`.
    .extend(() => ({ allowUnauthenticatedShardAccess: true }))
    .build();

export const ShardDO = app.ShardDO;

/**
 * Branded welcome page served at `GET /`. Self-contained (no assets, no deps) —
 * inline CSS + SVG only, scoped under `.lunora-welcome`. Night/Ivory themes via
 * a `data-theme` toggle initialised from `prefers-color-scheme`.
 */
const WELCOME_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lunora</title>
<style>
  /* ── self-contained, collision-safe: everything scoped under .lunora-welcome ── */
  .lunora-welcome {
    --cyan: hsl(186 84% 56%); --violet: hsl(256 72% 68%); --rose: hsl(330 80% 64%);
    --ribbon: linear-gradient(115deg, var(--cyan), var(--violet) 52%, var(--rose));
    --sans: "Geist Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    /* NIGHT (default) */
    --bg: #0e0e11; --surface: hsl(240 12% 8% / 0.72); --surface-2: hsl(240 11% 11% / 0.82);
    --line: hsl(0 0% 100% / 0.08); --line-2: hsl(0 0% 100% / 0.14);
    --t-display: hsl(228 30% 97%); --t-primary: hsl(228 26% 90%); --t-secondary: hsl(228 12% 62%); --t-faint: hsl(228 10% 44%);
    --logo: hsl(228 30% 97%); --accent: var(--violet); --shot-bg: hsl(240 12% 6%);
    --glow-1: hsl(256 80% 52% / 0.30); --glow-2: hsl(196 84% 52% / 0.13); --arc: hsl(256 60% 70% / 0.11);

    position: relative; min-height: 100vh; background: var(--bg); color: var(--t-primary);
    font-family: var(--sans); line-height: 1.55; -webkit-font-smoothing: antialiased; overflow-x: hidden;
    transition: background .3s, color .3s;
  }
  .lunora-welcome[data-theme="light"] {
    --bg: hsl(228 32% 97%); --surface: hsl(0 0% 100% / 0.82); --surface-2: hsl(0 0% 100% / 0.95);
    --line: hsl(228 16% 88%); --line-2: hsl(228 14% 80%);
    --t-display: hsl(240 14% 10%); --t-primary: hsl(240 12% 18%); --t-secondary: hsl(235 9% 42%); --t-faint: hsl(235 8% 58%);
    --logo: hsl(240 16% 9%); --accent: hsl(256 58% 56%); --shot-bg: hsl(228 26% 99%);
    --glow-1: hsl(256 80% 60% / 0.14); --glow-2: hsl(196 84% 58% / 0.08); --arc: hsl(256 40% 55% / 0.12);
  }
  .lunora-welcome *, .lunora-welcome *::before, .lunora-welcome *::after { box-sizing: border-box; }
  .lunora-welcome a { color: inherit; text-decoration: none; }
  .lunora-welcome button { font-family: inherit; cursor: pointer; }
  .lunora-welcome ::selection { background: hsl(256 72% 68% / 0.3); }
  .lunora-welcome code { font-family: var(--mono); }

  /* glow background */
  .lunora-welcome .lw-bg { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
  .lunora-welcome .lw-bg .glow { position: absolute; left: 50%; top: -4%; width: 860px; height: 720px; transform: translateX(-50%);
    border-radius: 50%; background: radial-gradient(circle at 50% 50%, var(--glow-1), var(--glow-2) 40%, transparent 66%); }
  .lunora-welcome .lw-bg .arc { position: absolute; left: 50%; border-radius: 50%; border: 1px solid var(--arc); transform: translateX(-50%); }
  .lunora-welcome .lw-bg .arc.a1 { top: -340px; width: 980px; height: 980px; }
  .lunora-welcome .lw-bg .arc.a2 { top: -240px; width: 720px; height: 720px; opacity: .7; }

  /* theme toggle */
  .lunora-welcome .lw-toggle { position: fixed; z-index: 5; top: 20px; right: clamp(16px,4vw,36px); display: inline-flex; align-items: center;
    gap: 7px; border: 1px solid var(--line-2); background: var(--surface); backdrop-filter: blur(12px); color: var(--t-secondary);
    font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; padding: 7px 11px; transition: .15s; }
  .lunora-welcome .lw-toggle:hover { color: var(--t-display); border-color: var(--accent); }
  .lunora-welcome .lw-toggle svg { width: 13px; height: 13px; }

  .lunora-welcome .lw-wrap { position: relative; z-index: 2; width: 100%; max-width: 1080px; margin: 0 auto;
    padding: clamp(44px,8vh,92px) clamp(20px,5vw,48px); display: flex; flex-direction: column; min-height: 100vh; }
  .lunora-welcome .brand { display: flex; align-items: center; justify-content: center; gap: 15px; margin-bottom: clamp(38px,6vh,68px); color: var(--logo); }
  .lunora-welcome .brand svg { width: 54px; height: auto; display: block; }
  .lunora-welcome .brand .word { font-size: 34px; font-weight: 600; letter-spacing: -0.03em; color: var(--t-display); }

  .lunora-welcome .grid { display: grid; grid-template-columns: 1.06fr 0.94fr; gap: 16px; align-items: stretch; flex: 1; max-height: 580px; }
  @media (max-width: 820px) { .lunora-welcome .grid { grid-template-columns: 1fr; max-height: none; } }

  .lunora-welcome .card { border: 1px solid var(--line); background: var(--surface); backdrop-filter: blur(10px); transition: border-color .2s, background .2s; }
  .lunora-welcome .card:hover { border-color: var(--line-2); background: var(--surface-2); }
  .lunora-welcome .card:hover .arrow { color: var(--accent); transform: translateX(3px); }
  .lunora-welcome .arrow { color: var(--t-faint); transition: color .2s, transform .2s; }
  .lunora-welcome .arrow svg { width: 20px; height: 20px; display: block; }
  .lunora-welcome .ic { display: grid; place-items: center; color: var(--accent);
    border: 1px solid color-mix(in oklab, var(--accent) 36%, transparent); background: color-mix(in oklab, var(--accent) 12%, transparent); }
  .lunora-welcome .ic svg { display: block; }

  /* left feature card — stretches to fill the box height */
  .lunora-welcome .feature { padding: clamp(18px,2vw,24px); display: flex; flex-direction: column; }
  .lunora-welcome .shot { border: 1px solid var(--line); overflow: hidden; background: var(--shot-bg);
    -webkit-mask-image: linear-gradient(to bottom, #000 56%, transparent 100%); mask-image: linear-gradient(to bottom, #000 56%, transparent 100%); }
  .lunora-welcome .shot .top { display: flex; align-items: center; gap: 12px; padding: 11px 14px; border-bottom: 1px solid var(--line); }
  .lunora-welcome .shot .wm { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; color: var(--t-primary); }
  .lunora-welcome .shot .wm i { width: 11px; height: 11px; background: var(--ribbon); -webkit-mask: radial-gradient(circle,#000 60%,transparent 62%); mask: radial-gradient(circle,#000 60%,transparent 62%); }
  .lunora-welcome .shot .search { flex: 1; height: 22px; border: 1px solid var(--line); border-radius: 4px; }
  .lunora-welcome .shot .ver { font-family: var(--mono); font-size: 8px; letter-spacing: .08em; color: var(--t-faint); }
  .lunora-welcome .shot .body { display: grid; grid-template-columns: 92px 1fr; min-height: 224px; }
  .lunora-welcome .shot .nav { border-right: 1px solid var(--line); padding: 14px 12px; display: flex; flex-direction: column; gap: 11px; }
  .lunora-welcome .shot .nav i, .lunora-welcome .shot .doc i { height: 5px; border-radius: 2px; background: var(--line); }
  .lunora-welcome .shot .doc { padding: 16px 18px; display: flex; flex-direction: column; gap: 9px; }
  .lunora-welcome .shot .doc .h { height: 8px; width: 46%; border-radius: 2px; background: var(--line-2); margin-bottom: 5px; }
  .lunora-welcome .shot .doc .accent { height: 5px; width: 26%; border-radius: 2px; background: var(--accent); }
  .lunora-welcome .feature .info { margin-top: auto; padding-top: clamp(18px,2.4vh,28px); }
  .lunora-welcome .feature .ic { width: 40px; height: 40px; margin-bottom: 15px; }
  .lunora-welcome .feature .ic svg { width: 19px; height: 19px; }
  .lunora-welcome .feature h2 { margin: 0 0 10px; font-size: 19px; font-weight: 600; letter-spacing: -0.015em; color: var(--t-display); }
  .lunora-welcome .feature .row { display: flex; align-items: flex-end; gap: 16px; }
  .lunora-welcome .feature p { margin: 0; color: var(--t-secondary); font-size: 14px; max-width: 50ch; }
  .lunora-welcome .feature .row .arrow { margin-left: auto; }

  /* right stack — smaller cards, spread to align bottoms with the feature */
  .lunora-welcome .stack { display: flex; flex-direction: column; gap: 16px; height: 100%; }
  .lunora-welcome .mini { flex: 1; padding: 15px 17px; display: flex; align-items: center; gap: 16px; min-height: 0; }
  .lunora-welcome .mini .mc { flex: 1; }
  .lunora-welcome .mini .ic { width: 32px; height: 32px; margin-bottom: 10px; }
  .lunora-welcome .mini .ic svg { width: 16px; height: 16px; }
  .lunora-welcome .mini h3 { margin: 0 0 5px; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; color: var(--t-display); }
  .lunora-welcome .mini p { margin: 0; color: var(--t-secondary); font-size: 12.5px; line-height: 1.45; }

  .lunora-welcome .lw-foot { text-align: center; padding-top: 26px; font-family: var(--mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--t-faint); }

  @media (prefers-reduced-motion: reduce) { .lunora-welcome * { transition: none !important; } }
</style>
</head>
<body>
<div class="lunora-welcome" data-theme="dark">
  <div class="lw-bg"><div class="arc a1"></div><div class="arc a2"></div><div class="glow"></div></div>

  <button class="lw-toggle" type="button" aria-label="Toggle color theme" onclick="(function(b){var r=b.closest('.lunora-welcome');var d=r.getAttribute('data-theme')!=='light';r.setAttribute('data-theme',d?'light':'dark');b.querySelector('span').textContent=d?'Ivory':'Night';b.querySelector('svg').innerHTML=d?'<path d=&quot;M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z&quot;/>':'<circle cx=&quot;12&quot; cy=&quot;12&quot; r=&quot;4&quot;/><path d=&quot;M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19&quot;/>';})(this)">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></svg>
    <span>Night</span>
  </button>

  <div class="lw-wrap">
    <div class="brand">
      <svg viewBox="0 0 543 446" role="img" aria-label="Lunora"><path d="M 259.500 10.552 C 220.080 15.859, 182.424 32.566, 152.500 58.025 C 110.179 94.031, 85.380 137.183, 77.518 188.500 C 75.410 202.255, 74.569 225.677, 75.796 236.466 C 76.757 244.917, 76.683 245.692, 74.518 249.966 C 63.118 272.466, 53.141 303.876, 51.382 322.799 L 50.718 329.943 71.960 320.471 C 83.643 315.262, 93.326 311, 93.478 311 C 93.630 311, 96.547 316.063, 99.959 322.250 C 103.371 328.438, 107.249 334.850, 108.577 336.500 L 110.990 339.500 110.981 336 C 110.977 334.075, 111.499 324.991, 112.143 315.813 L 113.312 299.127 121.406 293.336 C 132.495 285.403, 149.593 271.554, 161 261.268 C 171.556 251.748, 189.116 235, 188.540 235 C 188.337 235, 183.069 238.648, 176.835 243.106 C 142.318 267.789, 68.537 314, 63.646 314 C 61.843 314, 72.791 281.179, 80.905 262.259 C 92.233 235.845, 107.473 212.389, 132.106 183.453 L 138.451 176 148.268 176 C 176.192 176, 197.512 187.154, 212.868 209.797 C 216.470 215.108, 217.035 216.595, 216.477 219.297 C 211.386 243.968, 202.359 274.496, 193.797 296 C 183.898 320.861, 167.147 352.101, 152.395 373.215 L 147.004 380.930 152.891 385.830 C 161.400 392.911, 165.563 396, 166.594 395.998 C 167.092 395.998, 168.772 391.641, 170.327 386.317 C 176.279 365.934, 188.422 338.749, 200.942 317.778 C 223.060 280.731, 256.432 244.369, 294.500 215.836 C 309.956 204.252, 313.937 201.603, 314.719 202.385 C 315.116 202.783, 315.449 213.096, 315.460 225.304 C 315.474 241.855, 315.021 250.405, 313.680 258.924 C 307.009 301.272, 291.175 336.677, 263.112 372 C 255.259 381.883, 227.182 410.673, 218.516 417.727 L 213.532 421.783 223.439 424.880 C 281.705 443.093, 349.165 436.018, 398.616 406.508 C 446.728 377.797, 483.322 331.466, 497.366 281.481 C 503.381 260.075, 504.480 250.741, 504.491 221 C 504.501 191.997, 503.598 184.047, 497.987 163.732 C 484.768 115.871, 452.505 72.708, 407.718 42.964 C 381.051 25.254, 352.818 14.828, 319.695 10.460 C 305.932 8.645, 273.298 8.695, 259.500 10.552" fill="currentColor" fill-rule="evenodd"/></svg>
      <span class="word">Lunora</span>
    </div>

    <div class="grid">
      <a class="card feature" href="https://lunora.sh/docs">
        <div class="shot" aria-hidden="true">
          <div class="top"><span class="wm"><i></i> Lunora</span><span class="search"></span><span class="ver">v0.1</span></div>
          <div class="body">
            <div class="nav"><i style="width:80%"></i><i style="width:60%"></i><i style="width:72%"></i><i style="width:50%"></i><i style="width:66%"></i><i style="width:44%"></i><i style="width:58%"></i></div>
            <div class="doc"><span class="h"></span><i style="width:92%"></i><i style="width:88%"></i><span class="accent"></span><i style="width:80%"></i><i style="width:90%"></i><i style="width:72%"></i><i style="width:84%"></i><i style="width:78%"></i></div>
          </div>
        </div>
        <div class="info">
          <span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M14 3v5h5"/></svg></span>
          <h2>Documentation</h2>
          <div class="row"><p>Schemas, queries, live subscriptions, sharding, and edge deploy — start to finish. New here or coming from Convex or tRPC, you'll have a live app fast.</p>
            <span class="arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></div>
        </div>
      </a>

      <div class="stack">
        <a class="card mini" href="https://lunora.sh/blog"><div class="mc"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 4h11a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1zM8 8h7M8 12h7M8 16h4"/></svg></span><h3>Blog</h3><p>Product updates, deep dives, and what's new in Lunora.</p></div><span class="arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></a>
        <a class="card mini" href="/__lunora"><div class="mc"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M9 21V9"/></svg></span><h3>Lunora Studio</h3><p>Local admin for schema, data, logs, and advisors.</p></div><span class="arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></a>
        <a class="card mini" href="https://lunora.sh/packages"><div class="mc"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/></svg></span><h3>Cloudflare ecosystem</h3><p>Auth, mail, storage, AI, payments — one deploy.</p></div><span class="arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></a>
      </div>
    </div>

    <div class="lw-foot">Running on Lunora · Standalone Worker</div>
  </div>

  <script>
    (function () {
      var root = document.querySelector(".lunora-welcome");
      if (!root) return;
      var dark = !window.matchMedia || !window.matchMedia("(prefers-color-scheme: light)").matches;
      root.setAttribute("data-theme", dark ? "dark" : "light");
      var btn = root.querySelector(".lw-toggle");
      if (btn) {
        btn.querySelector("span").textContent = dark ? "Night" : "Ivory";
        btn.querySelector("svg").innerHTML = dark
          ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>'
          : '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
      }
    })();
  </script>
</div>
</body>
</html>`;

/**
 * Wrap the composed app so `GET /` serves the branded welcome page and every
 * other request (the `/_lunora` RPC + WebSocket plane, the `/__lunora` Studio)
 * delegates to the Lunora worker unchanged.
 *
 * Every handler `.build()` composes is forwarded, not just `fetch`. `scheduled`,
 * `queue` and `email` appear on the composed app the moment you add a
 * `lunora/crons.ts`, a `defineQueue`, or `.onEmail(...)` — and `lunora deploy`
 * provisions the matching `triggers.crons` / queue consumer from the same
 * discovery. A hand-built entry that forwards only `fetch` therefore gets the
 * trigger without the handler, and Cloudflare fires it into nothing: no error,
 * no invocation, a cron that silently never runs.
 */
export default {
    email(message: unknown, env: Env, context: ExecutionContextLike): Promise<void> {
        // Optional on the composed app — present only once `.onEmail(...)` is configured.
        return app.email?.(message, env, context) ?? Promise.resolve();
    },
    fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> | Response {
        const url = new URL(request.url);

        if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
            return new Response(WELCOME_HTML, {
                headers: { "content-type": "text/html; charset=utf-8" },
            });
        }

        return app.fetch(request, env, context);
    },
    queue(batch: unknown, env: Env, context: ExecutionContextLike): Promise<void> {
        // Optional on the composed app — present only once a `defineQueue` is declared.
        return app.queue?.(batch, env, context) ?? Promise.resolve();
    },
    scheduled(controller: ScheduledControllerLike, env: Env, context: ExecutionContextLike): Promise<void> {
        return app.scheduled(controller, env, context);
    },
};
