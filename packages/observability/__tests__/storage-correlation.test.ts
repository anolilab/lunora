import createSqliteExec from "./_helpers/node-sqlite";
import runStorageCorrelationScenarios from "./_scenarios/storage-correlation";

runStorageCorrelationScenarios(createSqliteExec);
