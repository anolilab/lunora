import createSqliteExec from "./_helpers/node-sqlite";
import runBatchWriteScenarios from "./_scenarios/ctx-db.batch-writes";

runBatchWriteScenarios(createSqliteExec);
