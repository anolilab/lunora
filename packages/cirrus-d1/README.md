# @cirrus/d1

D1 adapter for the Cirrus framework. Wraps `env.DB` with a `D1Client` that exposes per-request sessions (using the D1 Sessions API for read-your-writes consistency across replicas) and a sequential `MigrationRunner` that applies SQL files tracked in a `_cirrus_migrations` table.
