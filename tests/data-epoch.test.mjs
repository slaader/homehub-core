// The data epoch (package.json → homeHub.dataEpoch): one integer that rises whenever a format Home Hub keeps on
// disk changes, so that whoever updates knows when going back needs the backup and not just the old code
// (AGENTS.md → Versioning). This table is the tripwire: a schema constant that changes while the epoch stands
// still fails `npm test`.
//
// When this fails: raise homeHub.dataEpoch in package.json by one, add a "### Data" part to the top section of
// CHANGELOG.md that says what changed and that rolling back needs the pre-update backup, then update TABLE.
// It cannot see a format that changes without a version constant; that remains a review rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readPackage} from '../server/version.mjs';
import {DB_SCHEMA} from '../server/db.mjs';
import {INTEGRATIONS_SCHEMA,INTEGRATION_SECRETS_SCHEMA} from '../server/integrations.mjs';
import {WATCH_SCHEMA} from '../server/software-watch.mjs';
import {SYSTEMS_SCHEMA} from '../server/systems-data.mjs';
import {SECURITY_SCHEMA,SECURITY_PROBES_SCHEMA} from '../server/security-data.mjs';
import {UPSTREAM_CACHE_VERSION} from '../server/systems-upstream.mjs';
import {UPDATES_SCHEMA} from '../server/update-check.mjs';
import {AGENTS_SCHEMA,AGENT_REPORTS_SCHEMA} from '../server/agent-store.mjs';
import {APP_TOKENS_SCHEMA} from '../server/app-tokens.mjs';
import {RUNTIMES_CONFIG_SCHEMA} from '../server/runtimes-data.mjs';
import {INVENTORY_SCHEMA} from '../public/inventory-rules.js';

const TABLE={epoch:2,schemas:{db:1,integrations:1,integrationSecrets:2,watch:1,systems:2,security:2,upstreamCache:2,updates:1,agents:2,agentReports:2,securityProbes:2,appTokens:2,runtimesConfig:2,inventory:2}};
const NOW={db:DB_SCHEMA,integrations:INTEGRATIONS_SCHEMA,integrationSecrets:INTEGRATION_SECRETS_SCHEMA,watch:WATCH_SCHEMA,systems:SYSTEMS_SCHEMA,security:SECURITY_SCHEMA,upstreamCache:UPSTREAM_CACHE_VERSION,updates:UPDATES_SCHEMA,agents:AGENTS_SCHEMA,agentReports:AGENT_REPORTS_SCHEMA,securityProbes:SECURITY_PROBES_SCHEMA,appTokens:APP_TOKENS_SCHEMA,runtimesConfig:RUNTIMES_CONFIG_SCHEMA,inventory:INVENTORY_SCHEMA};

test('a changed on-disk format raises the data epoch',()=>{
 const epoch=readPackage().dataEpoch;
 assert.deepEqual(NOW,TABLE.schemas,'a persisted format changed: raise package.json → homeHub.dataEpoch, add "### Data" to CHANGELOG.md, then update the table in this test');
 assert.equal(epoch,TABLE.epoch,'package.json → homeHub.dataEpoch and the table in this test move together');
 for(const [name,value] of Object.entries(NOW))assert.ok(Number.isSafeInteger(value)&&value>=1,name);
});
