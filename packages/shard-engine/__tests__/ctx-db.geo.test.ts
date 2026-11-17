import createSqliteExec from "./_helpers/node-sqlite";
import runGeoScenarios from "./_scenarios/ctx-db.geo";

runGeoScenarios(createSqliteExec);
