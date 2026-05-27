# @cirrus/scheduler

Delayed and scheduled function invocation for the Cirrus framework.

```ts
import { createScheduler } from "@cirrus/scheduler";

const scheduler = createScheduler({ namespace: env.SCHEDULER, originUrl: "https://app.acme.test" });

// Run in 5 minutes.
await scheduler.runAfter(5 * 60_000, api.email.sendReminder, { userId: "u-1" });

// Run at a specific moment.
await scheduler.runAt(new Date("2026-06-01T12:00:00Z"), api.cleanup.run, { older: 30 });
```

Backing: a `SchedulerDO` Durable Object that uses `state.storage.setAlarm()` to fire the next-earliest pending task. On alarm fire it dispatches the function via HTTP back to the Worker, which routes it to the right shard.

For repeated tasks use Cloudflare Cron Triggers — `createCronTrigger()` produces a snippet to paste into your `wrangler.jsonc`.
