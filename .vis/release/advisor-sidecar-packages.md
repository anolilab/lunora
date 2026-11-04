---
"@lunora/advisor": patch
"@lunora/cli": patch
"@lunora/codegen": patch
"@lunora/config": patch
"@lunora/do": patch
"@lunora/runtime": patch
"@lunora/shard-engine": patch
"@lunora/vite": patch
---
Serve the advisor procedure list from a generated sidecar and an opt-in companion Worker instead of the generated worker (#1465, #1473). Breaking on alpha: `__lunora_admin__:getAdvisorProcedures`, `ShardDO.advisorProcedures()` and the `LUNORA_ADVISOR_PROCEDURES` literal are removed; re-run `lunora codegen` after upgrading, or `tsc` fails with TS4113 on the old `_generated/shard.ts`.
