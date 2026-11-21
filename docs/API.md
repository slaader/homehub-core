# Home Hub JSON API

What a client (a native app, a script, an agent) needs to read the hub and run the same actions as the web UI. `H` below stands for the origin browsers use for your hub, for example `https://hub.example.lan` (site.json → `publicOrigin`, or the `ORIGIN` environment variable).

This document covers the core. A plugin documents its own routes (see `docs/plugins.md`); agents can also use the MCP endpoint (`POST /mcp`, service-account key).

## Reaching it

- Home Hub is meant for a home network: put it behind a reverse proxy that only answers your LAN or VPN.
- Every request has ten seconds to arrive. The exception is a raw `PUT` upload (a ticket attachment, a review chunk, a device picture, a plugin's `raw` route) once its sign-in, origin and scope checks have passed: 20 minutes at most. POST bodies are limited to 16 KB (64 KB for review publish and feedback, 512 KiB for an agent report).
- Responses use `Cache-Control: no-store` by default. Published wiki media uses private revalidation. See [inventory and media](wiki.md#inventory-and-media).
## Authentication

Two ways to be signed in. Each one works on every `/api/*` route unless a route below says otherwise.

| | Browser | Native app |
|---|---|---|
| Credential | `homehub` cookie (HttpOnly, 12 hours) | `Authorization: Bearer hh_<64 hex>` |
| Lifetime | 12 hours from sign-in; survives restarts and deploys (`state/hub.db`, token stored as SHA-256) | Until revoked; survives restarts |
| POST needs `Origin` header | yes, exactly `https://hub.example.lan` | no |

Every POST must send `Content-Type: application/json` exactly (no `; charset=utf-8` suffix), or the server answers `403 ORIGIN_REJECTED`.

### Token flow (first launch)

1. `POST /api/session` with headers `Origin: https://hub.example.lan` and `Content-Type: application/json`, body `{"username":"admin","password":"…"}`.
   - `200 {"ok":true}` plus `Set-Cookie: homehub=<64 hex>; …`. Keep that cookie for step 2 only.
   - `401 LOGIN_FAILED` for the wrong username or password. `429 LOGIN_FAILED` after 8 failures in 15 minutes. `400 LOGIN_FAILED` for a malformed body.
2. `POST /api/app-tokens` with the cookie, the same `Origin` and `Content-Type`, body `{"name":"Alex's iPhone"}`. The name is 1 to 60 characters with no control characters.
   - `201 {"token":"hh_…","app":{"id":"<16 hex>","name":"…","createdAt":"…","lastUsedAt":null}}`
   - **The token appears only in this response.** The server stores only its SHA-256 hash. Save it in the Keychain behind Face ID (for example `kSecAccessControlBiometryCurrentSet`).
   - This route accepts **only the cookie**. A bearer token cannot mint more tokens (`401 AUTH_REQUIRED`).
   - `409 APP_TOKEN_LIMIT` when 20 app tokens already exist. Revoke one first.
3. Optional: `POST /api/logout` with the cookie and `Origin`, body `{}`, to drop the 12-hour browser-style session.
4. From then on, send `Authorization: Bearer <token>` on every request. No cookie and no `Origin` header are needed.

### Managing app tokens

- `GET /api/app-tokens` → `{"tokens":[{"id","name","createdAt","lastUsedAt","current"}]}`. `current` is `true` for the token that made the request. `lastUsedAt` is updated at most once a minute.
- `POST /api/app-tokens/revoke` with body `{"id":"<16 hex>"}` → `{"ok":true,"tokens":[…]}`. The cookie or any valid token may revoke any app token, including itself; revoking yourself is how the app signs out. `404 NOT_FOUND` if the id is unknown.
- The web UI has the same list under **Users and API → App sign-ins**.
- After a revoke, the next request with that token gets `401 AUTH_REQUIRED`. The app should then delete it from the Keychain and show sign-in.

## Access: people, roles, service accounts

Who may do what is one table of **scopes** (`read`, `inventory:write`, `home:settings`, `home:write`,
`tickets:write`, `review:write`, `software:write`, `security:read`, plus whatever plugins register). A route names the scope it needs; every
caller is checked against it the same way.

| Caller | Credential | Holds |
|---|---|---|
| A person | `homehub` cookie | The scopes of their **role** |
| A service account (agent, script) | `Authorization: Bearer hhk_<64 hex>` | The scopes of the account |
| A key from before service accounts | `Authorization: Bearer hhk_<64 hex>` | `read`, or everything a write key could do before scopes existed. Never a scope added since (`security:read`, `home:write`, `software:write`, or a plugin scope marked `legacy: false`) |
| A native app | `Authorization: Bearer hh_<64 hex>` | Every scope |
| A push agent | `Authorization: Bearer hha_<64 hex>` | No scope at all: it reaches `POST /api/agent/report` and nothing else (Push agent, below) |

**Roles.** Four are built in; administrators can add custom ones (a name, a description, a list of scopes).

| Role id | Scopes | Administration |
|---|---|---|
| `owner` | all, also ones a plugin adds later | yes. The account of `private/auth.json`; it cannot be deleted, disabled or given another role |
| `admin` | all, also later ones | yes |
| `editor` | `read` and standard write scopes, including later ones; excludes `references:write` and sensitive read scopes such as `security:read` | no |
| `viewer` | `read` | no |
| custom | exactly the scopes listed | never |

**Administration** (users, roles, service accounts, keys, the audit, app tokens) is not a scope. It
belongs to `owner` and `admin`, and only with a password sign-in. `/api/admin/*`, `/api/app-tokens*`,
`/api/session` and `/api/profile/*` answer `403` to every API key, whatever its scopes: also to a
full-access one.

**Full access.** A service account whose stored scopes are `["*"]` holds every scope that exists when a
request is checked, so a scope a plugin registers later is covered without touching the account. It is
the only place the wildcard is accepted.

`GET /api/me` → `{id, username, name, role, roleId, roleName, authKind, canWrite, canAdmin, scopes[], build}`.
`role` is `admin` for anyone who administers (the owner included, as before roles existed), otherwise the
role id; `roleId` is the exact role (`owner`, `admin`, `editor`, `viewer` or a custom id; `null` for a key
or an app token). `scopes` is the resolved list. A key reports `role: "api"` and, with the wildcard, `fullAccess: true`.

A refused call is `403` with `READ_ONLY` (the caller cannot write at all), `SCOPE_REQUIRED` (it lacks this
scope), `ADMIN_REQUIRED` (administration) or `SESSION_REQUIRED` (password sign-in only).

### Administration (administrator, password sign-in)

- `GET /api/admin/users` → `{users:[{id, username, name, role, roleId, roleName, admin, scopes, permission, disabled, createdAt, passwordAt, builtin}], roles}`.
- `POST /api/admin/users` `{username, name?, password?, role?}` → `201 {user, initialPassword?}`. `role` is an assignable role id (default `viewer`; never `owner`). Without `password` one is generated and returned once.
- `POST /api/admin/users/action`: one change per call, `{id, disabled}` | `{id, role}` | `{id, name}` | `{id, remove:true}` → `{users}`. The owner is refused (`400`).
- `POST /api/admin/users/password` `{id}` → `{user, password}`: a new generated password, shown once; the user's sessions end.
- `GET /api/admin/roles` → `{roles:[{id, name, description, builtin, admin, assignable, scopes, users, createdAt, updatedAt}], scopes:{<id>:{label, desc, write, legacy, module}}}`. `users` is how many people hold the role. In the scope catalog `write: false` marks a read-only scope and `legacy: false` one that a key from before service accounts never holds.
- `POST /api/admin/roles` `{name, description?, scopes[], id?}` → `201 {role}`. The id is made from the name unless given (`^[a-z][a-z0-9-]{1,31}$`); `read` is always included; `"*"` is refused. At most 30 custom roles.
- `POST /api/admin/roles/action` `{id, name?, description?, scopes?}` → `{role, roles}`; the change applies to the role's holders at their next request. `{id, remove:true, reassignTo?}` deletes: a role people still hold answers `409 ROLE_IN_USE` unless `reassignTo` names the role they move to (`{role, reassigned, roles}`). Built-in roles answer `400`.
- `GET /api/admin/accounts` → `{accounts:[{id, name, description, scopes, fullAccess, effectiveScopes, disabled, createdAt, lastUsedAt, keys[]}], scopes, presets}`. `scopes` is what is stored (`["*"]` for full access), `effectiveScopes` what that means now. `presets` is what an account can be created from: `read`, one per role (`role:editor`, `role:admin`, `role:<custom id>`: a snapshot of that role's scopes) and `full` (`scopes:["*"]`, `warn:true`). The role presets are worked out from the scope table when asked, so `role:editor` holds the Editor’s current write scopes (`home:write`, `software:write` and a plugin's included).
- `POST /api/admin/accounts` `{name, description?, scopes[]}` → `201 {account}`; `scopes` is a list of scope ids or `["*"]`. `POST /api/admin/accounts/action` `{id, scopes}` | `{id, description}` | `{id, disabled}` | `{id, remove:true}` (removing revokes the account's keys). `POST /api/admin/accounts/keys` `{accountId, name?}` → `201 {token, key, account}`: the token appears only here.
- `GET /api/admin/keys` → every key without its value; `POST /api/admin/keys/revoke` `{id}`. `POST /api/admin/keys` `{name, permission: read|write}` still issues a key without a service account (kept for scripts that use it).
- `GET /api/admin/agents` → `{agents:[{id, device, name, prefix, createdAt, createdBy, revokedAt, revokedBy, lastReportAt, agentVersion, platform}]}`: push agent keys, revoked ones included, never a token or its hash. `lastReportAt`, `agentVersion` and `platform` are those of the key's last accepted report (`null` before one). `POST /api/admin/agents` `{device, name?}` → `201 {token, agent}`: the token (`hha_` + 64 hex) appears only here. `device` is an id of the overview (a site device, from `site.json`, or an added device); `400 AGENT_INVALID` for an id that names nothing, the router, the NAS (`ssh.probe: "nas"`) and a device whose `platform` is `other`, `409 AGENT_LIMIT` beyond two keys per device (one to rotate) or 100 that are not revoked. `POST /api/admin/agents/revoke` `{id}` → `200 {agent}`, `404 NOT_FOUND`. A key whose device is removed, or removed and added again under the same id, is revoked by the hub itself (`revokedBy: "device-removed"`), and so is one whose device would now be refused at issue (`revokedBy: "device-changed"`). The same with the hub stopped: `node scripts/manage-access.mjs create-agent-key --device <id> [--name <n>] --output /abs/file` (writes `{"schema": 1, "agent": {id, device, name, prefix, createdAt}, "token": "hha_…"}`, 0600, only to a file that does not exist), `revoke-agent-key --id <id>` (also while the hub runs: it reads `agents.json` again when the file changes); `list` shows the keys without secrets.
- `GET /api/admin/audit?kind=access|app|api|agent&q=<text>&limit=1..1000` (default 200) → `{events:[{at, kind, event, id, subject, detail?, by?, status?}]}`, newest first. `access` = changes to users, roles, accounts, keys and agent keys (`agent-key-created`, `agent-key-revoked`; `by` is the administrator, `local administration`, `device-removed` or `device-changed`); `app` = app tokens (`app-token-issued`, `app-token-revoked`); `api` = every write through a key or MCP tool, refused ones included; `agent` = what a push agent did that changed something (`agent-refused` with its code, at most once per key and code in ten minutes; `agent-first-report`; `agent-report-after-no-news`; `agent-version-changed`; `agent-platform-changed`; the last three at most once per key and event in ten minutes), `id` the agent key, `subject` the device. No event holds a password, a token or a request body.

Limits: 100 users, 30 custom roles, 50 service accounts, 100 active keys, 100 active agent keys (`409`). Invalid input is `400 ACCESS_FAILED` (`AGENT_INVALID` for agent keys).

### Integrations (administrator, password sign-in)

What the hub reads from outside (Thermo, the router adapter, the collectors, a plugin's bridges), declared by the
modules (`docs/plugins.md` → Integrations). The UI is Administration → Integrations (`#integrations`). No API
key reaches these routes; MCP has only the read-only tool `integrations_status` (scope `read`:
`{integrations:[{id, kind, state, summary}]}`).

- `GET /api/admin/devices` → `{schemaVersion:1, generatedAt, telemetry, facets:[{id, title, icon, page, howTo, off}], devices:[…]}`: Integrations → Devices. Every device of the overview once, with what each module knows about it (extension point `devices.facets`, `docs/plugins.md`).
  A device: `{id, name, hostname, ip, kind, role, platform, source: site|added, online, lastSeen, state: ok|warn|error|not-configured, counts:{ok, attention, notConfigured, off}, facets:[{id, title, icon, how?:{by, text}, state, summary?, summaryT?, details?:[{label, value, valueT?}], href, prompt?, promptT?}]}`. `how.by` is `hub`, `source`, `collector`, `agent` or `integration`; `prompt` (a ready prompt for the person's own agent, the device filled in) comes only where the part is not set up or needs attention. An integration that declares `devices` shows as a facet `int-<id>` on those devices only. The push agents' facet is `int-agent-reports`, on each device that holds an agent key that is not revoked and is bound to it as it is now (Push agent): `ok` while the agent is fresh, `stale` once it is no news, `not-configured` while the key has not reported, `off` while the integration `agent.reports` is turned off; its `summary` is the integration item's.
  A facet's `state` is `ok`, `warn`, `stale`, `error`, `off`, `not-configured` or `not-applicable`; `href` is the page where that part is set up. `telemetry` is what the add-device dialog needs (as in `GET /api/home`). Read-only.
- `GET /api/admin/integrations` → `{schemaVersion:1, generatedAt, kinds[], integrations:[…], plugins:[{id, title, version?, source?, integrations:[id]}], pluginsDirectory}`. `pluginsDirectory` names the plugin directories, comma-separated when there are several.
  An integration: `{id, module, moduleTitle, core, title, titleKey?, kind, description, howTo, page, docs, toggle, toggleNote?, enabled, disabledBy?, disabledAt?, test, settings, status}`.
  `status` = `{state, summary, summaryT?, lastSuccessAt, lastError, configuredBy:[{source, name}], items:[{id, label, state, summary, summaryT?, lastSuccessAt, lastError?}]}`;
  `state` is `ok`, `stale`, `error`, `off`, `not-configured` or `disabled`; `source` is `site.json`, `env`, `ui`, `file` or `plugin`.
  `settings` is `null` or `{schema:[{key, label, labelKey, type, secret, options?, min?, max?, help}], values}`; a write-only field's value is `{set: true|false}`, never the value.
- `POST /api/admin/integrations/toggle` `{id, enabled}` → `{changed, integration}`. Takes effect at once, no restart. `409 INTEGRATION_LOCKED` for an integration with `toggle: false`.
- `POST /api/admin/integrations/test` `{id}` → `{id, at, result: status, integration}`: the integration's own check, now. `409 INTEGRATION_NO_TEST`, or `409 INTEGRATION_DISABLED` while it is off.
- `POST /api/admin/integrations/settings` `{id, values?, clear?}` → `{integration}`. `values` maps keys of the schema to values (a select takes one of its options; a plain text that looks like a secret is refused); a write-only value is stored in `private/integrations.json` (0600); `clear` lists write-only keys to forget. `400 INVALID_INPUT` with `details` names what is wrong; `409 INTEGRATION_NO_SETTINGS`.
- Unknown id: `404 INTEGRATION_NOT_FOUND`. Every change is a line in the access audit (`integration-enabled`, `integration-disabled`, `integration-tested`, `integration-settings`, `integration-secret-cleared`) with `by`; settings lines name the keys, never values.

The state lives in `data/state/integrations.json`: `{schemaVersion: 1, disabled: {<id>: {by, at}}}`. A missing
file means every integration is on. While one is off its data routes answer **`200` with
`disabled: {id, title, by, at}`** and empty data (or `409 INTEGRATION_DISABLED` for a change), and the
`provenance` source says `state: "disabled"`:

| Integration | Off means |
|---|---|
| `home.thermo` | No Thermo session; `GET /api/home` tiles carry no telemetry; `GET /api/home/history` → `{points:[], source:"vypnuto", disabled}` |
| `home.windows` | No SSH connection to any Windows device; their tiles carry no telemetry; their `GET /api/home/history` → `{points:[], source:"vypnuto", disabled}` |
| `home.winrm`, `home.node-exporter`, `home.prometheus`, `home.linux-ssh` | The same for the devices read by that provider: no request to WinRM, a Node Exporter or Prometheus, no Linux SSH connection |
| `router.adapter` | `GET /api/router` → `state: "disabled"`, no census; the file and the adapter are not read |
| `security.systems` | `GET /api/systems` → `{disabled, devices:[], collector:{state:"disabled"}}`; `snapshot.json` is not read |
| `security.upstream` | `GET /api/systems` answers without the newest releases and with `upstreamDisabled`; `upstream.json` is not read |
| `security.keys` | `GET /api/security` → `{disabled, devices:[], keys:[]}` |
| `home.reachability` | No TCP connect to any device; every `reachability` in `GET /api/home` and `GET /api/home/devices` reads `unknown` (the poller keeps no result) |
| `agent.reports` | The push agents' reports are not taken: `POST /api/agent/report` → `409 INTEGRATION_DISABLED` (after the key check: an unknown or revoked key is still `401`), nothing is stored. No agent record is read: `GET /api/systems`, `GET /api/security` and `home.runtimes` answer as on a hub without agents. The keys and what was stored stay; `devices[].agent` keeps saying when each device was last heard from, and goes `no-news` as the parts age |
| `updates.check` | No request to GitHub about releases; `GET /api/updates` → `state: "disabled"` with `disabled` and `latest: null`; `POST /api/updates/check` → `409 INTEGRATION_DISABLED` |

`GET /api/collectors` reports a collector that is off as `state: "disabled"`. `GET /api/home` lists what is off in
`integrations.disabled: [{id, title, kind}]`. Turning a collector off does not stop its scheduled job.

### Own account (password sign-in, every role)

- `GET /api/profile` → `{user, permissions:[{id, label, desc, write}], prefs:{timeZone}, site:{timeZone}}`.
- `POST /api/profile/prefs` `{timeZone}` → `{prefs, site}`. `timeZone` is an IANA name (`Europe/Prague`), `"browser"` (whatever the browser is set to) or `null` (the site's zone). `400 INVALID_PREFS` otherwise. The choice is stored per account (`state/access.json` → `prefs.<id>.timeZone`) and arrives as `site.timeZone` in `GET /api/ui/manifest` for that person.
- `POST /api/profile/password` `{currentPassword, newPassword}` → `{ok, signedIn, user}`; the account's other sessions end. `403 WRONG_PASSWORD`, `429 TOO_MANY_ATTEMPTS` after five wrong tries in 15 minutes.

### First run

A hub without `private/auth.json` (or `AUTH_FILE`) starts with no owner: `GET /api/ui/manifest` carries
`setupRequired: true`, the web UI shows "finish setup", and `POST /api/session` answers `409 SETUP_REQUIRED`.
`node scripts/setup.mjs` creates the owner (asked on the terminal, or `--generate`, `--password-file`,
`--password-stdin`; never a password on the command line) and writes the file with an scrypt hash, mode
`0600`. The running hub picks it up: no restart. `--force` replaces the owner's password when it is lost.

### MCP

`POST /mcp` speaks JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, `ping`) to a service-account key.
`tools/list` shows only the tools the key's scopes allow, and `tools/call` checks the scope again.

- **Which tools exist** is decided by the modules the server loaded: the core ones and every plugin's. The
  list a person can read is `tools` in `GET /api/ui/manifest` (below); the web UI shows it under
  Users and API → Connect.
- **`initialize` → `instructions`** is a short orientation: what the hub is, who the key is and which
  scopes it holds, then a few lines per module (devices and runtime stacks, the inventory, the software
  watch list, the tracker, review, and whatever a plugin adds through `mcpInstructions`). A line about a
  write tool is left out for a key without that scope.
- `whoami` (`read`) tells a key what it is: `{account, key, kind, fullAccess, canWrite, scopes:[{id, allows, write}], never[]}`.
- `initialize` → `serverInfo.version` is the release version (`1.1.0`). `hub_version` (`read`) says more:
  `{version, label, commit, exact, dataEpoch, plugins:[{id, title}], updates:{state, code, summary, updateAvailable, latest:{version, url, publishedAt} | null, checkedAt, failedAt, error, quarantined, automatic:false}}`
  (the fields of `GET /api/updates`, without the release text). Nothing checks, dismisses or applies an update over MCP.

Users, roles, accounts and keys are never managed over MCP.

### Files written before roles existed

`state/access.json` keeps `schemaVersion: 1` and loads as it is: a user's `role` of `viewer` or `admin` is the
role of that name, an account's explicit scope list is used unchanged, and a key with
`permission: read|write` keeps the reach it had. Nothing is rewritten on read; `roles[]` and
`prefs.<id>.timeZone` appear with the first write, and an older server still accepts the file.

## Push agent

A device can run a push agent that **sends** what it knows to the hub (design and threat model: `docs/agent.md`). It
reports with an agent key, `Authorization: Bearer hha_<64 hex>`, issued by an administrator for **one** device of the
overview (Administration, above). The device is the key's and never part of the report.

**The key reaches one route.** An agent key is a principal of its own kind (`authKind: "agent"`) and holds no scope. The
pipeline goes by the route that matched, never by a path prefix: with an agent key, every page, every other `/api/` route
(any method, `GET` included), `/mcp`, a path nothing matches and a plugin's route (even one whose pattern covers
`/api/agent/…`) answer `403 AGENT_ONLY`. The routes of the core module `agent` answer `403 AGENT_CREDENTIAL_REQUIRED` to
every other credential (a session, an API key of any scope including `*`, an app token) and `401 AUTH_REQUIRED` without
one. The key needs no `Origin`. An older Home Hub does not know `hha_`: such a key gets `401` there on `/api/` and
`/mcp`. `GET /healthz` answers `{ok:true}` before any credential is read, as always.

### `POST /api/agent/report`

`Content-Type: application/json` exactly (`application/json; charset=utf-8` is `403 ORIGIN_REJECTED`), at most
**512 KiB**.

```json
{"v": 1, "agentVersion": "1.6.0", "platform": "macos", "sentAt": "2026-11-13T10:00:00Z",
 "parts": {
  "heartbeat": {"schema": 1, "interval": 60},
  "os":       {"schema": 1, "collectedAt": "2026-11-13T09:59:41Z", "interval": 21600, "records": ["HOST\tstudio\tDarwin\talice\t0\t2026-11-13T09:59:41Z", "OS\tmacOS\t15.1\t…", "PRIV\tlisten\tok", "END\tok"]},
  "updates":  {"schema": 1, "collectedAt": "2026-11-13T09:59:41Z", "interval": 21600, "records": ["SWU_NONE"]},
  "packages": {"schema": 1, "collectedAt": "2026-11-13T09:59:41Z", "interval": 21600, "records": ["SW\tnode\tcmd\tv22.13.0\t/opt/homebrew/bin/node"], "withheld": [{"tag": "DOCKER", "field": 2, "reason": "secret", "count": 1}]},
  "sshkeys":  {"schema": 1, "collectedAt": "…", "interval": 21600, "records": ["HOST\t…", "KEY\t…", "END\tok"]},
  "runtimes": {"schema": 1, "collectedAt": "…", "interval": 120, "data": {"runtimes": []}}}}
```

**Envelope.** Exactly `v` (1), `agentVersion` (semver, `+dev` allowed), `platform` (`macos`, `linux` or `windows`),
`sentAt` (ISO time, `YYYY-MM-DDTHH:MM:SSZ`, milliseconds allowed) and `parts` (1 to 16). Any other key (a `device`
field included) or a wrong value refuses the report: `400 AGENT_REPORT_INVALID` with `error.field` naming it. More than
8000 record lines in all is `field: "parts"`. A body that is not JSON is `400 INVALID_INPUT`, as on every route. An
unknown part name is refused alone (`unknown-part`), so a newer agent degrades part by part against an older hub. A
name is echoed only when it is one: an unknown key that looks like a secret is `field: "body"`, a part name that does
is `field: "parts"` for the whole report.

**A part.** Exactly `schema` (one the hub knows, else `unknown-schema`), `interval` (seconds, within the range below),
`collectedAt` (not on `heartbeat`), `records` or `data` as the table says, and optionally `withheld` (at most 50
`{tag, field, reason: secret|long|invalid, count}`: what the agent left out). `os`, `updates` and `packages` come from
one run of the systems probe: sent together, with the same `collectedAt` and `interval`, or none of the three is taken.

| Part | Carries | Interval s (default, range) | Cap |
|---|---|---|---|
| `heartbeat` | nothing: the key works and the agent runs | 60, 30–900 | — |
| `os` | the system, its protection and listening ports | 21600, 900–86400 | 400 lines |
| `updates` | pending system and package updates | as `os` | 1000 lines |
| `packages` | watched software, its processes, containers, the specs digest | as `os` | 2000 lines |
| `sshkeys` | the `ssh-probe.sh` output | 21600, 900–86400 | 4000 lines |
| `runtimes` | `data: {runtimes: [...]}`, one device's entry of `home.runtimes` (`docs/plugins.md`), its documented fields only | 120, 30–3600 | 64 KiB; 20 runtimes, 30 models, 12 stats |

**Records** are the probes' tab-separated lines: at most 4096 bytes, no control character but the tab (C0, DEL and
C1, U+0080–U+009F). A part takes only its own tags (never an inherited name such as `constructor`), each with the fields counted after the tag ("rest" = every remaining field). Types: `text N` (at most N
characters), `num` (empty or digits), `iso` (`YYYY-MM-DDTHH:MM:SSZ`), `ipv4`, `octal` (empty or 3–4 digits 0–7), an
enum `a|b`, `sha256` (64 lowercase hex), `keygen` (empty, or `<bits> SHA256:<43 base64> <comment> (<TYPE>)` as
`ssh-keygen -l` prints it), `authline` (an authorized_keys line: at most one options token, a known key type, a base64
blob, a comment). Secret check: **all** = every secret pattern; **named** = all but the two shape patterns (a long hex
string, a long random-looking string), which a version, an image digest, a `sudo` digest rule or a public key trips;
**—** = typed.

| Part | Tag | Fields | Types | Check |
|---|---|---|---|---|
| os, sshkeys | `HOST` | 5 | name text 64, `Darwin\|Linux\|Windows`, user text 64, root `0\|1`, `iso` | all |
| os | `OS` | 5 | name 40, version 20, build or base 80, kernel 60, arch 20 (text) | all |
| os | `HW` | 4 | model text 60, cpu text 80, memory `num`, cpus `num` | all |
| os | `UPTIME` | 1 | `num` (macOS: boot time in epoch seconds; others: seconds up) | — |
| os | `AUTO` | 2 | key text 60, value text 20 | all |
| os | `FW` | 2 | `global\|stealth\|blockall\|allowsigned`, value text 10 | all |
| os | `PF` | 1–2 | status text 20, rules `num` | all |
| os | `FV` `SIP` `GK` | 1 | text 120 (the tool's first line) | all |
| os | `SSHD` | 2 | key text 40, value text 120 | all |
| os | `SHARE` | 2 | label text 60, `loaded\|off` | all |
| os | `LISTEN` | 3 | process text 60, user text 64, address text 64 | all |
| os | `NFT` | 1–3 | policies text 80 (`unknown` alone), rules `num`, tables text 400 | all |
| os | `PRIV` | 2 | an id of the platform's privileged list (`docs/agent.md` §5), `ok\|denied` | — |
| os | `DEFENDER` 2, `BITLOCKER` 2, `WINFW` 2, `RDP` 1 | as named | real-time `on\|off\|unknown` and signature age days `num`; volume text 8 and state; `domain\|private\|public` and state; state. State is `on\|off\|unknown` | all |
| os | `ERROR` | 1 | text 200 | all |
| os, sshkeys | `END` | 1 | `ok` | — |
| updates | `SWU` | 1 | text 400 | all |
| updates | `SWU_NONE`, `WINUP_NONE`; `SWU_ERR`, `WINUP_ERR` | 0; 1 | —; message text 200 | all |
| updates | `BREWOUT` | 3 | name text 80 (all), installed text 80, latest text 80 (named) | all / named |
| updates | `PKGUP` | 5 | `apt\|dnf`, name text 120 (all), installed text 80, candidate text 80 (named), security `0\|1` | all / named |
| updates | `PKGUP_NONE`, `PKGUP_ERR` | 2 | `apt\|dnf`, then cache age s `num` or message text 200 | all |
| updates | `WINUP` | 4 | `KB` + digits, title text 200, `Critical\|Important\|Moderate\|Low\|Unspecified`, restart `0\|1` | all |
| packages | `SW` | 4–5 | id text 60, `brew\|cask\|app\|cmd\|pydist\|json\|missing\|unsupported`, value text 300 (named), detail text 300, extra text 120 | all / named |
| packages | `RUN` | 3 | id text 60, `absent\|loaded\|` pid `num`, label text 120 | all |
| packages | `DOCKER` | 4 | name text 80, image text 160 (named), status text 80, created text 40 | all / named |
| packages | `SPECS` | 1 | `sha256` of `specs.txt` | — |
| sshkeys | `NET` | rest, 0–32 | `ipv4` each | — |
| sshkeys | `LISTEN` | 1 | `on\|off` | — |
| sshkeys | `ACCESSGROUP` | rest, 1–64 | text 64 each (`*`, a name, `%group`) | all |
| sshkeys | `SSHD` | 2 | key text 40, value text 400 | all |
| sshkeys | `USER` | 5 | name text 64, uid `num`, home text 300, shell text 120, `0\|1` | all |
| sshkeys | `SUDO` | 3 | user text 64, `rule\|none\|unknown`, text 600 | named |
| sshkeys | `AUTH` | 2 + rest | user text 64, file text 300, `authline` (options and comment named; type and blob typed) | all / named |
| sshkeys | `CFG` | 8 | user 64, alias 120, hostname 200 (text), port `num`, remote user text 64, identity files text 2000, proxy jump text 200, `yes\|no\|` | all |
| sshkeys | `KEY` | 7 | path text 400, mode `octal`, owner text 64, mtime `num`, format text 40, `yes\|no\|unknown`, `keygen` (comment named) | all / named |

The hub checks every line and trusts nothing: a failing line refuses its part (`invalid`, or `secret` naming tag and
field, never the value); an `os` or `sshkeys` part needs exactly one `HOST` and ends with `END ok`, else `invalid`;
`HOST` field 2 must match the envelope (`Darwin`–`macos`, `Linux`–`linux`, `Windows`–`windows`), else
`platform-mismatch`. A device whose `platform` is set (in `site.json` or on the device) must report that one, or every
part is refused `platform-mismatch`. A `runtimes` part passes each string through the secret check and each `url`
through the rules of `site.json → runtimes[].url` for the bound device (an origin on loopback or inside `lanCidrs`);
no string in it may hold a control character, and a `url` is stored as its origin.

**Answers.**

| Status | Code | When |
|---|---|---|
| 200 | — | `{receivedAt, accepted: [part], refused: [{part, code, tag?, field?}]}`; per-part codes `invalid`, `secret`, `too-large`, `unknown-part`, `unknown-schema`, `too-soon`, `platform-mismatch` |
| 400 | `AGENT_REPORT_INVALID` | the envelope is wrong (an unknown key, a missing `parts`, …); `error.field` names it |
| 401 | `AUTH_REQUIRED` | unknown or revoked key, also one revoked while its report was still arriving (nothing is stored) |
| 403 | `AGENT_ONLY`, `AGENT_CREDENTIAL_REQUIRED`, `ORIGIN_REJECTED` | the gate (above); a `Content-Type` that is not exactly `application/json` |
| 409 | `AGENT_DEVICE_GONE` | the bound device is gone or was added again, or is now the router, the NAS or platform `other`; the key is revoked in the same step, and every later request is `401` |
| 409 | `INTEGRATION_DISABLED` | an administrator turned the integration `agent.reports` off (Administration → Integrations): nothing is stored; the agent waits for its next interval. Checked after the key and its device: a key whose device is gone or changed still gets `AGENT_DEVICE_GONE` and is revoked |
| 413 | `TOO_LARGE` | over 512 KiB |
| 429 | `AGENT_TOO_SOON` | less than 20 s after this key's previous `200`, or while another report of this key is being taken; `Retry-After` says when |
| 500 | `UNAVAILABLE` | the device's stored record (`<state>/agent/<device>.json`) was written by a newer Home Hub: refused, never overwritten |

A part sent again before the minimum of its range is `too-soon` and not stored; the rest of the report is. Only a part
the same key stored counts for that: a key's first report after the device's other key reported is not held back by
the other key's parts (the 20 s floor stays per key). An agent sends
every part that falls due within 20 s of another in **one** report, so the floor never splits a batch.

**Time.** `collectedAt`, `sentAt` and the `HOST` time are the device's clock: information only. The hub's receive time
(`receivedAt`) is authoritative. A part is fresh until `receivedAt + 3 × interval`, then it is **no news**, never off.
More than five minutes between `sentAt` and receipt is clock skew: shown, never corrected.

**Storage.** One file per device, `<state>/agent/<device>.json` (0600, directory 0700): the latest copy of each part
with its `receivedAt` and a SHA-256 `digest`, so it is bounded by the caps; nothing is appended per report. Beside it,
`<state>/agent/history.jsonl` keeps the trend of the agents' devices: one line `{at, devices: {<id>: {os, software,
apps, warn, crit, stale}}}` (the shape of the collector's `history.jsonl`) per device at most every six hours, when an
`os` part is accepted, at most 3000 lines.

**Where it shows.** `os`, `updates` and `packages` join `GET /api/systems` and `sshkeys` joins `GET /api/security`, each
device read from the collector's record or the agent's, whichever wins (Collectors → `GET /api/systems` and `GET
/api/security` → Push agents). `runtimes` is the core module `agent`'s `home.runtimes` (`GET /api/home` →
`devices[].runtimes`, `GET /api/models`): `{"source": "agent", "observedAt": <receivedAt>, "runtimes": […]}`, merged
with the other providers; once the part is no news each runtime is `status: "unknown"` with `stats: []` and without
`activity` or `pids`, and its models `state: "unknown"` without `active`, `queued`, `since` or `pids`. Only records of
devices that exist now, would still be given a key and hold a key that is not revoked are read: revoking a device's
last key stops its records showing. A record whose last report came with a key revoked since is not read either, even
while the device's other key is live (during a rotation, a report of either live key counts), and of a record that is
read, only the parts received since the earliest live key was issued. A part received before an added device was created is not read, nor a record of
another platform than the device now has. `GET /api/collectors` and Integrations → Devices (the versions,
protection and SSH key facets) stay the collectors' alone in this release.

**The overview** (`GET /api/home`, `GET /api/home/devices`, the MCP tool `device_list`) shows each device's agent in
`devices[].agent` (Home: the overview), worked out from the same records the readers read; a `heartbeat` counts there
and nowhere else, and never towards `online`. The integration `agent.reports` (kind `agent`) is the agents' card on
Administration → Integrations, one item per device that holds a key (`ok` fresh, `stale` no news, `not-configured` not
heard from yet), and the facet `int-agent-reports` on those devices under Integrations → Devices. Turned off, the hub
takes no report (`409 INTEGRATION_DISABLED`) and the readers join no agent record (Integrations, above). The keys are
issued and revoked on Users and API → Push agents (`#access/agents`), which shows the token once, as the key file the
installer reads (`{"schema": 1, "agent": {…}, "token": "hha_…"}`, the same as `create-agent-key --output`).

### The agent on a device

Core's agent for macOS and Linux is `scripts/agent/agent.mjs`, installed on the device, by a person, with
`node scripts/install-host-agent.mjs --core` (the hub never delivers code, probes or configuration; `docs/agent.md` §5
has where everything goes and what each account sees):

```sh
node scripts/agent-specs.mjs <device> [--platform macos|linux] > specs.txt       # on the hub: the device's watch list
node scripts/install-host-agent.mjs --core --hub https://hub.example.lan [--pin <sha256> [--pin <next>] | --ca /abs/hub-ca.pem] \
  --key-file /abs/agent-key.json [--specs /abs/specs.txt] [--runtime ollama=http://127.0.0.1:11434 ...] \
  [--keys own|all-accounts|off] [--account alice] [--service launchd-agent|launchd-daemon] [--dry-run] [--once] \
  [--wait 90] [--yes] [--allow-dirty]
node scripts/agent/agent.mjs --config DIR [--state DIR] [--key FILE] [--once [--send]]   # what the service runs
```

- **Trust** fails closed: without `--pin`/`--ca` Node's certificate store with hostname verification (a reverse proxy
  with a public certificate); `--ca` a PEM that replaces the store, name checked; `--pin` one or two SHA-256
  fingerprints of the leaf certificate (either matches, so a certificate is replaced without a gap), name not checked.
  `http://` only to the literal `127.0.0.1`. Trust is checked before a byte of the request is written; no redirect is
  followed; the answer is capped at 64 KiB.
- **The answer** is read for its status, `Retry-After` and the acknowledgement (`accepted`, `refused` for the parts it
  sent), nothing else. A network error or `5xx` doubles the wait from 30 s to 15 min; `429` waits `Retry-After`; `401`
  tries again once an hour; `400`, `403`, `409` and `413` wait for the parts' next interval.
- **`status.json`** (in the state directory): `{lastAttemptAt, lastAcceptedAt, lastError, parts: {<part>: {lastSentAt,
  lastAcceptedAt, lastRefused}}}`. The installer's health check is `lastAcceptedAt` after its restart (`--wait`, 90 s
  by default), else it puts the previous agent back.
- **`specs.txt`** is checked at every start with the same rules as the installer's (`validateSpecs`, and no glob path
  with a space, no `cmd` path in `/tmp`, `/var/tmp`, `/dev/shm` or `/Users/Shared`); a file that fails stops the agent
  before anything runs (exit 78, `lastError: "specs-invalid"`). The agent adds `SPECS <sha256 of specs.txt>` to
  `packages`.
- **The key** is `--key FILE`; without it, on Linux only, systemd's credential `$CREDENTIALS_DIRECTORY/agent-key`.
- **The service** on macOS is a launchd agent of the owner's login session (`--service launchd-agent`, the default),
  or with `--service launchd-daemon` a launchd daemon, `/Library/LaunchDaemons/home-hub-agent.plist` (root:wheel
  0644), that runs the same agent as the owner (`UserName`, never root; `--account` must be the account running the
  installer) from boot, without a login session. Installing either kind boots out and removes the other; a failed
  health check puts the previous kind back. The daemon's plist sets `HOME_HUB_LAUNCHD_DOMAIN=gui/<uid>`, which the
  agent passes to `mac-probe.sh` (its own uid only): `RUN` of a label without `system/` is then read in the owner's
  GUI domain, and while that domain does not exist (nobody logged in) no `RUN` record is sent for the label. Linux has
  `systemd-system` only. `docs/agent.md` → Step 3b as built → The launchd daemon.
- `--once` collects every part, checks it and prints the envelope without reading the key or sending; `--once --send`
  sends it once and prints `{status, accepted, refused}`. The installer's `--once` runs a copy in a temporary
  directory and leaves an installed agent, its service and sudoers as they were (on Linux it makes the account
  `home-hub-agent` when it is missing).
- A failed health check puts the previous agent back, its sudoers rules and root-owned probe copy included; after a
  first install those are removed.

**Windows** has its own agent in Windows PowerShell 5.1, with no Node on the device (`scripts/agent/windows/`;
`docs/agent.md` → Step 5 as built has the install steps and the first-run checks). It sends the same envelope
(`platform: "windows"`): `heartbeat` and one run of its probe for `os` (`HOST`, `OS`, `HW`, `UPTIME`, `DEFENDER`,
`BITLOCKER`, `WINFW`, `RDP`, `LISTEN`, `END`), `updates` (`WINUP`, `WINUP_NONE`, `WINUP_ERR`, from Windows Update's own
cache, never a download or an install) and `packages` (`SW`, `RUN`, `SPECS`); no `sshkeys`, `runtimes` or `PRIV`. A
`winreg` rule's matches are `SW <id> app <version> <display name> <x64|x86>`. It runs as a Scheduled Task under
`NT AUTHORITY\LocalService`, installed by a person on the device as an administrator:

```powershell
node scripts/agent-specs.mjs <device> --platform windows > specs.txt     # on the hub
powershell -NoProfile -ExecutionPolicy RemoteSigned -File scripts\agent\windows\install-agent.ps1 -Hub https://hub.example.lan `
  -KeyFile C:\path\agent-key.json [-Specs C:\path\specs.txt] [-Pin <sha256> [-Pin <next>] | -Ca C:\path\hub-ca.pem] `
  [-Yes] [-Wait 90] [-DryRun | -WhatIf] [-Once]
powershell ... install-agent.ps1 -Uninstall
powershell ... home-hub-agent.ps1 [-Once [-Send]]                         # what the task runs
```

Trust, the answer it reads, the backoff, `status.json`, the start checks (exit 78) and the health check are the Node
agent's. Its files are under `C:\ProgramData\Home Hub Agent\` (`config\agent.json`, `config\specs.txt`,
`private\agent.key` readable by LocalService and Administrators only, `state\status.json`, `logs\agent.log`).

## Errors

Every JSON error has this shape:

```json
{"error":{"code":"INVENTORY_INVALID","message":"Inventory validation failed.","details":["optional", "strings"]}}
```

`message` is written for people and can be shown as is. Codes:

| HTTP | code | meaning |
|---|---|---|
| 400 | `INVALID_INPUT` | Body is not JSON |
| 401 | `AUTH_REQUIRED` | No valid cookie or token (expired, revoked, missing) |
| 403 | `ORIGIN_REJECTED` | Wrong or missing `Origin` (cookie POSTs) or `Content-Type` |
| 404 | `NOT_FOUND` | Unknown route or id; to an API key too, for a path that no route has by any method |
| 405 | `METHOD_NOT_ALLOWED` | Only GET and POST exist |
| 409 | `APP_TOKEN_LIMIT` | 20 app tokens already exist |
| 413 | `TOO_LARGE` | Body over 16 KB |
| 403 | `SCOPE_REQUIRED`, `SESSION_REQUIRED`, `READ_ONLY`, `ADMIN_REQUIRED` | The credential may not do this: a role or API key without the scope, a route that needs a password sign-in, a read-only account, a non-administrator |
| 403 | `AGENT_ONLY`, `AGENT_CREDENTIAL_REQUIRED` | An agent key outside the agent report; another credential on the agent report (Push agent) |
| 400/409/429 | `AGENT_REPORT_INVALID`, `AGENT_INVALID`, `AGENT_LIMIT`, `AGENT_DEVICE_GONE`, `AGENT_TOO_SOON` | The push agent's report and keys (Push agent; Administration) |
| 409 | `SETUP_REQUIRED`, `ROLE_IN_USE` | No owner account exists yet (run `node scripts/setup.mjs`); a role people still hold cannot be deleted without `reassignTo` |
| 400/403/404/409/422 | `DEVICE_INVALID`, `DEVICE_SECRET`, `DEVICE_NOT_FOUND`, `DEVICE_CONFLICT`, `DEVICE_DUPLICATE`, `DEVICE_LIMIT`, `DEVICE_READ_ONLY` | The device API (see Devices below): one code per refusal |
| 400/404/409/429/503 | `HOME_UNAVAILABLE`, `DEVICE_FAILED`, `INVENTORY_EDIT_FAILED`, `INVENTORY_UPDATE_FAILED`, `TICKETS_FAILED`, `REVIEW_FAILED`, `SEARCH_FAILED`, `ACCESS_FAILED`, `UPDATE_FAILED`, `MODELS_UNAVAILABLE`, `INVALID_QUERY` (plugins add their own) | Feature errors: 400 invalid request, 404 unknown id, 409 conflict (read again, reapply), 429 another action is running (retry shortly), 503 the feature cannot answer right now |
| 500 | `UNAVAILABLE` | Anything else |

Timestamps are ISO 8601 UTC strings. Byte sizes are integers. A value the source did not report is `null`.

## Provenance

The answers behind the pages carry one extra field, `provenance`: where the data in that answer comes from. It
is additive (a client that does not know it loses nothing) and derived from what the records themselves carry,
never decided per page. The web UI shows it as a pill next to the page title ("Agent", "Collector · 2 days ago",
"Mixed") with the breakdown on demand.

```json
"provenance": {
  "kind": "mixed",
  "lastAt": "2026-11-10T19:12:03.000Z",
  "summary": "Written by agents, 31 records, 4 changes, codex, claude-code, last 2026-11-10T19:12:03.000Z; edited by hand, 6 records, 12 changes, alice, last 2026-11-09T08:00:00.000Z.",
  "kinds": [
    {"kind": "agent", "count": 31, "unit": "records", "changes": 4, "accounts": ["codex", "claude-code"], "lastAt": "2026-11-10T19:12:03.000Z"},
    {"kind": "manual", "count": 6, "unit": "records", "changes": 12, "people": ["alice"], "lastAt": "2026-11-09T08:00:00.000Z"}
  ]
}
```

| Field | |
|---|---|
| `kind` | The one kind every source has; `mixed` when they differ; `none` when the answer holds no data yet (`kinds` is then `[]`) |
| `kinds` | The sources, busiest first, at most 12 |
| `lastAt` | The newest `lastAt` of the sources, or `null` |
| `summary` | One English sentence for a script or an agent. A UI builds its own text from the fields |

A source has `kind` and only the fields that apply:

| `kind` | Meaning | Derived from |
|---|---|---|
| `manual` | Edited by a person in the web UI or the native app | Inventory `verified_by: "user edit in Home Hub"`; tickets and review rounds whose author is a sign-in account |
| `agent` | Written with a service-account key, over MCP or the API; `accounts` names them | Inventory `verified_by: "Home Hub API · <account>"`; authors that are service accounts (or a key's name) |
| `config` | Read from a configuration file; `source` names it | Tracker projects seeded from `site.json → tracker.projects`; the software watch list (`local/software-watch.json`) |
| `collector` | Written by an automated, read-only job; `source` is its script | The collector state (`collectedAt`, interval, `state`) and the snapshot's `run` stamp |
| `telemetry` | Reported live by an agent on a device (Thermo) | Reserved for the overview's telemetry; no page above sends it yet |
| `plugin` | Supplied by a plugin; `source` is the plugin or adapter id | The router adapter, when a plugin provides it |
| `other` | A stamp or name nobody on this hub carries: an import, a hand edit of the file, a removed account; `detail` lists them | Anything the rows above do not match |

| Source field | |
|---|---|
| `id` | A stable name of the source inside one answer (`systems`, `upstream`, `watch`, `security`), for a page that shows one part |
| `source` | The script, file, plugin or adapter |
| `host` | The device the collector ran on, when the snapshot says so |
| `count`, `unit` | How many records come from it; `unit` is `entries` (inventory), `items` (tickets), `records` (the tracker list: projects, releases and items together), `projects`, `rounds`, `devices`, `sources` or `clients` |
| `changes` | Later changes by this kind of source to records it did not necessarily create (comments, edits, decisions) |
| `accounts`, `people` | Service-account names and user names, busiest first, at most 8 (`accountsMore` / `peopleMore` count the rest) |
| `lastAt` | When it last wrote: an ISO time, or a `YYYY-MM-DD` day for inventory stamps |
| `state`, `intervalSeconds` | A collector's state (see [Collector state](#collector-state)) and how often it is scheduled |
| `schedule` | How the last run was started: `{"trigger":"scheduled","scheduler":"launchd"\|"systemd","label"?}` or `{"trigger":"manual"}` (run in a terminal). Absent when the snapshot does not say (written before the stamp existed, or by cron or a pipe) |
| `detail` | Free text: the stamps or names counted as `other`, for example |

Answers that carry it: `GET /api/inventory`, `GET /api/services` (the runtime entries alone), `GET /api/tickets`,
`GET /api/tickets/<ID>` and the ticket writes, `GET /api/review`, `GET /api/review/sets/<R-n>`, `GET /api/security`,
`GET /api/systems` (sources `systems`, `upstream`, `watch`), `GET /api/software-watch` and `GET /api/router`, also
on their `404 …_MISSING` answers where a collector simply has not run. Plugins build theirs with the same helper
([plugins.md](plugins.md#provenance)).

## The UI manifest

`GET /api/ui/manifest` needs no sign-in. It tells a client what this hub is and, to a signed-in caller, what
it may open. The web shell draws its sidebar, its pages and the Connect tab from it and keeps no list of its own.

```json
{"site": {"name": "Example", "timeZone": "Europe/Berlin", "defaultLanguage": "en", "lanCidrs": ["10.0.0.0/24"]},
 "edition": "public", "signedIn": true,
 "pages": [{"hash": "overview", "admin": false, "module": "home", "view": {"url": "/home-view.js", "export": "homePage"}},
           {"hash": "versions", "admin": true, "module": "security"}],
 "nav": [{"label": null, "labelKey": "Domov", "items": [{"hash": "overview", "label": null, "labelKey": "Přehled", "soon": false, "module": "home"}]}],
 "modules": [{"id": "home", "core": true, "title": "Overview", "version": "1.2.0", "source": "core"}],
 "tools": [{"name": "device_upsert", "title": "Overview: create or replace a device", "scope": "home:write", "write": true, "description": "…", "module": "home"}],
 "apiDocs": [{"title": "Router", "routes": [["GET", "/api/router", "read", "…"]]}],
 "strings": {"en": {"source text": "translation"}},
 "inventory": {"places": [], "secretStores": []},
 "version": "1.1.0", "development": false}
```

| Field | Sent | Meaning |
|---|---|---|
| `site` | always | `name`, `timeZone`, `defaultLanguage`, `lanCidrs` from the site configuration. For a signed-in person `timeZone` is their own choice when they made one (`null` = the browser's zone) |
| `edition` | always | `private` (a tree with a site overlay) or `public` (an export). Behaviour never depends on it |
| `version` | signed in | The release this hub runs, a semver such as `1.1.0` (`package.json`). Shown in the footer. A caller that is not signed in learns no version |
| `development` | signed in | `true` when the checkout is not on the release tag of `version` (the footer then says `1.1.0+dev`); `false` on the tag, and where there is no git checkout to tell |
| `signedIn` | always | Whether the request carried a valid credential |
| `setupRequired` | only when `true` | No owner account exists yet: show how to create one (`node scripts/setup.mjs`) instead of a sign-in. The field is absent once an owner exists |
| `pages` | signed in (else `[]`) | Every routable page: `hash`, the `module` that owns it, and `view` (`url` of the page module and the name of its `export`). **`admin: true` here means "this caller may not open it"**: the page is listed so the client can refuse it by name, and it comes without `view` |
| `nav` | signed in (else `[]`) | The sidebar: groups in order, each with `label` (shown as written) or `labelKey` (Czech source text to translate) and `items`. An item has `hash`, `label` / `labelKey`, `module`, `soon` (a placeholder without a page), and `icon` when the module named one (a name from `public/icons.js` or a short glyph). Entries the caller may not open, and hidden pages (`settings`, `welcome`, `search`), are not in it |
| `modules` | signed in (else `[]`) | The loaded modules: `id`, `title`, `core` (`false` = a plugin), and where known `version` (a core module has the core's; a plugin its `plugin.json`'s) and `source` (`core`, or the plugin source's name). An unversioned plugin (no `plugin.json`) has neither |
| `tools` | signed in | The MCP tools of the loaded modules, in the order `tools/list` returns them: `name`, `title`, the `scope` a key needs, `write` (`false` when that scope is read-only), `description` (the text agents read) and `module` (`core` for the tools defined in `server/mcp.mjs`). The whole reference, not filtered by the caller's scopes; no input schemas and nothing callable |
| `apiDocs` | signed in | Rows the modules documented for the API reference: `[method, path, who, description]`, `who` being a scope id, `read`, `admin`, `password` or `security` |
| `strings` | signed in (else `{}`) | Translations of module and site labels, by language |
| `inventory` | signed in | The site's inventory vocabulary: `places`, `secretStores` |

**Who may open a page.** A module marks a page `admin: true`, names a `scope`, or both (`docs/plugins.md` →
nav entry fields). A page with neither is open to every signed-in account. A restricted page is open to
administrators (`owner`, `admin`) and to any role that holds its `scope`; a page with `admin: true` and no
scope is for administrators only. The manifest applies that rule for the caller: `nav` leaves the entry out
and `pages` marks it `admin: true`. The data routes behind a page check the scope again.

## Home: the overview

- `GET /api/home` → `{"poll","schemaVersion":1,"generatedAt","devices":[…],"telemetry","router"}`. One entry per device from the site configuration (site.json → `devices`) and per added device: identity (`id`, `name`, `hostname`, `ip`, `kind`: `thermo`, `nas`, `router` or `other`), `props` (static hardware), `online` (`online`, `stale`, `offline`, `unknown`), `lastSeen`, `quad` (CPU, GPU, power, temperature and memory averaged over the poll interval, from Thermo or from Windows telemetry), `volumes`, `services` and `stack`. `kind: "thermo"` means "has a telemetry feed", whichever provider (`telemetry.provider`) delivers it; a field a provider does not measure is `null`, never `0`.
  - `reachability` = `{"state","checkedAt","port"}` on every device: whether its address answers on the network. The hub makes a TCP connect every 60 s to the ports of its `devices[].reach` in site.json (default port 22; `false` = never checked). Only the devices of site.json are checked: a device added in the UI reads `unknown`. The check uses the site file's `ip` (else `hostname`), not a tile's address override. `state` is `answering` (a port completed the connect, or was refused: something on the host answered; `port` is that port), `not-answering` (no port answered within 2 s each) or `unknown` (not checked, no result yet, the integration `home.reachability` is disabled, or the last result is older than 3 minutes; `checkedAt` keeps that result's time). It is a signal of its own: `online` is computed as before and does not change with it, and `not-answering` says nothing certain about whether the device is running.
  - `agent` = `{"lastReportAt","freshness","agentVersion","behind","specsDiffer"}` for a device that holds a push agent key that is not revoked and is bound to the device as it is now (an added device removed and added again under its id is another device), and that would still be given one (not the router, the NAS or platform `other`) (Push agent); else `null`. `lastReportAt` is the hub's receive time of the device's last report (`null` before one). `freshness` is `fresh` (a part it sent is within `receivedAt + 3 × interval`, the 60 s heartbeat included), `no-news` (none is) or `never` (nothing received since the device's earliest such key was issued and sent with one of those keys: a report sent with a key revoked since, also one sent after this key was issued, or to an earlier device of that id, is not this key's, so a re-issued key starts at `never` and `lastReportAt` is `null` until it reports); there is no "off": a quiet agent says nothing about whether the device runs, and `online` is computed as before and never from it. `agentVersion` is what the last report said; `behind` is `true` when it has a lower precedence than the hub's own version (build metadata ignored, so `1.6.0+dev` is not behind `1.6.0`; `null` when either is unknown). `specsDiffer` is `true` when the agent's watch list (its `SPECS` digest) is not the hub's current list for that device (`node scripts/agent-specs.mjs <device>`), `false` when it is, `null` when the agent sent none or the hub's watch list cannot be read (as `agent-specs.mjs` then refuses). Only what the readers would read and what arrived since that key counts: parts received before it was issued or before an added device was created, or of another platform than the device says, do not.
  - Every device also carries `platform` (`macos`, `windows`, `linux`, `other` or `null`; the operating system, apart from `role`), `native` (below; `null` unless the device is read through Windows telemetry), `role` (`computer`, `nas`, `router`, `other`), `source` (`site` = the site configuration, `ui` = added on the overview, `agent` = written through the device API), `readOnly`, `picture` (a path), `image` (its own picture or `null`), `telemetry`, `runtimes` and `spark`. Added devices have `added:true`, `hash`, `pictureId`, `createdAt`/`createdBy` and `updatedAt`/`updatedBy`.
  - `telemetry` = `{"state","thermoId","lastSampleAt","ageSeconds","reason"}`; a device read through Windows telemetry also has `"provider":"windows"`, `"hostId"` (its own id), `"target"` (the label of the connection it is read through: `user@host` with `:port` when not 22 for an app-managed one, the SSH alias for an older one), `"connection"` (`{"mode":"managed","host","port","user","keyFingerprint","hostKeyFingerprint"}` or `{"mode":"alias","target"}`; public facts only, never a key or a path; `device_list` carries neither `target` nor `connection`), `"detail"` (the collector's last error code while not `ok`, else `null`) and `"hint"` (that code's source-language sentence: what to do), and its `thermoId` is `null`. `state` is `not-installed` (the device names no telemetry host), `not-applicable` (a router), `ok` (newest reading at most 3 minutes old), `stale` (readings exist, the newest is older) or `unreachable` (a host is named and nothing was ever read). `reason` for the last two: `no-login` (the hub has no login for that host), `denied`, `down`, `no-data`, `waiting`. A failed read never means the device is off; `online` keeps its earlier meaning for existing clients.
  - Top-level `telemetry` = `{"agent":"Thermo","repoUrl","staleAfterSeconds":180,"adapters":[…]}`: the optional telemetry agent and where to get it (one constant, `TELEMETRY_REPO_URL` in `server/thermo-client.mjs`, still a placeholder until its repository is published). `adapters` lists what this hub can connect a device to, each `{"id","name","repoUrl","connect","defaultPort","summary"}` (`summary` is a source-language sentence). The Telemetry step of Add device offers exactly these: `thermo` (`connect:"account"`, the agent) and `windows` (`connect:"ssh"`, no agent, `repoUrl:null`, also `"platform":"windows"` and `"minIntervalSeconds":30`; see [Windows telemetry](#windows-telemetry-ssh--powershell)). Also `winrm` (`connect:"endpoint"`, platform `windows`), `node-exporter` (`connect:"endpoint"`, platform `linux`, `"recommended":true`), `prometheus` (`connect:"endpoint"`, platform `linux`) and `linux-ssh` (`connect:"ssh"`, platform `linux`); `thermo` has `"platform":"macos"`. The dialog offers the adapters of the chosen platform (all of them when none is said). See [Agent-less telemetry](#agent-less-telemetry-winrm-node-exporter-prometheus-linux-ssh).
  - `native` (Windows telemetry over SSH or WinRM; Linux sources: see Agent-less telemetry) = `{"provider":"windows","observedAt","os":{"caption","version","uptimeSeconds"},"cpu":{"name","logical","cores":[%…]},"disk":{"readBps","writeBps"},"net":{"rxBps","txBps"},"gpus":[{"id","name","util","engine","memUsed","memTotal"}],"gpuCounters","span","sensors":"unsupported"}`: per-core load, disk and network rates and each GPU, averaged over the last poll interval (`span` seconds; `null` rates after the first poll, a failure or a gap). `gpus[].name` and `memTotal` are set only when one GPU and one display adapter can be paired.
  - `spark` = `{"series":"cpu"|"gpu","end","stepSeconds":10,"windowSeconds":600,"values":[…60]}` on a device with telemetry readings in the window, else `null`: the tile's small chart. `values` are percentages per 10 s step, the last one ending at `end` (unix seconds); `null` is a step without a reading and is drawn as a gap. `series` is `gpu` for a device that has `runtimes`, else `cpu`.
  - `stack.source` is `published` (with `publishedAt`, `publishedBy`, `hash`, `layerKeys`) when an agent published it, `collected` for a collected descriptor, absent for the site configuration. `runtimes` is `null` unless a `home.runtimes` provider reports local LLM runtimes for the device (docs/plugins.md); the device page then has no such section. Otherwise it is `{"source","observedAt","runtimes":[{"id","name","kind","status","url","version","source"?,"mode"?,"activity"?,"models":[{"id","state","kind","sizeGb","contextTokens","ttlRemainingSeconds","active"?,"queued"?,"since"?}],"stats":[{"label","value"}]}]}`; `activity` (`{active, queued}`: requests or jobs running and waiting) and a model's `active`, `queued`, `since` appear only where a runtime reports them and its data is fresh; `mode: "cli"` is a command-line tool (mflux) whose models are those of its jobs. `work` is `null` without runtimes, else what generates now on that device: `{items:[…], active, queued, watching:[names], blind:[names]}` (as [`GET /api/models`](#llm--diffusion-ui-models) → `work`), a request through a gateway counted once; `gpuProcesses` is `null` unless the device's telemetry agent reports the processes on its GPU (Thermo, from its 30-second snapshot), else `{observedAt, gpu, attributedPercent, rows:[{pid, name, percent, runtime?, model?}]}`: the five busiest, each with its time in the GPU's queues in per cent (100 = one GPU-second per second, averaged over 5 s; the agent's estimate, not a share of the GPU load: queues overlap, so the rows can add up to more than `gpu`), named by the runtime or model whose `pids` include it; `gpu` is the device utilization in the same snapshot and `attributedPercent` the queue time of all processes together; when more than one provider contributed (the hub's own direct reads, see [LLM runtime endpoints](#llm-runtime-endpoints), and a plugin), also `"sources":[…]`, and each runtime appears once (docs/plugins.md → `home.runtimes` from more than one provider). A stack block whose service is reported live gets its `port` and `desc` rewritten as source-language sentences (`":8081 · živě"`); `portT` and `descT` carry the same as translatable parts, like the collector texts below.
- `GET /api/home/history?device=<id>&range=30m|7d|30d|6m` → chart buckets for a device that reports through Thermo or Windows telemetry; other devices answer with `points: []` and a `reason`. A Windows reading is the average over its poll interval and fills the 30 s buckets (and the tile's 10 s spark steps) it covers, at most 120 s back; a gap stays a gap.
- `POST /api/home/refresh` `{}` → the same document after an immediate Thermo pull (rate limited) and a Windows poll (at most one every 10 s). `POST /api/home/settings` `{"intervalSeconds":15|30|60}` changes the pull interval (scope `home:settings`); Windows polls follow it but never run more often than every 30 s.
- `GET /api/ui/manifest` → what the web shell draws itself from; see [The UI manifest](#the-ui-manifest).
### Overview tile order (web UI, password sign-in only)

- `GET /api/profile/home-order` → `{"order":["studio","mini",…],"saved":true|false,"known":["studio","mini","nas","router"]}`. `order` always lists every known device: the saved ones first, then any missing in the default order (`saved:false` = nothing saved).
- `POST /api/profile/home-order` with body `{"order":["studio","nas"]}` → `{"order":[…full list…],"saved":true}`. Only known ids, each at most once; a partial list is fine, `[]` returns to the default order. `400 INVALID_ORDER` otherwise. Read-only viewers may set their own order.
- Stored per account in `state/access.json` (`prefs.<account id>.homeOrder`); deleting the user deletes it. Session cookie only: app tokens and API keys get `403 SESSION_REQUIRED`, and the POST needs the same `Origin` and `Content-Type` as every browser write. The app keeps the default order.

### Devices (web UI with write access, or an API key with `home:write`; MCP tools)

Devices that are not in the site configuration: added on the overview, or written by an agent. The site's own devices
(`local/site.json`) are listed too but stay read-only (`403 DEVICE_READ_ONLY`). All of them live in
`state/home/devices.json` (schema 1; fields added later are optional, so a file from an older hub loads unchanged).

A device: `{"id","name","hostname","ip","role","hardware":{"cpu","gpu","ramGb","diskTotalBytes"},"thermoId","picture","platform"}`. Every device of this list, site or added, also carries `reachability` and `agent` as `GET /api/home` gives them.
`id` is `[a-z][a-z0-9_-]{1,31}` and never changes; `role` is `computer` (default), `nas`, `router` or `other`; `ip` must
be a host address inside the site's `lanCidrs` when those are set; `thermoId` names the telemetry host the device
reports through (`null` = not installed); `picture` is one of the built-in ids `desktop`, `laptop`, `mini`, `tower`,
`server`, `nas`, `router`, `board`, `printer`, `generic` (served at `/images/generic/<id>.svg`), or `null` for the
role's default; `platform` is `macos`, `windows`, `linux`, `other` or `null` (not said). An upsert that omits `platform`
keeps the device's; `null` clears it. A device without a platform hashes exactly as before the field existed, so a
`hash` read from an older hub still matches. While Windows telemetry is connected (web UI only), `platform` must stay
`windows` and `thermoId` must stay `null` (`400 DEVICE_INVALID`). Values that look like a secret (keys, tokens, `password=…`, credentials in a URL) are refused.

- `GET /api/home/devices[?stack=1]` (`read`) → `{"devices":[…],"pictures":[{"id","url"}],"roles","platforms","runtimeLayers","lanCidrs","limits":{"devices":20},"telemetry"}`.
  Each device has the fields above plus `source`, `readOnly`, `hash` (`null` for site devices), `customPicture`,
  `telemetry` and `runtime` = `{"source":"published"|"collected"|"site"|null,"publishedAt","publishedBy","hash"}`
  (with `stack=1` also `stack`, in the form `POST /api/home/runtime` takes). A site device lists its effective `name`,
  `hostname`, `ip`, `hardware` and `picture` (the owner's override applied, below) and `siteOverride`
  (`{"fields":["name","hardware.ramGb",…],"updatedAt","updatedBy"}`, or `null`); it stays `readOnly` here.
- `POST /api/home/devices` `{"device":{…},"base"?}` → `201` created or `200` → `{"ok","id","hash","created","changed","by","device"}`.
  The whole record is replaced. Like inventory entries: omit `base` to create, pass the `hash` you read to change. Without
  `base`, a device that already holds exactly these fields is left alone (`changed:false`), so a repeated create is harmless;
  different fields without `base`, or a stale `base`, are `409 DEVICE_CONFLICT`.
- `POST /api/home/devices/remove` `{"id","base"?}` → `{"ok":true,"id","removed":true}`. One route for keys, apps and the
  overview's **Remove device**. An API key needs `home:write` and `base` (the `hash` read). A person or an app with
  write access needs neither the scope nor `base`, as before. A `base` that is sent is always checked (`409
  DEVICE_CONFLICT` when stale). The tile, the
  uploaded picture, the stored Thermo login or Windows connection (with the hub's key and known_hosts for it), any
  other telemetry connection and a published runtime stack go with it; metric history stays.
- `POST /api/home/runtime` (≤ 64 kB) `{"device","stack"|null,"base"?}` → `{"ok","id","hash","changed","published","publishedAt","by"}`.
  Publishes the runtime stack drawn on the device's page (site devices included). It replaces the stack from the site
  configuration or a collected descriptor, or adds one; `stack:null` takes the publication back. Optional `base` = the
  published stack's hash. `stack` = `{"cols":[engine key per column, 1–12],"engines"?:{key: label},"blocks":[1–60]}`;
  a block is `{"id","layer","col0","col1","title","port"?,"desc"?,"state"?:"on"|"off","service"?,"models"?:[{"id","state"?,"sizeGb"?,"path"?}]}`
  with `layer` one of `input`, `tool`, `runtime`, `engine`, `hardware`. A block spans columns `col0..col1` of its
  layer; two blocks of one layer may not overlap.
- Errors: `400 DEVICE_INVALID` (with `details` naming the field), `422 DEVICE_SECRET`, `404 DEVICE_NOT_FOUND`,
  `409 DEVICE_CONFLICT` / `DEVICE_DUPLICATE` (hostname already used) / `DEVICE_LIMIT` (20 added devices),
  `403 DEVICE_READ_ONLY`.
- MCP: `device_list` (`read`; `runtime:true` includes the published stacks), `device_upsert`, `device_remove`,
  `runtime_publish` (`home:write`). Same arguments and rules as the routes above. `home:write` is never given to keys
  created before scopes existed. Every call of a write tool is in the write log with the device id.

### Editing a device of the site configuration (web UI, password sign-in with write access only)

Every tile on the overview, a site device's included, has an **Edit** button for a writer. For a device from
`site.json` it changes **display metadata only**, stored as the owner's override over the site's values in
`state/home/site-overrides.json` (0600, no secrets):
`{"schema":1,"overrides":[{"id","fields":{"name"?,"hostname"?,"ip"?,"hardware"?:{"cpu"?,"gpu"?,"ramGb"?,"diskTotalBytes"?},"picture"?},"image"?,"imageAt"?,"updatedAt","updatedBy"}]}`.
`site.json` is never written; `id`, `role`, `platform`, `thermoId`, `ssh`, `stack`, the telemetry binding, the service
probes, Thermo and the router adapter keep reading the site's values (a changed hostname or ip is shown, not probed).

- `GET /api/home` → every site device carries `siteOverride` (`{"fields":[names],"hash","image","updatedAt","updatedBy"}`;
  `hash` is the `base` an edit sends, also when nothing is overridden) and `siteDefaults` (`{"name","hostname","ip","hardware","picture","image"}`,
  the site's own values). The tile shows the override's values; a collected descriptor never wins over it.
- `POST /api/home/devices/site` `{"id","base","device":{"name"?,"hostname"?,"ip"?,"hardware"?,"picture"?}}` →
  `{"id","override","hash","changed"}`. The whole override is replaced: an absent field, or one sent with the site's own
  value, goes back to the site's (not stored). Rules as for an added device (name 1–60, a host name or IPv4, an ip inside
  `lanCidrs`, cpu ≤ 60, gpu ≤ 40, positive numbers or `null`, a built-in picture id; secret-looking values are
  `422 DEVICE_SECRET`). `role`, `platform`, `thermoId`, `id`, `ssh`, `stack` are refused by name (`400 DEVICE_INVALID`).
  A stale or missing `base` is `409 DEVICE_CONFLICT` / `400`; another device's hostname `409 DEVICE_DUPLICATE`;
  an id that is not a site device (an added device included) `404 DEVICE_NOT_FOUND`.
- `POST /api/home/devices/site/reset` `{"id","base"}` → back to the site's defaults: the override and the uploaded picture go.
  An override whose device left `site.json` is kept on disk, ignored, and cleared only here.
- Own picture: `PUT /api/home/devices/<id>/image` and `POST /api/home/devices/image/remove` `{"id"}` work for a site
  device too (its override's `image`); it is served at `GET /api/home/devices/<id>/image` (not under `/images/home/`,
  where the site's own picture is a static file).
- API keys, app tokens and accounts signed in otherwise are refused (`403`); `device_upsert` /
  `device_remove` keep refusing site devices (`DEVICE_READ_ONLY`). A Thermo Mac and the router are editable the same
  way; their editor says who reads their telemetry, which this edit never changes.

### Devices on the overview: pictures and Thermo logins (web UI, write access, never API keys)

What needs a person: uploading a picture and giving the hub a Thermo login. A device's Thermo login is kept in
`state/home/thermo-hosts.json` (mode 0600, sealed with the hub's key: docs/storage.md → Secrets at rest; opened, the same shape as `private/thermo-hosts.json`) and its uploaded picture in
`state/home/images/<id>.jpg`. Added devices appear in `GET /api/home` with `added:true` and `kind` derived from
`thermoId` and `role` (`thermo`, `nas`, `router`, `other`); their ids join `known` in the tile order. These form
routes refuse with one code, `DEVICE_FAILED` (and `details` naming the field where one was at fault); the device API
above has a code per refusal.

- `POST /api/home/devices/probe` `{"host","port"?}` → `{"fingerprint","subject","validTo"}`: a TLS handshake with
  Thermo, nothing sent. `422` when nothing answers.
- `POST /api/home/devices/add` `{"name","kind","hostname","ip"?,"role"?,"picture"?,"props"?:{"cpu","gpu","ramGb","diskTotalBytes"},"thermo"?:{"port","username","password","pin"}}`
  → `201` the device (its id is made from the name). A `thermo` device first logs in once with the pinned certificate (`pin` = the fingerprint the
  user confirmed); a refused login is `422` and nothing is saved. Then the poller starts pulling it, without a restart.
  `409` for a hostname already added, at most 20 devices.
- `PUT /api/home/devices/<id>/image` with `Content-Type: image/jpeg` (≤ 3 MiB, cropped to 3:2 in the browser) → the device.
- `GET /images/home/<id>.jpg` → the picture (signed in).
- `POST /api/home/devices/thermo` `{"id","thermo":{"port","username","password","pin"}}` → the device: connects a device
  that is already on the overview (for example one an agent created). The login is tried once with the pinned certificate
  first; then the device is its own telemetry host (`thermoId` = its id). `{"id","thermo":null}` forgets the login.
- `POST /api/home/devices/image/remove` `{"id"}` → the device, back on its built-in picture.
- Removing a device is `POST /api/home/devices/remove` of the device API above (`device_remove` over MCP); the
  overview sends the `hash` it read as `base`.
- `POST /api/home/devices/add` also takes `"kind":"windows"` (and optional `"platform":"windows"`) with
  `"windows":{"draft","host","port","user"}`: an app-managed connection whose set-up draft (below, made for a new device) passed
  its test with exactly this host, port and user; otherwise nothing is saved (`409 WINDOWS_SETUP_FAILED`, `reason` `needs-test`,
  `stale`, …). The older `"windows":{"target"}` (an alias) is still accepted: the SSH connection is tried once first; a failure is
  `422 WINDOWS_SSH_FAILED` and nothing is saved.
- `POST /api/home/devices/windows/check` `{"target"}` (older alias connections) → `{"ok":true,"target","resolved":{"hostname","user","port"}|null,"tookMs","os":{"caption","version"},"cpu":{"name","logical"},"memTotal","volumes":[{"mount","name","fs","total"}],"gpus":[name],"gpuCounters","vramUsed","sensors":"unsupported"}`.
  Runs the collector once and stores nothing. `400` for an invalid target (never tried), `422 WINDOWS_SSH_FAILED` with
  `reason` (`host-key-unknown`, `host-key-changed`, `denied`, `unresolved`, `refused`, `timeout`, `unreachable`, `ssh-config`,
  `ssh`, `no-ssh`, `no-keyscan`, `no-host-key`, `key-missing`, `key-permissions`, `no-powershell`, `powershell`, `bad-output`,
  `no-counters`, `too-large`, `spawn`, `busy`, `unavailable`) and a
  `message` saying what to do. At most two tests run at a time (`busy` otherwise).
- `POST /api/home/devices/windows` `{"id","windows":{"draft","host","port","user"}}` → the device: connects a device that is
  already on the overview (added as a plain tile, or by an agent) to Windows telemetry, or changes its connection, with a draft
  made for this device that passed its test. `{"id","windows":{"target"}}` does the same with an older alias (tested first).
  The device keeps its id, picture, creation and history and gets `platform:"windows"`; the connection it replaces is
  forgotten, with the hub's key and known_hosts for it. Refused (`400`) while it reports through Thermo or has another platform.
  `{"id","windows":null}` disconnects (and deletes the hub's key for it; the public key stays in authorized_keys on Windows
  until someone removes it there).

#### App-managed SSH: set-up drafts

The Add/Edit device dialog builds a connection on the server, one step at a time, in a **draft**
(`server/windows-ssh.mjs`). Every route below is for a person signed in with a password and write access only (`403` for API
keys, app tokens and read-only accounts), and a draft is visible only to the person who made it. A draft lives in memory, for at most 30 minutes after its last step; at most 3 per person (the oldest gives way) and
16 in all. Each reply carries `draft` = `{"id","device","host","port","user","key":{"type","bits","fingerprint","publicKey","source","reused"}|null,"hostKeys":[{"type","fingerprint"}]|null,"trusted":{"type","fingerprint","reused"}|null,"tested":{"at"}|null,"expiresAt"}`
— never a private key, never a path. Refusals are `WINDOWS_SETUP_FAILED` with a `reason` and a sentence (`draft-missing` 404;
`busy`, `needs-key`, `needs-scan`, `needs-trust`, `needs-test`, `stale`, `trust-mismatch`, `limit` 409; `key-format`,
`key-encrypted`, `key-public`, `key-putty`, `key-unsupported`, `key-weak`, `key-mismatch` 422; `store`, `store-path` 503), or,
for a step that connects, `422 WINDOWS_SSH_FAILED` as above.

- `GET /api/home/devices/windows/tools` → `{"ok","ssh":{"ok","version"},"keyscan":{"ok"}}`: whether the hub's server has the
  OpenSSH client tools (it runs `ssh -V` and `ssh-keyscan` without arguments; nothing connects). Cached for a minute.
- `POST /api/home/devices/windows/draft` `{"id"?}` → `201 {"draft"}`. With the id of a device read through an app-managed
  connection, its host, port, user, key and verified host key are taken over (`reused:true`), so changing only the user needs
  only a new test.
- `POST …/draft/key` `{"draft","generate":true}` makes a new key (RSA 3072, Node's built-in crypto); `{"draft","privateKey"}`
  imports one (at most 16 KiB of text: OpenSSH, PKCS#1, SEC1 or unencrypted PKCS#8; RSA ≥ 2048 bits, ECDSA P-256/384/521 or
  Ed25519). Encrypted keys are refused (`key-encrypted`), never prompted for. The key gets the comment `home-hub`; the draft's
  previous key goes; the test must run again.
- `POST …/draft/scan` `{"draft","host","port"}` → `draft.hostKeys`: what `ssh-keyscan` gets from host:port (it sends no user,
  key or password). Another host or port than before drops the scan, the trust and the test.
- `POST …/draft/trust` `{"draft","fingerprint"}`: the person compared this fingerprint (one of the last scan) with what Windows
  shows and confirms it. Only this key is stored for the connection.
- `POST …/draft/test` `{"draft","host","port","user"}` → `{"draft","result"}`; `result` is what `/check` returns, plus
  `"connection":{"host","port","user","keyFingerprint","hostKeyFingerprint"}`. Another user than before drops the earlier test.
  Saving needs a test of exactly what the draft now holds, at most 15 minutes old.
- `POST …/draft/discard` `{"draft"}` → `{"discarded":true}`; the dialog sends it when it closes without saving. The draft's
  key and known_hosts go at once (a draft that expires loses them too).

At most two SSH steps (tests, host-key fetches, key generation) run at once (`busy` otherwise).

### Windows telemetry (SSH + PowerShell)

Integration `home.windows`, core module `home`, `server/windows-telemetry.mjs` (the collector) and `server/windows-ssh.mjs`
(the hub's key store, host-key discovery, set-up drafts). No agent on Windows: the hub logs in with key-only SSH and runs one
fixed, read-only PowerShell script (`-EncodedCommand`) that reads CIM classes. Nothing is installed or changed on the target.
The hub may run on Linux, macOS or Windows, and the browser's system does not matter.

**Prerequisite on the hub's server**: the OpenSSH client tools, `ssh` and `ssh-keyscan` (Windows: the optional feature
OpenSSH Client; Linux: `openssh-client` or `openssh`; macOS has them). Nothing else: no `~/.ssh/config`, no agent, no key
files made by hand. Missing tools are reported (`/tools`, `no-ssh`, `no-keyscan`).

**Set-up** (the Add/Edit device dialog, under Telemetry → Windows): host (by default the device's address), SSH port (22) and
Windows user; *Create a new key* (or import one); copy the PowerShell step it shows and run it on Windows as administrator;
*Fetch the host key*, compare the fingerprint with what the PowerShell fingerprint snippet prints on Windows and confirm it;
*Test connection*; save. The only Windows-side steps are, as copyable PowerShell (`public/windows-setup.js`):

- installing OpenSSH Server, only when it is not there (`Add-WindowsCapability … OpenSSH.Server`, the service set to start
  automatically; the installation adds the firewall rule for port 22; another port must already be set up on Windows);
- authorizing the hub's public key for that one account: the account's SID is resolved (so localized group names do not
  matter); a standard account gets the key in `<profile>\.ssh\authorized_keys` (ACL: the account, SYSTEM, Administrators); an
  administrator in `%ProgramData%\ssh\administrators_authorized_keys` (ACL: Administrators, SYSTEM) — but the snippet stops
  for an administrator unless `$AllowAdministrator = $true` is set, because that file is shared by every administrator of the
  PC. The key line starts with `restrict` (no forwarding, no terminal). It never creates an account, changes a group, sshd's
  configuration, the firewall or UAC. Someone who already runs sshd only needs this step;
- optionally, adding a standard account to Performance Monitor Users (`S-1-5-32-558`) when the test says counters are missing
  (the membership allows reading performance counters, nothing else).

- **App-managed connection** (stored in `state/home/windows-hosts.json`, 0600): `{"mode":"managed","host","port","user",
  "keyId","connId","keyType","keyFingerprint","publicKey","keySource","hostKey":{"type","key","fingerprint"},"configuredAt",
  "configuredBy"}`; host is a host name or IPv4 address, user `name`, `DOMAIN\name` or `name@domain` (letters of any script,
  digits, space, `.`, `_`, `-`; no quotes, `%`, `$`), port 1–65535. Never in `devices.json`; agents cannot set it.
- **The key store**, `state/home/ssh/` (POSIX: directories 0700, files 0600, owned by the hub's account, checked after every
  write; Windows: an explicit ACL with only the hub's own account and SYSTEM, no inheritance): `keys/<keyId>` (the private
  key), `known_hosts/<connId>` (the one verified host key, under the alias `hh-…`), `empty` (an empty file). Files nobody refers
  to (an unfinished draft, a removed device) are deleted at start and every few minutes. **Backups of the state directory
  contain these private keys**: keep them as private as the hub's other secrets. A key is never returned by an API, written to
  `devices.json`, logged, put in an error, MCP reply or export.
- **ssh** (managed): spawned without a shell, with ssh's whole configuration replaced and nothing of the account it runs as:
  `ssh -F <empty> -T -i <key> -l <user> -p <port> -o BatchMode=yes -o StrictHostKeyChecking=yes -o CheckHostIP=no
  -o UpdateHostKeys=no -o IdentitiesOnly=yes -o IdentityAgent=none -o PreferredAuthentications=publickey -o PasswordAuthentication=no
  -o ProxyCommand=none -o ControlMaster=no -o ForwardAgent=no -o ClearAllForwardings=yes … -o UserKnownHostsFile="<known_hosts>"
  -o GlobalKnownHostsFile="<empty>" -o HostKeyAlias=hh-… -- <host> <fixed command>`; the environment loses `SSH_AUTH_SOCK`,
  `SSH_ASKPASS` and `DISPLAY`. An unknown or changed host key is always refused (`host-key-unknown`, `host-key-changed`); the
  way back is to fetch and verify the host key again in the dialog. Changing host or port drops the trust and the test;
  changing the user or the key drops the test.
- **Older alias connections** (`{"id","target"}` in the same file) keep working unchanged: ssh with the account's own
  `~/.ssh/config`, keys and `known_hosts`, as `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes … -- <target> <fixed command>`.
  The dialog offers to convert one (the alias and `~/.ssh` stay as they are). Target rule: an alias or `user@host`; letters,
  digits, `.`, `-`, `_`, each part starting with a letter or digit (a user may start with `_`); no spaces, `%` tokens, ports or
  shell characters.
- Every run: stdin closed, killed after 25 s, stdout ≤ 1 MiB, stderr ≤ 16 KiB and only classified, never logged or returned.
- **Readings**: CPU (total and per logical processor), disk and network come from raw counters
  (`Win32_PerfRawData_*`): a reading is the difference between two polls, the true average over that interval (`span`),
  stamped when it was read. The first poll after a start, a failure or a gap over 300 s gives memory and volumes only.
  GPU: running time per engine (all processes on it), divided by the elapsed time and capped at 100 %; a GPU is as busy
  as its busiest engine, the device's `gpu` is its busiest GPU. Memory is RAM (`memUsed`, `memTotal`, `swapUsed` from the
  page file); VRAM is in `native.gpus`. Volumes are the fixed drives. Temperatures, fans and power are not read
  (`null`, `sensors:"unsupported"`). Values are parsed locale-independently (invariant culture, counters as decimal strings).
- **Polling**: one SSH connection per device per interval, never more often than every 30 s, at most four devices at a time,
  never two polls of one device at once. Minute rows go to `<state>/windows/minutes-<id>-YYYY-MM.jsonl` (0600) and are
  read back at start, like Thermo's; 8 days are kept in memory. A device that is removed or re-targeted (any change of host,
  port, user, key or host key) is dropped at once; an answer still in flight for it is discarded.
- **Status** (`GET /api/admin/integrations`): one item per connected device: `ok`, `stale` or `error` with `lastError`
  (the codes above) and the sentence for it.

### Agent-less telemetry: WinRM, Node Exporter, Prometheus, Linux SSH

Four more providers beside Thermo (the agent) and Windows over SSH, in core module `home`. One table names them
(`server/telemetry-providers.mjs`): `telemetryProvider` of a device, its `platform`, its integration, its error sentences.

| Provider | Reads | Module | Integration | History |
|---|---|---|---|---|
| `winrm` — Windows (WinRM) | fixed WQL `Enumerate`/`Pull` of the WMI classes the SSH script reads, `POST /wsman`, HTTPS only | `server/winrm-telemetry.mjs` | `home.winrm` | `<state>/windows/` |
| `node-exporter` — Linux (Node Exporter) | `GET /metrics` of Prometheus Node Exporter (default port 9100), text format 0.0.4 | `server/linux-telemetry.mjs`, `server/prom-text.mjs` | `home.node-exporter` | `<state>/linux/` |
| `prometheus` — Linux (Prometheus) | `GET /api/v1/query` of an existing Prometheus (default 9090) for ONE node_exporter target (job + instance) | `server/prometheus-telemetry.mjs` | `home.prometheus` | `<state>/linux/` |
| `linux-ssh` — Linux (SSH) | one fixed POSIX `sh` script over the hub's own SSH key (reads `/proc`, `/sys/class/hwmon`, `df -P -k`) | `server/linux-telemetry.mjs` (+ `server/windows-ssh.mjs` drafts with `os:"linux"`) | `home.linux-ssh` | `<state>/linux/` |

- **Transport** (`server/endpoint-http.mjs`, Node's `net`/`tls`/`http` only, no dependency): host and port are validated
  values, the path is a constant, never a URL from the browser. HTTPS is verified **before** the request is written:
  `tls:{mode:"ca"}` (Node's CA store plus `NODE_EXTRA_CA_CERTS`, with hostname verification) or `tls:{mode:"pin",pin}`
  (SHA-256 of the leaf certificate a person approved; the host name is not checked in this mode). No insecure mode, no
  redirects (3xx is an error), no compression, a size cap (1 MiB per WinRM reply, 8 MiB for `/metrics` and Prometheus
  replies), a deadline. Credentials (Basic; for Prometheus also a bearer token) only over verified HTTPS; plain HTTP is
  allowed only without credentials (a Node Exporter or Prometheus on the LAN).
- **WinRM**: Basic authentication with a **local** Windows account is the only scheme; Kerberos, NTLM/Negotiate, CredSSP,
  certificates and PowerShell remoting are not supported. Basic is off in WinRM by default; the dialog's PowerShell
  step (`public/telemetry-setup.js`) enables it for the WinRM service only, adds an HTTPS listener with a self-signed
  certificate only when there is none, and one firewall rule for the hub's address; it keeps existing listeners and
  settings and never sets `AllowUnencrypted`, `TrustedHosts`, UAC or runs `quickconfig`. A standard account needs Remote
  Management Users, Performance Monitor Users and Remote Enable on `root/cimv2` (`wmimgmt.msc`). Replies are read by a
  strict XML reader (`server/safe-xml.mjs`: no DTD, no entities beyond the five predefined, no CDATA, bounded). The
  data becomes the very object the SSH PowerShell script prints, so readings, history and `native` mean the same.
  Differences: display adapters come from `Win32_VideoController` (memory ≥ 4 GB unknown: `null`).
- **Linux mapping** (Node Exporter, Prometheus and SSH alike): CPU per logical CPU and total = 1 − Δ(idle+iowait)/Δ(all
  modes but guest); memory = MemTotal − MemAvailable (the ZFS ARC counts as used), swap used; disk rates summed over whole
  physical disks (`sd*`, `vd*`, `xvd*`, `hd*`, `nvme*n*`, `mmcblk*`; no partitions, `dm-*`, `md*`, loop, zram); network
  rates summed over interfaces that are not loopback, bridges, veth, container, tunnel or VPN; volumes = local block
  filesystems, one per device and **one per ZFS pool** (its least nested mounted dataset, labelled with the pool), never
  summed into a hardware disk size; `cpuTemp` from hwmon (`coretemp`, `k10temp`, `zenpower`, `cpu_thermal`), `gpuTemp` from
  `amdgpu`/`radeon`/`nouveau` hwmon when reported; GPU utilisation and power are `null`. A rate needs two snapshots of
  one boot at most 300 s apart; a counter that went backwards gives `null`, never an average across the reset.
  `native` = `{"provider","observedAt","os":{"caption","version","arch","uptimeSeconds"},"cpu":{"name","logical","cores"},
  "load":[1,5,15]|null,"disk","net","gpus":[],"gpuCounters":false,"span","temps":[{"chip","label","c"}],"sensors":"reported"|"none"}`.
- **Prometheus**: only three fixed discovery queries (`node_uname_info`, `up`, `timestamp(up)`) and one snapshot selector
  `{__name__=~"up|<the node_exporter metrics above>",job="<job>",instance="<instance>"}[120s]`; job and instance are
  only values Prometheus listed at discovery, embedded as escaped string literals. Never `/metrics` of Prometheus, never an
  admin, lifecycle, reload or write route, never PromQL from the browser. Discovery lists each `(job, instance)` with a
  `node_uname_info` series (Prometheus' own target has none); a pair with more than one is `ambiguous` and not
  selectable. The snapshot is the target's newest scrape: its `up` sample must be 1 (`target-down`) and inside the
  two-minute window (`stale`); every other series contributes only its sample of exactly that scrape; the reading is
  stamped with the scrape time. A poll that finds the same scrape as before records nothing (no fabricated freshness).
- **Set-up drafts** (`server/endpoint-setup.mjs`; password sign-in with write access only, `403` for API keys and app
  tokens). A draft belongs to its person, is bound to one device (or a new one) and one provider, lives in memory only
  (30 min idle), and holds the password or token one-way: a view says only `password:{set,reused}`.
  - `GET /api/home/devices/hub-address` → `{"address"}`: the hub's own IPv4 address inside the site's networks
    (`lanCidrs`), or `null` when it has none there. The set-up guides put it into their firewall lines.
  - `POST /api/home/devices/endpoint/draft` `{"provider":"winrm"|"node-exporter"|"prometheus","id"?}` → `201 {"draft"}`;
    with a device id, its stored connection of that provider is reused (host, port, scheme, user, trust, secret).
  - `POST …/draft/probe` `{"draft","host","port"}` → the certificate (`fingerprint` hex, `subject`, `issuer`, `altNames`,
    `validFrom`, `validTo`, `selfSigned`, `caVerified`, `hostnameOk`): a TLS handshake only, nothing sent.
  - `POST …/draft/trust` `{"draft","mode":"ca"|"pin","fingerprint"?}`: `ca` only when the probe verified chain and name
    (`ca-unverified`), `pin` only with the probed fingerprint (`trust-mismatch`).
  - `POST …/draft/discover` (Prometheus) `{"draft","host","port","scheme","auth":"none"|"basic"|"bearer","user"?,"password"?}`
    → `{"draft","targets":[{"job","instance","nodename","release","up","lastSampleAt","eligible","reason"}]}`; no target at
    all is `422 TELEMETRY_FAILED reason:"no-targets"` with the guide sentence.
  - `POST …/draft/test` `{"draft","host","port","scheme"?,"user"?,"password"?,"auth"?,"job"?,"instance"?}` → `{"draft","result"}`
    (the facts the source reports); job+instance must be an eligible discovered target (`needs-targets`, `target-unknown`).
  - `POST …/draft/discard` `{"draft"}`.
  - Refusals: `TELEMETRY_SETUP_FAILED` with `reason` (`draft-missing`, `busy`, `needs-probe`, `needs-trust`, `needs-test`,
    `needs-password`, `needs-targets`, `target-unknown`, `stale`, `trust-mismatch`, `ca-unverified`, `plain-credentials`,
    `limit`); failures at the device: `422 TELEMETRY_FAILED` with `provider`, `reason` and the sentence (never the
    remote text).
  - Linux SSH: the SSH draft routes under `/api/home/devices/ssh/…` (`tools`, `draft` with `{"os":"linux","id"?}`, `draft/key`,
    `draft/scan`, `draft/trust`, `draft/test`, `draft/discard`); the user is a POSIX name (`^[A-Za-z_][A-Za-z0-9._-]{0,31}$`).
- **Saving**: `POST /api/home/devices/add` with `"kind":"winrm"|"node-exporter"|"prometheus"|"linux-ssh"` and
  `"telemetry":{"provider","draft","host","port","scheme"?,"user"?,"auth"?,"job"?,"instance"?}` (no password: it is in the draft);
  `POST /api/home/devices/telemetry` `{"id","telemetry":{…}}` connects an existing device or **switches** it from another
  agent-less provider (Windows SSH included): its id, picture and history stay; the old connection's poller entry, key
  files and stored secret go. `{"id","telemetry":null}` disconnects whichever agent-less provider reads it. Both take only
  a draft made for that device whose test (at most 15 min old) matches what is sent (`stale`, `needs-test`). Thermo must be
  disconnected first. `platform` becomes the provider's (`windows` or `linux`) and `device_upsert` cannot change it
  while connected.
- **A device of the site configuration** (`source:"site"`) is connected the same way, on its own tile (page → Telemetry
  settings), with the same drafts, tests, trust, permissions, switching and disconnecting: pass its id as `id` to the draft
  routes (`…/endpoint/draft`, `…/ssh/draft` with `os:"linux"`, `…/windows/draft`) and to `POST /api/home/devices/telemetry`
  or `POST /api/home/devices/windows` (Windows over SSH: a managed connection only, never an SSH alias). Its identity
  stays in `site.json` and is never written; `device_upsert` / `device_remove` still refuse it (`DEVICE_READ_ONLY`),
  nothing is added to `devices.json`, and it cannot be removed (its display metadata is the owner's override: below,
  "Editing a device of the site configuration"). What the hub stores is a
  **binding** in `state/home/site-telemetry.json` (`{"schema":1,"bindings":[{"id","provider","platform","configuredAt","configuredBy"}]}`,
  0600, no secrets); the connection itself (key ids, passwords, trust) is in `windows-hosts.json` /
  `telemetry-hosts.json` under the same id, as for an added device. Which site devices can take one, and the rule
  that keeps two feeds from reading one device:
  - **Thermo wins where the site says so.** A site device with `thermoId` is read through Thermo (`site.json` +
    `private/thermo-hosts.json`) and refuses a binding (`400`, detail names `thermoId`); the router is reported by the
    router adapter and refuses one too. `POST /api/home/devices/thermo` does not apply to site devices (`404`).
  - The site's `platform` (`devices[].platform`, optional: `macos`, `windows`, `linux`, `other`), when set, limits the
    providers to that system's; without it every agent-less provider is offered and the binding records the platform
    its provider reads. Disconnecting returns the tile to what the site configuration says; it never falls back to
    another stored or default connection.
  - Only ids that are site devices now count. A binding whose device left `site.json` (or got a `thermoId`, or another
    platform) is neither polled nor shown anywhere; its connection stays on disk, so an edit of `site.json` never
    deletes a key, until `POST /api/home/devices/telemetry {"id","telemetry":null}` clears it. Pollers, restarts and the
    SSH key sweep include the effective bindings, so a connection survives a restart.
  - Reading side: the site tile keeps `source:"site"`, `readOnly:true`, `hash:null`, its name, role, picture, hardware
    and (a NAS) its probed services, and gains `kind:"thermo"` (has a telemetry feed), `platform`, `telemetry.provider`,
    gauges, history, volumes and `native`. Every site device carries `telemetryEditable` (it can take a binding) and
    `telemetryBinding` (`{"provider","platform","configuredAt"}` or `null`); `device_list` lists the `platform` and
    `telemetry.provider` but never the connection.
- **Reading side**: `GET /api/home` tiles carry `telemetry.provider`, `target` and `connection` (public facts:
  `{"mode","host","port","scheme","tls":{"mode","fingerprint"?},"auth","user"?,"job"?,"instance"?}`; never a password or
  token; `device_list` carries neither). Polls: never more often than 30 s, at most four devices at a time per provider.
- **Not supported** (said so, never faked): Windows Exporter, GPU utilisation and power on Linux, IPv6 addresses,
  Kerberos/NTLM for WinRM, a custom CA bundle per connection (use pin mode or `NODE_EXTRA_CA_CERTS`).

### LLM runtime endpoints

Local LLM runtimes the hub reads itself over HTTP (core module `runtimes`), every 30 s (`RUNTIMES_POLL_SECONDS`,
10–600). What they report appears in `GET /api/home` → `devices[].runtimes` and fills the stack blocks that name
their service. Endpoints come from `site.json → runtimes` (`source: "site"`, read-only here) and from this API
(`source: "ui"` or `"agent"`, stored in `state/runtimes-config.json`).

An endpoint: `{"id"?,"device","kind"?,"url","name"?}`. `id` is `[a-z][a-z0-9-]{1,47}` (default `<device>-<port>`);
`device` is a device on the overview; `kind` is `auto` (default: recognised by its answers), `llama-swap`,
`ollama`, `lmstudio`, `llama-cpp`, `vllm`, `sglang`, `omlx`, `mlx-serve` or `openai`; `url` is an origin only:
`http(s)://<IPv4 or localhost>:<port>`, no path, query, user or password, on loopback or inside the site's
`lanCidrs` (any private range when none are set). At most 40 endpoints, each URL once.

What the hub requests, and nothing else: `GET` on `/v1/models`, `/running`, `/api/version`, `/api/metrics/stats`,
`/api/metrics/activity`, `/api/metrics`, `/metrics`, `/api/tags`, `/api/ps`, `/api/v0/models`, `/health`, `/props`,
`/version`, `/v1/models/status`, `/admin/api/stats` (bodies ≤ 512 KiB, 3 s timeout, no redirects). Never a model-loading
or unload route (llama-swap's `/upstream/…`, `/unload`, `/api/models/unload`), never `/slots`, never a prompt.
For the request history of a llama-swap endpoint, two more reads, also GET only: `/api/metrics/activity?page=<1–10>&limit=200`
(exactly those parameters) and the access-log stream `/logs/stream/http?no-history`, held open. The history goes to
`state/runtimes/<device>/requests-YYYY-MM.jsonl` and feeds [LLM & Diffusion](#llm--diffusion-ui-models).

- `GET /api/runtimes/endpoints` (`read`) → `{"endpoints":[…],"kinds","readPaths","historyReadPaths","limits":{"endpoints":40},"intervalSeconds"}`.
  `historyReadPaths` lists the two history reads. A llama-swap endpoint also has `history`:
  `{lastSyncAt, lastIngestedAt, recordsToday, stream: connected|connecting|reconnecting|off, lastError?}`.
  Each endpoint has the fields above plus `source`, `readOnly`, `hasToken` (never the token), `addedBy`/`addedAt` for
  stored ones, and its last read: `state` (`ok`, `stale`, `error`, `off` = nothing listens there, `waiting`),
  `detectedKind`, `lastAttemptAt`, `lastSuccessAt`, `lastError` (`refused`, `timeout`, `auth`, `http-<status>`,
  `not-json`, `too-large`, `unrecognised`, …), `lastErrorAt`.
- `POST /api/runtimes/endpoints` (`home:write`) `{"endpoint":{…}}` → `201` created or `200` →
  `{"ok","id","created","changed","by","endpoint"}`; the endpoint is read at once and the answer carries that read.
  The same `id` replaces the stored entry.
- `POST /api/runtimes/endpoints/remove` (`home:write`) `{"id"}` → `{"ok","id","removed":true}`; its token goes too.
- `POST /api/runtimes/endpoints/token` (password sign-in with write access; never an API key) `{"id","token"|null}` →
  `{"ok","id","hasToken"}`. The token (8–512 printable characters) is sent as `Authorization: Bearer …` to that
  endpoint only and kept in `private/runtime-tokens.json` (mode 0600; `RUNTIME_TOKENS_FILE` overrides the path).
- Errors: `400 RUNTIME_ENDPOINT_INVALID` (with `details` naming the field), `404 RUNTIME_ENDPOINT_NOT_FOUND`,
  `403 RUNTIME_ENDPOINT_READ_ONLY` (from `site.json`), `409 RUNTIME_ENDPOINT_CONFLICT` (the URL is another
  endpoint's), `409 RUNTIME_ENDPOINT_LIMIT`.
- MCP: `runtime_endpoints_list` (`read`), `runtime_endpoint_upsert` and `runtime_endpoint_remove` (`home:write`),
  with the same arguments. Tokens never go through MCP.
- The module declares the integration `runtimes.endpoints` (kind `llm-runtimes`): its status is `ok`, `stale`,
  `error`, `off`, `not-configured` or `disabled`, with one item per endpoint (docs/plugins.md → Integrations). A
  llama-swap item's summary says when its history last grew and how many records came in today. Off, nothing is
  read, the access-log streams close and no history is provided.

## Project Tracker (UI: #projects, #items, #releases)

A small tracker for your own development work, stored in `state/hub.db` ([storage.md](storage.md)).
Reading needs any sign-in (API keys: `read`); every write needs a write session or an API key with the
`tickets:write` scope. Writes return `400/404/409 TICKETS_FAILED` for invalid input, an unknown ticket, or a
stale `rev` / an existing release. HTTP POST bodies are limited to 16 KiB (UTF-8, including JSON);
tracker write arguments have the same size limit over MCP. Text-field character limits do not override this byte limit.
Send only changed fields when updating. Dates must be real calendar dates in `YYYY-MM-DD` form.

- **Projects** `{id, key, name, description, type, rev}`; none exist until you create one in the UI, with `POST /api/tickets/projects` or MCP `project_save` (a new, empty tracker also takes the seeds listed in site.json → `tracker.projects`, once). Ticket ids are `<KEY>-<n>`, e.g. `APP-12`.
- **Ticket** `{id, project, title, description, type: bug|feature|task, status: open|in-progress|done|cancelled, priority: low|normal|high|urgent, release: <version>|null, assignee|null, labels[], refs[], reporter, createdAt, updatedAt, closedAt|null, rev, comments[], history[]}`. `closedAt` is set on entering `done`/`cancelled` and cleared on reopening. `history` retains the latest 200 field changes (title/description only as "changed").
- **Release** `{project, version, status: planned|released, targetDate|null, releasedAt|null, notes, rev}`. A ticket's `release` must be an existing version of the same project. The literal `none` is reserved for filtering unassigned releases/assignees and cannot be used as a version or assignee name.

Routes:

- `GET /api/tickets?project=&status=open|in-progress|done|cancelled|active[,…]&type=&priority=&release=<version>|none&assignee=<name>|none&label=&q=&limit=` → `{updatedAt, projects, releases:[…, counts:{open,in-progress,done,cancelled}, total], total, tickets:[… without comments/history, comments:<count>], provenance}`. Release counts are over all tickets, not just the filtered ones. `provenance` ([Provenance](#provenance)) counts who created the listed tickets (people, service accounts, projects seeded from site.json) and who changed them later.
- `GET /api/tickets/<ID>` → the full ticket with `comments`, `history`, `rev` and `provenance` (its creator, then everyone who commented or changed it). The ticket writes below answer with the same shape.
- `GET /api/tickets/search?q=<words>&project=&status=&type=&priority=&release=&assignee=&label=&limit=1..100` (default 20) → `{q, total, tickets:[… as in the list, plus snippet, score]}`. Full-text search inside tickets (title, description, comments, attachment names, labels, refs, people) with the list's field filters; `q` follows the rules of [Search](#search) and needs at least one letter or digit. Best match first; `total` counts every match. `400` for a bad parameter.
- `GET /api/tickets/people` → `{people:[{name, kind: user|agent|other, assigned, active}]}`: the names the assignee field suggests. Sign-in accounts (`user`) and service accounts (`agent`) that are not disabled, then every name tickets already carry (`other`), the busiest assignee first. `assigned` counts tickets assigned to the name, `active` those still open or in progress. Names and counts only: no ids, roles or scopes.
- `POST /api/tickets` `{project, title, description?, type?, status?, priority?, release?, assignee?, labels?, refs?}` → `201` ticket. Defaults: `task`, `open`, `normal`.
- `POST /api/tickets/update` `{id, rev, …fields to change}` → ticket. `rev` must be the one you read; otherwise `409`.
- `POST /api/tickets/comment` `{id, text}` → ticket. Append-only, no `rev`.
- `POST /api/tickets/releases` `{project, version, status?, targetDate?, releasedAt?, notes?, rev?}` → release. Omit `rev` to create; pass it to change. `released` without a date stamps today.
- `POST /api/tickets/projects` `{id, key, name, description?}` → `201` new project; `{id, rev, name?, description?}` → `200` changed project. `id` and `key` never change.

MCP `tickets_list` uses `query` for text search and an integer `limit` of 1–200 (default 50); HTTP uses `q` and supports `limit` of 1–5000. `release_save` accepts `releasedAt` as well as `targetDate`. MCP `ticket_search` takes `query` plus the same filters as `GET /api/tickets/search` and returns the same document.

`message` in a tracker, review or search error is Czech source text for a browser session or an app token (the web UI translates it through its dictionary) and English for an API key.

Attachments (stored in `state/tickets/attachments/<sha256>`, at most 20 per ticket and 100 MB per file, 2 GB in total):

- `PUT /api/tickets/<ID>/attachments?name=<file name>` with the raw file as `application/octet-stream` → `201` ticket. `tickets:write` for API keys; sessions need the same origin. The file is streamed and, like every raw upload, has up to 20 minutes to arrive. A ticket that already has 20 files answers `409` before anything is stored. A name the ticket already has (in any case) is stored with `-2`, `-3`, … before its extension, so a name is one file: read the stored name in the answer.
- `GET /api/tickets/<ID>/attachments/<attachment id>[?download=1]` → the file. The type is decided from the bytes; the client's `Content-Type` is never used, and the file name only settles what the bytes leave open (whether a file is text, sound or picture in an Ogg, WebM, Matroska or MP4 container, a bare MP3 or AAC frame). PNG/JPEG/GIF/WebP, plain text, audio (MP3, WAV, FLAC, Ogg, AAC, M4A, WebM, Matroska) and video (MP4, QuickTime, WebM, Matroska, Ogg, AVI, 3GP) are served inline under that type, everything else (SVG and HTML included) is a download or plain text. One byte range per request (`Range: bytes=a-b`, `a-` or `-n`) → `206` with `Content-Range`, which is what a player seeks with; any other `Range` → `416`. Every response is `sandbox`ed and `nosniff`.
- `POST /api/tickets/attachments/delete` `{id, attachment}` → ticket. The file is removed when no ticket uses it any more.
- `GET /api/tickets/<ID>` lists `attachments: [{id, name, type, size, sha256, by, at}]`; the list view has `attachments: <count>`.
- In a `description` or a comment, `![name]` points at the ticket's attachment of that name (not `![alt](url)`, which stays text). The web UI shows it as a chip that opens the file; a name the ticket has no file for stays as written, and one whose file was removed is shown struck through. The API stores and returns the text as it is: read the file itself with the id from `attachments`.

MCP tools (service-account key): `projects_list`, `tickets_list`, `ticket_search`, `ticket_get`, `ticket_attachment_get` (`read`; images up to 5 MB come back as an image, text up to 256 kB as text); `ticket_create`, `ticket_update`, `ticket_comment`, `release_save`, `project_save`, `ticket_attachment_put` (`tickets:write`).

- `projects_list {}` returns `{projects:[...]}` with ids, keys, names, descriptions, types and revs, without loading tickets or releases. Use it for project discovery and revision checks; use `ticket_get` directly for a known ticket id. Reuse revs returned by successful creates/updates instead of fetching the same record again.
- `ticket_attachment_put {id, name, data}` accepts canonical padded base64 for 1–32,768 bytes. It detects the content type from the bytes and returns the full saved ticket. Identical file bytes already attached to that ticket return the existing record, even if the supplied name differs; retries also work after a name collision or when the ticket is full. New content still uses the ordinary 20-file limit. The MCP request limit remains 64 KiB; this tool never reads server-local paths or remote URLs.
- For local files up to 100 MiB, `node scripts/ticket-push.mjs APP-12 file [file ...]` streams the raw HTTP upload with `HOME_HUB_URL` (HTTPS origin; loopback HTTP for tests) and `HOME_HUB_TOKEN` (a service-account key with `tickets:write`) from the environment. It skips content already attached and checks the ticket after a lost response, without automatically replaying a write. Concurrent independent uploader processes can still attach the same file twice through the raw HTTP endpoint. Names come from the saved metadata. Credentials are never printed and redirects are refused.
- Creation and comments are not idempotent: after an uncertain response, read/search before retrying. An unexpected ticket error does not promise that a prior write failed.

`node scripts/benchmark-tickets.mjs [ticket-count] [samples]` reports median and p95 store-operation times using a temporary synthetic tracker (default 1,000 tickets, 30 samples; at most 5,000 tickets). It does not contact a server or use credentials; it removes its temporary data afterwards. These timings exclude authentication, network and agent/tool-discovery latency.

The web UI (`#projects`, `#projects/<id>`, `#items`, `#items/<ID>`, `#releases`) is in the reader's language (English unless the site sets `defaultLanguage`), with dates in the site's time zone. An empty tracker shows how to start: create a project, or copy the prompt for a coding agent (`project_save`, then `ticket_create`, scope `tickets:write`) with the MCP connection snippet. Keys on the lists: `/` filter, `n` new item, `j` / `k` move, `Enter` open, `v` table or board; on an item `c` focuses the comment box. A new item takes files while it is written (button, drop, or paste with Cmd/Ctrl+V; a paste into the description leaves the file's chip at the caret) and uploads them once the item exists; an item's page lists its files under the description as tiles and opens one in a viewer (picture, audio or video player, text; anything else is a download).

An agent that should file tickets needs `tickets:write`: a custom selection, the Editor preset or full access (see Access → service accounts).

Projects carry `type`: `app`, `game`, `other` or `null` (`POST /api/tickets/projects` and MCP `project_save` accept it).


### Hybrid ticket search

`GET /api/tickets/search/hybrid?query=words&mode=hybrid` and MCP `ticket_hybrid_search`
require normal `read` access. Existing ticket search is unchanged. Required `query` is 1–200
characters with a letter or digit. Optional `project`, `status`, `type`, `priority`, `release`,
`assignee`, `label` use ticket-list filters; `limit` is 1–100 (default 20). `mode` is `text` (default),
`hybrid`, or `semantic`; `minScore` is a finite cosine threshold from 0 to 1.
Unknown fields are refused. Results cite ticket/project, source, attachment id/name/type when
applicable, snippets and match kind. Semantic scores and fused ranking scores differ.

`GET /api/tickets/search/status` and MCP `ticket_search_status` take no arguments. They expose
readiness, embedding progress and extraction coverage: indexed, unsupported, oversized,
invalid UTF-8 and missing files. A stale canonical revision returns `state: indexing` with
no hits until background extraction catches up. Semantic-only never silently becomes text.
Attachment metadata is indexed ahead of body contents. Text content is supported only for `text/plain`,
strictly decoded in full without NULs, up to 256 KiB, with overlapping Unicode-safe chunks.
No OCR, archives, arbitrary paths or URL fetching is supported.

Accepted file content is indexed completely or omitted with an explicit coverage reason; capacity
limits never silently truncate it. Capacity omissions report degraded coverage while retaining
usable ticket/metadata search. The default derived-index ceiling is 200,000 chunks; the semantic
cache holds up to 20,000 distinct content vectors. Changes update only affected ticket documents
and reuse extraction by immutable SHA-256. Bounded failures retry with backoff and a recovery
cooldown. Concurrent identical questions share their embedding request.

Text mode uses all-word prefix matching; hybrid mode also admits semantic matches above the
configured cosine floor and fuses their ranks. An unrelated common word alone cannot make a
long question a lexical match. Hybrid search explicitly reports its actual mode and semantic
readiness when embeddings are unavailable or warming; semantic-only never downgrades.
See [optional provider configuration](configuration.md).

### Project wiki

The project toolbar opens the wiki at `#wiki/<project>`. The Project Tracker navigation lists projects with a wiki.
Tracker readers can open pages and backlinks.
Writes use `tickets:write`. Home has `parentId:null`. The tree uses stable page IDs of `w` and 11 lowercase
base32 characters and returns parents before their alphabetically ordered children. A project can have
500 pages including Home. Titles are trimmed and contain 1–120 characters.

| Request | Response |
|---|---|
| `GET /api/wiki` | `{projects:[{id, name, home}]}` for projects with a wiki |
| `GET /api/wiki/<project>` | `{enabled:false}` or `{enabled:true, home, pages:[{id, project, parentId, title, rev, updatedAt, updatedBy, links}]}` |
| `POST /api/wiki/setup` with `{project}` | `201 {created:true, home}` on setup and `200 {created:false, home}` on repeat |
| `GET /api/wiki/<project>/pages/<id>` | Page including its document, asset metadata and provenance |
| `POST /api/wiki/pages` with `{project, title, parentId?, doc?, requestId?}` | `201` page. Omit `parentId` for Home or `doc` for an empty page |
| `POST /api/wiki/pages/update` with `{project, id, rev, title?, doc?, documentUploadId?}` | `200` page. Supply a title, a document, or both. Use either inline `doc` or a finished staged document |
| `POST /api/wiki/pages/move` with `{project, id, rev, parentId}` | `200` page. The new parent must be in the same wiki and outside the page's subtree |
| `POST /api/wiki/attachments/add` with `{project, id, rev, assetId, requestId, label?, caption?, position?, groupId?}` | `200` page. For a cell use `tableId, rowId, columnId` instead of `groupId`. Position is zero-based and defaults to append |
| `GET /api/wiki/tickets/<ID>/backlinks` | `{pages:[{project, id, title, updatedAt}]}` derived from saved content |
| `POST /api/wiki/preview` with `{source}` | `200 {token}` for a draft HTML preview. The token expires in 10 minutes and is bound to its author |
| `GET /api/wiki/frame/<project>/<id>/<block>` | Sandboxed static HTML block |
| `GET /api/wiki/frame/preview/<token>` | Sandboxed static HTML preview |

A page contains `{id, project, parentId, title, doc, links, assets, rev, createdAt, createdBy, updatedAt,
updatedBy, history, provenance}`. The server derives `links:{tickets:[…]}` and retains up to 50 entries
in `history`. Page content, asset references and ticket backlinks change in the same transaction.
A stale revision responds `409` with `error.reason:"conflict"` and `current:{rev, updatedAt, updatedBy}`.
Reusing a request ID with the same arguments returns the original page ID and revision with
`replayed:true`. The receipt also carries the original page title, parent and summary on HTTP.
Request IDs are 1–100 letters, digits, dots, underscores, hyphens or colons, scoped to a principal,
project and operation. Different arguments with an existing request ID return `409`.
JSON write bodies may be up to 512 KiB.

#### Wiki assets and imports

| Request | Response |
|---|---|
| `POST /api/wiki/uploads` with `{project, name, size, digest, type?, purpose?}` | `201` upload session with `uploadId, nextOffset, expiresAt, chunkSize, rawChunkSize, project, size` |
| `GET /api/wiki/uploads/<uploadId>` | Upload state for the same principal, including the next offset |
| `PUT /api/wiki/uploads/<uploadId>?offset=<bytes>` | `200` upload state. Send up to 8 MiB of bytes as `application/octet-stream` |
| `POST /api/wiki/uploads/finish` with `{uploadId}` | `200` upload state and `{assetId, asset}`, or `documentUploadId` for a staged document |
| `GET /api/wiki/<project>/assets` | `{assets:[…]}`, including published attachments and the writer's private assets |
| `GET\|HEAD /api/wiki/<project>/assets/<assetId>` | Authorized bytes with single-range support. Pass `?download=1` to request download disposition, `?thumbnail=1` for a bounded image preview, or `?preview=webm` for a compatible MP4 playback copy |
| `GET /api/wiki/<project>/sources` | With `tickets:write`, authorized repository and Review choices and the destination audience |
| `POST /api/wiki/assets/import` with `{project, source}` | `201` upload result with a verified, pinned asset and source provenance |
| `POST /api/admin/wiki/sources` | Authorize or revoke a source for a destination project. Requires an administrator's password session |

Use a filename without path separators, a byte count and a lowercase hexadecimal SHA-256 digest.
Size and digest are verified before finish, along with the signatures of supported preview formats.
The server returns the next offset on `409` when a chunk does not match. Resend the same bytes at their
original offset to retry a chunk. Repeating finish returns the same asset. Sessions expire after 24 hours
and return `410` after expiry. One asset can be up to 256 MiB, or up to 128 MiB for a GLB. Draft uploads and
finished assets without a saved reference are private to their author. Unreferenced assets are retained for
seven days. A limit returns an actionable `error.reason`, such as `too-large`, `disk-limit` or `asset-limit`.
Use `purpose:"document"` for staged UTF-8 JSON up to 256 KiB. A finished document upload can be used by
its owner for a save in the same project before the session expires.

The asset metadata has `{id, project, name, type, size, digest, url, source?}`. Images, audio, video and
supported GLB models can preview. Generic files use download disposition. A digest cannot be used as an
asset ID. Readers can access assets referenced by a saved page in that project. Media URLs require
authorization on every request, including ranges and HEAD. The thumbnail variant returns a still PNG of
up to 384 pixels per side, uses the same authorization, and ignores Range. It returns `404` when a
thumbnail is unavailable. See [thumbnail configuration](wiki.md#inventory-and-media).

Import `source` is one of these objects:

- Git LFS `{kind:"lfs", connection, repo, ref, path}`. The destination needs a grant for that connection
  and repository. The pinned source records `{kind, connection, repo, commit, path, oid}`.
- Review `{kind:"review", set, round, item, variant, media?}`. The zero-based `media` index defaults to
  zero. Readers with destination write permission may copy from a Review set in the same project.
  A set from another project also needs a destination grant. The source records the set's project and
  selected round, item, variant, media index and digest.

A repository grant is `{project, kind:"lfs", connection, repo, enabled, downloadOrigin?}`.
A grant binds to the configured Git host and provider. When the LFS batch action uses a different origin,
approve that exact HTTPS origin as `downloadOrigin`. The server uses the
[Git LFS Batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md).
A Review grant is `{project, kind:"review", set, enabled}`.
The grant response includes `audience:"project-readers"`. Revocation stops future imports. Existing pinned
copies stay available according to their saved wiki references. See [the wiki guide](wiki.md#source-imports).

#### MCP wiki authoring

MCP uses the same validation and transactions as HTTP. `wiki_list`, `wiki_get` and `wiki_assets_list` require
`read`. Source discovery and mutations require `tickets:write`. Page mutations return `pageId`, `parentId`,
`rev` and a page `url`. Errors include
`structuredContent.error` for store validation, with `current` on a stale save and `nextOffset` when available.

| Tool | Arguments and result |
|---|---|
| `wiki_list` | `{project}` reads the tree |
| `wiki_get` | `{project, pageId?, mode?, tableId?, rowIds?, columnIds?, offset?, limit?}`. Omit `pageId` for Home. Default `mode:"full"` preserves the complete response |
| `wiki_setup` | `{project}` enables the wiki idempotently and returns Home |
| `wiki_page_create` | `{project, parentId?, title, doc?, requestId}` |
| `wiki_page_move` | `{project, pageId, rev, parentId}` |
| `wiki_page_save` | `{project, pageId, rev, title?, doc?, documentUploadId?, patch?}`. Use one of `doc`, `documentUploadId` or `patch` to edit content |
| `wiki_upload_manifest` | `{project, files:[{name, size, digest, type?, archiveMember?}]}` plans or recovers up to 50 asset uploads |
| `wiki_upload_begin` | `{project, name, size, digest, type?, purpose?}` returns a private expiring session |
| `wiki_upload_status` | `{uploadId}` returns the current offset and expiry |
| `wiki_upload_chunk` | `{uploadId, offset, data}`, where `data` is canonical padded base64 for at most 32 KiB of bytes |
| `wiki_upload_finish` | `{uploadId}` verifies the upload and returns an asset ID or a document upload ID |
| `wiki_sources_list` | `{project, kind?, connection?, repo?, set?, round?, item?, variant?, query?, offset?, limit?}` pages through approved sources or files within an approved source |
| `wiki_assets_list` | `{project, query?, digest?, type?, sourceKind?, minSize?, maxSize?, offset?, limit?}` pages through accessible project asset metadata |
| `wiki_asset_import` | `{project, source}` returns an asset ID, URL and resolved provenance. Review imports also return a context snapshot and caption suggestion |
| `wiki_attachment_add` | `{project, pageId, rev, assetId, requestId, groupId?, tableId?, rowId?, columnId?, displayAssetId?, initialClip?, label?, caption?, position?}` |

In `wiki_get`, `summary` returns block, ticket and asset counts and the IDs and sizes of inventory
tables and attachment groups. `inventory` requires `tableId` and returns column definitions and rows in
page order. Optionally select existing `rowIds` or `columnIds`. It defaults to 10 rows, allows up to 20
and returns up to 48 KiB of serialized rows per call. Narrow the column selection if a single row exceeds
the limit. `assets` pages through the distinct referenced assets in document order, including display assets.
Both modes return `total`, `offset`, `limit` and `nextOffset` (null on the last page). For a consistent
multi-call read, check that each result reports the same page `rev`. Selective responses include only
the requested material in `structuredContent` and as compact JSON for text-only MCP clients.

To update an existing row, supply `patch:{tableId,rowId,cells:{[columnId]:cell|null}}` and the page revision.
A cell uses the regular inventory cell shape and replaces the saved cell. Null removes the cell. Unspecified
columns are left alone. A single column applies a one-cell patch. The successful result includes the new
revision and the normalized patch, including nulls for removed cells. A stale revision returns `current`
even when another editor changed a different cell.

Manifest results correspond to the input order. Each reports `name`, `digest` and `state`. An `uploaded`
entry includes `assetId` for a matching asset with the same digest, size and media type. Matches include
assets referenced by a saved page in the project and the caller's private assets. `resumable` and `new`
entries include the caller's `uploadId`, `nextOffset` and expiry. An existing session stays resumable
if another author publishes matching bytes while the transfer is in progress. `deferred` includes a capacity reason.
Finish completed transfers before resubmitting deferred entries. Retrying the same manifest recovers current
state even after a lost response. Concurrent transfers share the existing limit of 16 reserved upload sessions
per principal and 128 overall. Active asset sessions count against the project asset limit when allocating
new manifest sessions. Each plan advertises the raw HTTP and MCP chunk routes and their byte limits.
Asset manifests accept `archiveMember` for uploads extracted on the author's computer. See the
[versioned archive workflow](wiki.md#versioned-git-lfs-archives).

Source discovery returns `audience:"project-readers"` with `items`, `total`, `offset`, `limit` and
`nextOffset`. It defaults to 10 entries (maximum 20). Select a Git repository with `connection` and `repo`
to verify repository access and get its browse URL, catalog state, scan time, default ref and recent cached
LFS refs, paths and commits. Before selection, configured Git entries represent stored grants.
Refs and paths are browse hints. Import resolves the chosen ref and exact path again and pins the resulting
commit and digest. Select a Review `set` to get its rounds, and pass `round` to select media with usable
`source` arguments, decisions, sizes, MIME types and digests. Use `item` and optional `variant` to narrow
the selection. Explicit discovery requests for an unapproved source return `source-not-granted`. An approved connection
or set that is inaccessible returns `source-unavailable`.

Asset discovery matches `query` against the name, ID, digest or source path. `digest` and `type` are exact
filters and size limits are inclusive. `sourceKind` accepts `lfs`, `review` and `lfs-member`. Results include
`assets` and the same pagination fields, default to 20 and allow up to 100. The caller needs destination
write permission to see their own unreferenced assets.

The MCP HTTP request limit remains 64 KiB. For a larger document, create the page first, upload the
UTF-8 JSON with `purpose:"document"`, then save with `documentUploadId` and the expected page revision.
Binary uploads accept file bytes only. See [document format and an example](wiki.md#document-format).

### Review

Variants agents propose for a project (HTML mockups, images, 3D models as `.glb`, clips as `.mp4`/`.webm`, audio tracks), decided in `#review`. The full contract is in
[review.md](review.md). Writes need `review:write` for API keys.

- `GET /api/review?project=&ticket=ID|unlinked&status=open|active|done|archived|all&feedback=pending` → `{sets:[summary], provenance}`.
- `GET /api/review/sets/<R-n>` → the full set with all rounds, decisions, comments and `provenance`. Publishing a round counts as the record (`unit: rounds`), a decision or comment as a change ([Provenance](#provenance)).
- `HEAD|GET /api/review/blobs/<sha256>` → a published file (range requests); `GET /api/review/frame/<sha256>` → a sandboxed HTML mockup.
- `PUT /api/review/blobs/<sha256>?offset=&size=` (`application/octet-stream`, ≤ 8 MiB per chunk) → `{received,size,complete}`; `409` with `received` on a wrong offset.
- `POST /api/review/publish` (≤ 64 kB) → `201` new set or `200` next round; `POST /api/review/feedback` (≤ 64 kB) `{set, round, item, rev, variant, status, note?, comments?, attachments?, editComments?:[{id, text}], deleteComments?:[id]}` (edit or delete your own saved comments; someone else's → `403`); `POST /api/review/sets` `{id, rev, status?, title?, tickets?}`. Ticket links replace the existing array (at most 20 input entries, duplicates normalized); omitted preserves, `[]` clears. New links must exist in the same project; stale rev → `409`. No round or feedback timestamp changes. Validation is not a cross-store transaction.
- MCP: `review_list`, `review_get` (`read`); `review_publish`, `review_set_save` (`review:write`; same metadata fields as HTTP). `review_get` adds the set `rev`. Publication adds `warnings` for deprecated unlinked creation while preserving omitted/empty tickets and existing sets. Upload files with `scripts/review-push.mjs`.
- The page compares alternatives side by side, one at a time or with explicitly aligned, dimension/timing-checked swipe. Independent approval deliverables use local playback; explicit aligned approval against a reference remains comparable. The first visible variant is audible after the user starts playback; hidden media pauses and playback errors offer retry. The page counts the round's
  decisions and shows comments as threads with the round that answered them. With no set on the hub it explains
  the two ways to publish and offers a prompt for a coding agent. Details: [review.md](review.md#the-page-review).

### Search

Full-text search over tickets (id, title, description, comments, labels, refs, people) and review sets (title,
description, round notes, item and variant texts, notes, comments). `read` is enough for API keys.

- `GET /api/search?q=<words>&kind=ticket|review&project=<id>&limit=1..100` (default 20) →
  `{q,total,results:[{kind,id,project,updatedAt,title,snippet,score,meta}],indexed:{ticket,review}}`, best match first.
- `meta` says what a hit is right now, so a result list needs no second request: for a ticket
  `{status,type,priority,assignee,release}`, for a review set `{status,done,feedbackPending,round,items,decided}`.
- `indexed` counts the documents the index holds per kind. All zeros means there is nothing to search yet (an
  empty hub), which is not the same as a query without matches. An empty `q` returns no results, only `indexed`.
- A query that is exactly an id (`APP-12`, `R-3`, any case) puts that record first.
- `q` is plain words (≤ 200 characters, at most 12 words), never query syntax: every word must match, as a prefix,
  ignoring case and diacritics (`prihlas` finds `Přihlášení`). A title hit ranks above a body hit.
- In `title` and `snippet` the matched words are wrapped in `\u0001` … `\u0002`; render them as text (e.g. `<mark>`
  via text nodes), never as HTML. Results link to `#items/<id>` or `#review/<id>`.
- `400 SEARCH_FAILED` for a bad parameter (unknown key, `kind`, `project`, `limit`).
- MCP: `search` (`read`) is the same search without `meta` and `indexed`; `ticket_search` (`read`) narrows tickets by fields.
- In the web UI `/` focuses the search box from anywhere; `#search/<words>` groups the hits by kind, `j` / `k` or the
  arrow keys walk them and `Enter` opens one. Without a query, with no matches and on an empty hub the page explains how search reads a query.

## Collectors: versions, host protection, SSH keys, software watch, router

These screens show snapshots that read-only collectors write into the data directory. Nothing here makes the hub contact another computer: a request only reads files. `docs/plugins.md` says how a device gets an `ssh` entry; `examples/systemd/` and `scripts/systems/install-launchd.sh` schedule the collectors.

| Collector | Writes | Every | Read by |
|---|---|---|---|
| `node scripts/collect-systems.mjs` | `data/systems/snapshot.json`, `history.jsonl` | 6 h | `GET /api/systems` |
| `node scripts/check-upstream.mjs` | `data/systems/upstream.json` | 12 h | `GET /api/systems` |
| `node scripts/collect-security.mjs` | `data/security/ssh-keys.json`, `probes.json` | 24 h | `GET /api/security` |
| `python3 scripts/collect-router-unifi.py` | `data/router-observations.json` (`schemaVersion: 2`: `clients`, `hardware`; a legacy file with `devices`, `unifiDevices` is still read) | 1 min | `GET /api/router`, `GET /api/home` |

### Collector state

`GET /api/systems` and `GET /api/security` carry `collector` in every answer, with a snapshot (`200`) or without one (`404 SYSTEMS_MISSING` / `404 SECURITY_MISSING`, where it sits next to `error`):

```json
{"state": "ok", "configured": true, "collectedAt": "2026-11-08T12:00:00.000Z", "ageSeconds": 3600,
 "intervalSeconds": 21600, "staleAfterSeconds": 27000, "script": "scripts/collect-systems.mjs"}
```

| `state` | Meaning |
|---|---|
| `not-configured` | No device in the site configuration has an `ssh` entry the collector could use. `devices` is `[]` |
| `waiting` | Devices are configured (`devices` lists them) but no snapshot has been written yet |
| `stale` | The snapshot is older than `staleAfterSeconds` (the interval plus a quarter): the scheduled job did not run when it should have |
| `ok` | A snapshot of the expected age |

On `/api/systems` the object also has `upstream` (the same fields for the release check, 12 h) and `watch: {"source": "local" | "none", "items": n}`.
`collector` is always the collector's own state, also when push agents report: on `/api/systems` it then also has
`agents: {"devices", "fresh", "noNews"}` (devices with an agent record, and how many of them are fresh), and the
state of the SSH key collector on `/api/security` comes from `collectorCollectedAt` (below), not from the newest time.

`GET /api/collectors` (admins, or a role or key with `security:read`) gives the states alone and always answers
`200`, also on a hub where nothing has been collected:

```json
{"schemaVersion": 1, "generatedAt": "2026-11-08T12:00:00.000Z", "collectors": {
  "systems": {"state": "waiting", "configured": true, "collectedAt": null, "ageSeconds": null, "intervalSeconds": 21600, "staleAfterSeconds": 27000, "script": "scripts/collect-systems.mjs"},
  "security": {"state": "ok", "configured": true, "collectedAt": "2026-11-08T03:00:00.000Z", "ageSeconds": 32400, "intervalSeconds": 86400, "staleAfterSeconds": 108000, "script": "scripts/collect-security.mjs"},
  "router": {"state": "not-configured", "collectedAt": null}}}
```

`upstream` is present once a device snapshot exists. `router.state` is the status of `GET /api/router`.
Use this route to ask "has anything arrived?" (the getting-started checklist does): the data routes are a
`404` until a collector has run, and a browser logs every one of those.

### `GET /api/systems` and `GET /api/security` (admins, or API keys with `security:read`)

- `/api/systems` → `{"schemaVersion":2,"generatedAt","collectedAt","oldestCollectedAt","collectedFrom","upstreamCheckedAt","upstreamFailed","categories","devices":[…],"software":[…],"collector","provenance"}` (sources `systems`, `upstream`, `watch`, and `agents` (kind `telemetry`) when push agents report; the protection page shows `systems` alone). A device: `id`, `name`, `kind` (the reader kind: `mac` | `nas` from `site.json → ssh.probe`, `mac` | `linux` | `windows` from a push agent's platform), `reachable`, `stale` (the last probe failed and this is its previous record; for an agent's record: no news), `error`, `collectedAt`, `hw`, `uptimeSeconds`, `os` (`name`, `version`, `status`, `updates[]`), `checks[]`, `listening[]`, `brewOutdated[]`, `summary`. A check: `{"id","label","state","value","detail"}` with `state` one of `ok`, `warn`, `crit`, `info`, `unknown`. A software row: `id`, `name`, `category`, `device`, `installed`, `path`, `source` (`label`, `url`), `latest`, `latestUrl` (the release page, when the source has one), `publishedAt`, `status` (`update`, `current`, `ahead`, `unknown`, `missing`, `n/a`, `floating`), `note`, `running`, `stale`, `upstreamStale`, `upstreamError`, `upstreamCheckedAt`, `upstreamFailedAt`, `inventory` (inventory entry ids this row describes).
- `/api/security` → `{"schemaVersion":2,"collectedAt","collectedFrom","devices":[…],"keys":[…],"otherKeys":[…],"unknownAuthorized":[…],"forgejo","findings":[…],"collector","provenance"}`. A key: `fingerprint`, `type`, `bits`, `name`, `comment`, `copies[]` (`device`, `owner`, `path`, `mode`, `mtime`, `encrypted`, `backup`), `access[]` (what it opens), `routes[]`. Private key material is never collected: fingerprints, paths and public `authorized_keys` lines only.
- **Push agents** (docs/agent.md §3 → Who wins over the collectors). Without any agent report both answers are the
  collectors' alone, unchanged. When agents report, each device is read from one record, the collector's or the
  agent's: a record that is not current loses to one that is (the collector's when complete, not marked `stale` and
  younger than its stale-after, 7.5 h for systems and 30 h for SSH keys; the agent's while its part is fresh,
  `receivedAt` + 3 × interval); when both are current the agent's wins only if it covers at least what the
  collector's does (systems: a collector record probed as root covers every privileged read, the agent's the reads
  its `PRIV` lines report `ok` and whose records it carries; SSH keys: `HOST` root, as the agent's `HOST` line states
  it); otherwise the newer wins, a tie to the agent. The agent's time is the hub's receive time; the collector's is
  the earlier of the record's `probedAt` and the file's modification time on the hub (a record from before `probedAt`:
  the earlier of the file's `collectedAt` and its own `HOST` time; a placeholder for a device the collector never
  reached has none and loses). Every time shown for an agent's record is the hub's receive time: the device's own
  clock is kept as information only.
  - `/api/systems`: the devices are the site's `ssh.probe` devices and every device with an agent `os` part; the NAS
    stays agent-less. A device with an agent record carries `source` (`collector` | `agent`) and `sourceAt` (that
    record's time); when the agent's won, also `deviceCollectedAt` (the `HOST` time on the device's clock) and
    `withheld` (`[{part, tag, field, reason, count}]`, lines the agent left out). `collectedAt` (top level) is the
    newest of the snapshot's and the agents' receive times; the answer is `404 SYSTEMS_MISSING` only when there is
    neither a snapshot nor an agent `os` part. Reader kind `linux`: `os` adds `base`, `securityUpdates`, `channel`
    (`apt` | `dnf`), `cacheAgeSeconds` and `error`, `os.updates[]` are packages `{title, version, installed, security,
    kind: "package"}`, and the checks are `firewall` (nftables), `ssh-password`, `ssh-root` (only when `sshd -T` gave
    `PermitRootLogin`), `security-updates`, `os-update`, `auto-updates` and `exposed`. Reader kind `windows`: `os` adds
    `error`, `os.updates[]` are `{title, version, kb, severity, restart, kind: "update"}`, and the checks are `defender`, `bitlocker`, `firewall`, `rdp`, `os-update` and
    `exposed`. A check whose read was denied (`PRIV <id> denied`) is `unknown` and says which read needs sudo.
  - `/api/security`: when an agent has an `sshkeys` part, the inventory is rebuilt from `probes.json` (written by
    `collect-security.mjs` beside `ssh-keys.json`) with each device's winning record; Forgejo and the router entry stay
    the collector's. A device with an agent `sshkeys` part then carries `source`, `sourceAt` and, for an agent's
    record, `deviceCollectedAt` and `stale` (`true` once the part is no news) (other devices are as they were); a key's `copies[]`, `access[]` and `routes[]`
    entries that an agent's record added carry `source: "agent"`;
    `collectedAt` is the newest of the collector's and the agents' receive times, `collectorCollectedAt` the
    collector's alone, and `agents: {"joined": true, "devices", "fresh", "noNews"}`. When `probes.json` is missing,
    unreadable or from another run than `ssh-keys.json` (an older collector wrote only the inventory), the answer is
    `ssh-keys.json` as it was plus `agents: {"joined": false, "reason": "probes-missing" | "probes-unreadable" |
    "probes-outdated", …}`. An agent's `HOST` name and `NET` addresses never decide which device another device's
    route reaches; its addresses come from the site or the device descriptors only.
  - `GET /api/models` → `providers.runtimes` and the MCP tool `models_overview` list the core module `agent` as one more
    `home.runtimes` provider (`{"module": "agent", "source": "agent", "devices": 0, …}` while no agent reports
    runtimes). This is the one answer that changes on a hub without agent reports.
- **Text in two forms.** Labels, values, details, notes and finding titles are Czech sentences (the UI's source language). A sentence built from data also comes as parts, in a sibling field ending in `T`, so a client can show it in another language: `"value": "zapnutý · 12 pravidel", "valueT": [{"key": "zapnutý · {rules} pravidel", "params": {"rules": 12}}]`. The fields are `valueT`, `detailT` (checks), `noteT`, `source.labelT` (software rows) and `titleT`, `detailT` (findings). Translate each `key` (English is in `public/i18n-en-*.js`), fill the parameters, join the parts with a space; a parameter that is a list holds labels to translate one by one. A snapshot written before the parts existed has only the text.

### Software watch list

Which programs the versions page follows. A site keeps its own list in `local/software-watch.json`, next to its `site.json` (`SOFTWARE_WATCH_FILE` selects another file; a hub started without a site overlay has no list and answers a write with `409 SOFTWARE_WATCH_UNAVAILABLE`); `config/software-watch.json` is an annotated example and never the active list. Without a list only operating systems, NAS apps and containers are shown, which the probes discover by themselves.

Both routes need the `software:write` scope with an API key (old read/write keys never hold it), or an administrator's session in the browser.

- `GET /api/software-watch` → `{"schemaVersion":1,"source":"local"|"none","file","writable","example","categories":{id:label},"items":[{…item,"hash"}],"devices":[{"id","name"}],"detectKinds","upstreamTypes","cmdArgs","schemes","limits","provenance"}` (`config`, naming the file, while a list exists). `devices` are the device ids a detect rule may name (the ones probed with `"probe": "mac"`).
- `POST /api/software-watch` applies one change and saves the file atomically:

| Body | Does |
|---|---|
| `{"item": {…}}` | Adds an item. `201` with `{"ok":true,"id","created":true,"hash","items","categories"}` |
| `{"item": {…}, "base": "<hash>"}` | Replaces the item with that id. `base` is its `hash` from the list |
| `{"remove": "<id>", "base": "<hash>"}` | Deletes it |
| `{"categories": {"id": "Label"}}` | Adds or renames categories; may be combined with `item` |

Errors: `422 SOFTWARE_WATCH_INVALID` (`error.details` lists every reason), `409 SOFTWARE_WATCH_CONFLICT` (the item changed since it was read, already exists, or `base` is missing), `404 SOFTWARE_WATCH_NOT_FOUND`, `409 SOFTWARE_WATCH_LIMIT` (200 items, 20 categories, 256 kB). A refused change writes nothing.

An item:

```json
{"id": "node", "name": "Node.js", "category": "infra", "scheme": "node",
 "upstream": {"type": "node"},
 "detect": {"mini": {"kind": "brew", "formula": "node"},
            "server": {"kind": "cmd", "path": "~/.local/bin/node", "args": "--version",
                       "launchd": "com.example.node", "source": {"label": "nodejs.org binary", "url": "https://nodejs.org/en/download"}}}}
```

| Field | Values |
|---|---|
| `id`, `name`, `category` | `id`: 1–40 of `a-z 0-9 . _ -`. `category`: an existing category id (`nas-apps` and `containers` are reserved) |
| `scheme` | Optional: `node` (LTS lines) or `llamacpp` (build numbers before semver) |
| `upstream` | `github` / `codeberg` `{repo, tagPrefix?, tagPattern?, allowPrerelease?}`, `pypi` `{package}`, `npm` `{package, tag?}`, `brew-formula` / `brew-cask` `{name}`, `node`, `none` `{note?}`. A `thermo-feed` upstream names a URL the checker fetches, so it is set in the file only; the API keeps an existing one unchanged |
| `detect.<device>` | `brew` `{formula}` (up to 4 names, comma-separated), `cask` `{cask}`, `app` `{path}` ending in `.app`, `cmd` `{path, args, match?}`, `pydist` `{glob, package}`, `json` `{path, key?}`, `winreg` `{displayName}` (the Windows push agent: the system-wide uninstall entries whose `DisplayName` matches, `*` for any run of characters, at most four; letters, digits, space and `. _ + , -` otherwise); plus optional `launchd` (a systemd unit for a Linux agent, a service name for a Windows one), `upstream` (override for this device), `source {label, url}`, `inventory [ids]` |

**A detect rule is data, never shell.** Paths are absolute or start with `~/`, contain no `..` and none of the characters a shell acts on; `*` and `?` are allowed in `cmd.path` and `pydist.glob` only. `cmd.args` is one of `--version`, `-version`, `-v`, `-V`, `version`: the probe runs the binary only to print its version, as the SSH user, never as root. Regular expressions (`match`, `tagPattern`) are at most 200 characters without nested quantifiers. The collector applies the argument rule again when it builds the probe input, so a hand-edited rule with other arguments is not run either (its row reads "unverified" with the reason).

### `GET /api/router` (any signed-in account)

The client census and the router's health from the router adapter (`docs/plugins.md` → router adapter).

→ `{"schemaVersion":2,"generatedAt","state","status","adapter":{"id","title"}|null,"freshness","staleAfterSeconds","observedAt","attemptedAt","error","model","firmware","routerMac","clients":[{"mac","id","ip","name","connection","presence"}],"health":{"status","softwareVersion","hardware":[{"name","model","state","firmware","ip"}],"hardwareDown","clientCounts":{"connected","wired","wireless","other","known"}}|null,"configured":{"adapter","host","lanCidrs"},"siteDevice":{"id","name","ip"}|null,"provenance"}` (`collector` for the included adapter, `plugin` for one a plugin provides)

| `state` | Meaning |
|---|---|
| `not-configured` | No adapter: nothing in `site.json → router`, no plugin adapter, no observation file |
| `waiting` | An adapter is configured but has not reported yet (`error: "unknown-adapter"` when `site.json` names one nothing provides) |
| `unavailable` | The adapter's last attempt failed (`error`); `clients` is the last census it had, never an empty list presented as "no clients" |
| `stale` | The last observation is older than `staleAfterSeconds` (180 for the included adapter) |
| `ok` | A fresh observation |

`clients` are the network clients the router saw (not the household's devices); `health.hardware` is the router's own network gear (gateway, switches, access points), and `health.clientCounts` counts the clients (`known`: seen in the last 90 days, `null` when the adapter does not say). Legacy snapshots used `devices` for the list and `health.clients` for the counts (`schemaVersion: 1`); core reads those fields forward. `status` (`ok`, `unavailable`, `not-configured`) and `freshness` are the fields `GET /api/home → router` has always carried. `presence` is what was seen: `associated` (on Wi-Fi), `reachable`, `lease-only` (a DHCP lease is not proof of connectivity) or `cache-only`. Only clients with a host address inside `lanCidrs` are listed.

### MCP tools

| Tool | Scope | |
|---|---|---|
| `software_watch_list` | `software:write` | The list as `GET /api/software-watch` returns it |
| `software_watch_put` | `software:write` | `{item, base?}`, `{remove, base}` or `{categories}`, with the same validation; a refusal comes back as a tool error that lists the reasons |

## Inventory map and services catalog (UI: #inventory-map, #inventory-map/table, #inventory-map/services)

One file, `data/knowledge.json`, is the source of truth for devices, services, tools, model stores, outside services, what depends on what and **where** each credential is kept (never its value). The map, the table and the services view are views of one page (`#services` still opens the services view); a hub without the file is an empty inventory and the first write creates it. Every write, by a person or an agent, goes through the same checker (`public/inventory-rules.js`, also `node scripts/check-knowledge.mjs`): a write that would leave the file invalid is refused and nothing changes.

**Concurrency.** Optimistic, per entry. Every entry has a hash (sha256 of the entry as stored; `GET /api/inventory` → `hashes`). To change or delete an entry send the hash you read as `base`; if the entry changed in between you get `409`: read again and reapply. Omit `base` only to create. An entry nobody touched keeps its hash across writes to other entries.

| Route | Who | |
|---|---|---|
| `GET /api/inventory` | read | `{"doc","gaps","hashes","provenance"}`: the checked document, the gaps (facts not recorded: a secret whose store is `unknown`, a runtime without an address) and one hash per entry id; `provenance` counts the entries by their `verified_by` stamp ([Provenance](#provenance)). `404 INVENTORY_MISSING` while there is no file; `500 INVENTORY_INVALID` when the file fails the checker |
| `GET /api/inventory/export` | read | The file as a download (`home-inventory-<date>.json`): `{schema: 2, updated_at, entries}`. The import on the inventory page also takes a file exported by a legacy build (`schema: 1`) and reads it forward |
| `GET /api/inventory/schema` | read | How to fill it, as data: `entry.fields`, `kinds`, `categories`, `linkKinds`, `secrets.stores` (built-ins, this site's own from site.json → `inventory.secretStores`, and the prefix forms), `places` (site.json → `inventory.places`, then every device entry), `rules`, `limits`, `examples`, and `inventory: {entries, updatedAt}`: how many entries there are (`0` while there is no file, `null` when the file fails the checker). Never fails for a missing file, so ask here when you only need the count |
| `GET /api/services` | read | `{"updatedAt","services","hashes","provenance"}`: the entries of kind `runtime` |
| `POST /api/inventory/entries` | `inventory:write` | `{"entry":{…},"base"?}`: create or replace one whole entry → `{"ok","published","entry","hash"}`. The hub stamps `verified_at`, `verified_by` ("Home Hub API · <account>") and a default `confidence` |
| `POST /api/services` | `inventory:write` | The same, for entries of kind `runtime` only |
| `POST /api/inventory/entry` | `inventory:write` | `{"id","base","fields":{…}}`: the web form's field edit → `{"ok","published","doc","hashes"}`. `fields` may hold `name`, `type`, `category`, `address`, `version`, `config`, `data`, `managed_by`, `login`, `notes` (an empty string removes the field), `device`, `secrets` (`[{what, store, ref, check}]`) and `depends_on` (`[{id, kind, label}]`). `{}` only re-stamps the entry as verified today |
| `POST /api/inventory/bulk` | `inventory:write` | `{"entries":[{"entry":{…},"base"?}, …],"dryRun"?}`: create or replace up to 500 entries, all or nothing; the result is checked as a whole, so entries may refer to each other → `{"ok","published","summary":{"create","update","unchanged"},"entries":[{"id","action","hash"}]}`. An entry identical to the stored one is `unchanged` and needs no `base`. `dryRun: true` writes nothing and always answers `200`: the planned actions, or `{"ok":false,"errors","issues"}` / `{"ok":false,"conflicts":[ids]}`. Body up to 1 MB. `keepVerified: true` (password sign-in only; the import in the web UI) keeps each entry's own `verified_at` / `verified_by` |
| `POST /api/inventory/entries/delete` | `inventory:write` | `{"id","base"}` → `{"ok","published","id","deleted":true}`. `base` is required. `422 INVENTORY_IN_USE` (with the ids in `details`) while other entries depend on it or run on it |

Errors of these routes: `400` malformed request (unknown field, bad id, a limit exceeded), `404` unknown id, `409` stale or missing `base` (bulk: the ids are in `details`), `422 INVENTORY_INVALID` when the checker refuses the result — `details` holds its messages and `issues` the same with structure (`{id, field, code, message, text}`, `field` being a path such as `secrets[0].store`) — `429` while another write is being saved, `501` when this hub forwards edits to a writer that cannot bulk or delete, `503` when the file cannot be read or written.

An entry: `id` (lowercase letters, digits, hyphens; never changes), `kind` (`network`, `device`, `runtime`, `tool`, `model-store`, `secret-store`, `skill-store`, `external`), `name`, `device` (the id of a device entry; required for everything that runs on one), and optionally `type`, `category`, `address`, `version`, `config`, `data`, `managed_by`, `login`, `notes`, `secrets`, `depends_on`, `models`, `skills`, `confidence`. Any text that looks like a secret (a key or token, a private key block, a JWT, `password=…`, credentials inside a URL, a long hex or random-looking string) is refused, as is a `check` command that would print one.

**MCP tools** (`POST /mcp`, a service-account key; a tool is listed only for a key that holds its scope):

| Tool | Scope | |
|---|---|---|
| `inventory_describe` | `read` | The schema above, `inventory: {entries, updatedAt}` included. Call it once before writing |
| `inventory_search` | `read` | Text search with optional `kind` and `device`; returns ids and hashes |
| `inventory_get` | `read` | One entry in full, its hash and its dependents |
| `inventory_update` | `inventory:write` | Create or replace one whole entry (`entry`, `base`) |
| `inventory_bulk_upsert` | `inventory:write` | `entries: [{entry, base?}]`, `dryRun?`: as `POST /api/inventory/bulk` (one MCP request is at most 64 kB) |
| `inventory_delete` | `inventory:write` | `id`, `base`: hash-checked, refused while something depends on the entry |

## LLM & Diffusion (UI: #models)

Local language and generative models on every device, built only from the `home.runtimes` and `runtimes.requests`
providers and the devices' stacks (`docs/plugins.md` → extension points). Scope `read`; MCP `models_overview`
(`{range?, graph?}`) returns the same overview, models, clients and known tools, the graph only with `graph:true`.

- `GET /api/models?range=24h|7d|30d` (default `24h`) → `{"schemaVersion":1,"generatedAt","range","empty","providers":{"runtimes":[…],"requests":[…]},"overview","devices","models","clients","graph","known","provenance"}`.
  - `empty` is true when no provider reports a runtime and none holds a request: the page then explains how to connect one.
  - `overview` = `{devices, runtimes:{total,up,down,unknown}, models:{total,loaded,loading,generating,queued,byKind}, memory:[{device,name,ramGb,residentGb,loaded,models,pools:[{runtime,name,usedGb,capacityGb,basis}]}], range, requests, inputTokens, outputTokens, medianTps, attributed, lastRequestAt, observedAt}`. `residentGb` counts what engines hold; a router's budget is a pool, not residency. `medianTps` is the median generation speed of requests with at least 8 output tokens.
  - `models[]` = one entry per model name across devices: `{key, name, kind, state, active, queued, since, devices, sizeGb, contextTokens, ttlRemainingSeconds, lastRequestAt, requests, tokens, placements:[{device, runtime, role, engine, gateways, aliases, id, state, active, queued, since, sizeGb, contextTokens, ttlRemainingSeconds, lastRequestAt, requests, tokens}]}`. `active` / `queued` are `null` where no runtime says how busy the model is; models that generate come first. A gateway alias (`qwen-27b` on llama-swap for an oMLX model) is folded into the engine's placement (`gateways`, `aliases`). `kind`: `llm`, `embedding`, `image`, `video`, `music`, `audio`, `other`.
  - `work` = what generates now: `{items:[{device, runtime, runtimeName, gateways, mode, id, name, kind, active, queued, since}], active, queued, watching:[{device, id, name}], blind:[…]}`; running first, oldest first. `watching` are the runtimes that report how busy they are, `blind` the running ones that cannot. The same per device is `GET /api/home` → `devices[].work` (`watching` and `blind` as names there).
  - `clients[]` = `{client, attributed, clientDevice, via:[provider|address|loopback], requests, inputTokens, outputTokens, recent, lastAt, cross, targets:[{device, runtime, requests, tokens, models:[{model, requests}]}]}`. `client` is `"Unattributed"` and `clientDevice` `null` where the data does not say; `loopback` means the address was 127.0.0.1 (this device, or a tunnel into it).
  - `graph` = `{lanes:[{id, name}], nodes:[{id, column: client|door|engine|model, lane, label, sub, state, kind?, device, runtime?, model?, known?, history?, active?, queued?, requests, tokens, recent, lastAt}], edges:[{id, from, to, requests, tokens, recent, tokensRecent, cross, lastAt}], maxRequests, maxRecent, crossRequests, recentMinutes, truncated}`. Lanes are devices plus `unknown` for clients whose device is not known; `recent` counts the last `recentMinutes` (15).
  - `known[]` = tools a device's stack names (site configuration or `runtime_publish`) that no provider reports: `{device, deviceName, role: client|runtime, title, description, state, source, models, kind}`.
- `GET /api/models/history?range=24h|7d|30d` → `{"schemaVersion":1,"available","range","stepMs","from","to","buckets":[ISO…],"totals":{requests,inputTokens,outputTokens,medianTps,attributed},"requests":[…],"inputTokens":[…],"outputTokens":[…],"tps":[…],"series":{"model"|"device"|"client"|"kind":{"keys":[…],"values":{key:[…]}}},"top":{"model"|"device"|"client"|"kind":[{key,requests,inputTokens,outputTokens,medianTps,medianDurationMs}]}}`. Buckets are hours (24h), six hours (7d) or days (30d) on the site's clock; each series keeps its eight largest keys and folds the rest into `other`. `available` is false when no provider supplies `runtimes.requests`.
- Requests come from every `runtimes.requests` provider, the hub's own llama-swap history among them
  ([LLM runtime endpoints](#llm-runtime-endpoints)). One request reported by two providers counts once (by device,
  runtime, the runtime's record id and time), and the copy that names a client is kept. A client is named from the
  User-Agent of llama-swap's access log (`site.json → runtimeClients` for a household's own names).
- Errors: `400 INVALID_QUERY` for another range or parameter, `503 MODELS_UNAVAILABLE`.

## Backup jobs (UI: #backup-jobs)

Core module `backup-jobs` (`server/core/backups.mjs`, `server/backup-config.mjs`, `server/backup-runner.mjs`),
integration `backup-jobs.runner` (kind `storage`, can be switched off). The hub is the orchestrator: it connects to a
**target** (any SSH host with a POSIX shell and rsync: a NAS, a server) and to the **sources**, and makes one snapshot
per run. Only tools already on both sides are used (`ssh`, `ssh-keygen`, `ssh-keyscan`, `rsync` on the hub; `sh`,
`mkdir`, `mv`, `rm`, `ln`, `df`, `rsync` on the target). Nothing is installed anywhere. `/api/backups…` is not used:
a household plugin may serve its own backups there.

**Who may do what.** Reading (jobs, runs, snapshots, logs) is `read`. Running, cancelling, deleting a snapshot and
re-reading the snapshot list need `backup-jobs:manage` (a person whose role holds it, or an API key with it; old
read/write keys never get it). Creating, editing, testing, confirming host keys and deleting a job need an
**administrator with a password sign-in** (`403 ADMIN_REQUIRED` otherwise, API keys included): a job decides what the
hub reads and where it sends it.

**Keys and host keys.** Creating a job generates a dedicated ed25519 key pair with `ssh-keygen` in
`private/backup-jobs/<id>/` (directory 0700, private key 0600; `BACKUP_KEYS_DIR` moves it). The private key is never
read, logged or returned; the API returns the public key and an `authorized_keys` line,
`restrict[,from="<hub address>"] ssh-ed25519 … home-hub-backup-<id>` (`from` only when the hub has an address inside
`lanCidrs`). Host keys are **trust on first use**: `test` scans the host (`ssh-keyscan`) and returns the fingerprints
(`SHA256:…`, as `ssh-keygen -l` prints them); a person compares one with the device and sends it to `trust`, which
scans again and pins only a key with exactly that fingerprint. From then on every connection uses the job's own
`ssh_config` (`IdentitiesOnly`, no agent, `UserKnownHostsFile` holding only the pinned keys,
`StrictHostKeyChecking yes`, `BatchMode`, no forwarding or multiplexing, `~/.ssh/config` not read). A changed host key
is refused (`host-key-changed`); changing a part's host or port drops its pin. Pins and deletions are in the access
audit (`backup-job-created`, `backup-host-key-pinned`, `backup-snapshot-deleted`, `backup-job-deleted`).

**Snapshot layout** in the target's destination directory:

```
<dest>/2026-11-11T023000Z/<source name>/…   one directory per successful run (UTC start time)
<dest>/latest -> 2026-11-11T023000Z          the snapshot of the last successful run
<dest>/.in-progress-<stamp>/                 the run being written; renamed on success, removed by the next run
<dest>/.home-hub-backup-job                  the owner marker: the id of the job that writes here
```

**One destination, one job.** Saving a target that equals, contains or lies inside another job's (same host and
port) is refused (`409 BACKUP_DEST_SHARED`). What validation cannot see (an IP and a name for one device, a symlink)
the owner marker catches: the first run writes the job id into `.home-hub-backup-job`, and every later prepare,
rename, prune and delete-snapshot refuses a destination whose marker names another job (`dest-owned`); the
connection test reports it too.

Each source is pushed with `rsync -a --delete --numeric-ids --stats --timeout=600 --link-dest=<dest>/<previous>/<name>`,
so unchanged files are hard links into the previous snapshot: every snapshot is a full, browsable tree that costs only
what changed. A source on another SSH host is first mirrored into `state/backup-jobs/<id>/staging/<name>/` on the hub
(incremental `rsync` pull; `BACKUP_STAGING_DIR` moves it), then pushed like a local one: rsync cannot copy between two
remote hosts, and the job's key is never handed to another computer. After a good run the staging copy of a source that
is no longer in the job is removed (the hub does not check its own free space before staging: the size of a remote
source is not known without a full rsync dry run).

**What a local source never carries.** A local source may not be, or lie inside, the key directory, the backup state
(`state/backup-jobs/`) or the staging directory (`400 BACKUP_SOURCE_PROTECTED` when saved, `source-protected` when a
symlink moved in between). When a source contains any of them, or the hub's `private/`, they are excluded
(`--exclude=/<relative path>/`, with `* ? [ ] \` escaped). Paths are compared after `realpath`, and without regard to
case on macOS and Windows. `~` and `~/…` are the home of the user the hub runs as.

**Seal, then retention.** After the copies, one remote step renames `.in-progress-<stamp>` to `<stamp>` (refused if a
directory of that name already exists: `stamp-exists`) and points `latest` at it; that step decides whether the run
succeeded. Retention is a separate step after it: a snapshot stays when it is among the newest `keepLast` or younger
than `keepDays` (at least one must be set; a hand-edited file with neither prunes nothing). This run's snapshot and the
newest are never deleted. Every step that may delete (leftovers, retention, delete-snapshot) runs under the job's
deadline, not the 60 s of a short ssh command.

**Warnings** (`result: "warning"`, `warnings: [codes]`, `warningMessages`): the snapshot is kept and nothing is pruned.
`partial`: rsync exit 23/24 (unreadable or vanished files; decided by the exit status alone, before any stderr is read).
`source-empty`: a source sent nothing but its own directory. `newer-snapshot`: the target holds a snapshot named
later than this run (a clock that went back). `prune-failed`: the snapshot is good, deleting old ones failed. SSH
errors are read from stderr only when the exit status is ssh's own (255) or rsync's connection errors (12, 30, 35).

**Runs.** One run per job at a time: in memory, and a lock file `state/backup-jobs/<id>/run.lock` (`{pid, runId,
startedAt, timeoutMinutes, child}`) that a second hub process on the same state respects. A lock is taken over when its
process is gone, or when it is older than the job's deadline plus 10 minutes whoever holds it (a reused PID cannot keep
it). Each process has a deadline (short ssh commands 60 s, the rest `timeoutMinutes`, 5–2880, default 360), runs in a
process group of its own and is cancelled with SIGTERM, then SIGKILL, to the whole group. A run is recorded as
`running` when it starts and its log is written to disk as it goes (`GET …/log`, ≤ 256 KiB; the last 200 runs are
kept). Test, trust, refresh, edit and delete answer `409 BACKUP_BUSY` while the job runs. A `runs.json` that cannot be
read is never overwritten (`500 BACKUP_HISTORY_UNREADABLE`; the views show the job with `historyUnreadable: true`).

**Stopping the hub.** On SIGTERM or SIGINT the server stops taking requests and calls every module's `stop()` (at most
`SHUTDOWN_GRACE_MS`, default 15 s, then it exits anyway; a second signal exits at once). A running backup ends as
`interrupted`: its rsync and ssh are stopped and its record and log are written. After a crash or `kill -9`, the next
start marks a run left `running` as `interrupted`, removes the stale lock and stops the rsync or ssh that lock names
(only when that pid still runs one of the backup tools); the next run removes the unfinished snapshot.

**Schedule.** `daily` or `weekly` (`days` 1 = Monday … 7) at `time` HH:MM in the site time zone, or `manual`. A time
a DST change skips runs an hour later; a repeated time runs once. One in-process timer wakes at the soonest next run
(at most an hour ahead, then it looks again) and re-arms after every change; a slot that comes due while a re-arm is
in flight still fires, and concurrent re-arms leave one timer. **Missed runs:** when the hub starts and a job's newest
scheduled slot is later than both its last attempt and its last change, the job runs **once** (trigger `catch-up`) a
minute after the start, however many slots were missed. While the integration is off nothing is started or caught up.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/backup-jobs` | read | `{jobs, suggestions, timeZone, canManage, disabled?}`; `suggestions` are the site's devices for the wizard |
| GET | `/api/backup-jobs/detail?id=` | read | `{job, publicKey, authorizedKeys: {line, plain, address}, runs, snapshots}` |
| GET | `/api/backup-jobs/log?id=&run=` | read | One run's log as `text/plain` |
| POST | `/api/backup-jobs/create` | admin | `{name}` → 201 with the detail; a draft job with its own key |
| POST | `/api/backup-jobs/update` | admin | `{id, base, name?, target?, sources?, excludes?, schedule?, retention?, timeoutMinutes?, enabled?}`; `base` is the job's `hash` (409 `BACKUP_CONFLICT` when stale) |
| POST | `/api/backup-jobs/test` | admin | `{id, part: "target" \| "source", index?}` → `{result: {state: trust \| changed \| ok \| problem, hostKeys?, pinned?, checks: [{id, ok, value?}], error?, message?}}` |
| POST | `/api/backup-jobs/trust` | admin | `{id, part, index?, fingerprint}` pins the host key |
| POST | `/api/backup-jobs/delete` | admin | `{id, base}`; deletes the job, its key and history. Snapshots on the target stay |
| POST | `/api/backup-jobs/run` | `backup-jobs:manage` | `{id}` → 202 `{started: {runId, snapshot, startedAt}}` |
| POST | `/api/backup-jobs/cancel` | `backup-jobs:manage` | `{id}` |
| POST | `/api/backup-jobs/delete-snapshot` | `backup-jobs:manage` | `{id, snapshot}`; `latest` moves to the newest one left |
| POST | `/api/backup-jobs/refresh` | `backup-jobs:manage` | `{id}`: read the snapshot list and free space from the target again |

A job: `{id, name, enabled, target: {host, port, user, path, hostKey: {type, fingerprint, pinnedAt, pinnedBy}},
sources: [{name, kind: "local", path} | {name, kind: "ssh", host, port, user, path, hostKey}], excludes, schedule:
{mode, time, days}, retention: {keepLast, keepDays}, timeoutMinutes, hash, missing}` (`missing`: codes `target`,
`target-key`, `sources`, `source-key:<name>`) plus, in lists, `state` (`draft`,
`off`, `ready`, `running`, `ok`, `warning`, `failed`, `cancelled`, `interrupted`), `running`, `nextRunAt`, `lastRun`, `lastSuccessAt`,
`sizeBytes` (logical size of the newest good snapshot), `snapshots`, `space`. A run: `{id, trigger: manual | schedule |
catch-up, by, startedAt, finishedAt, durationMs, result: running | ok | warning | failed | cancelled | interrupted,
error?, message?, warnings?, warningMessages?, snapshot, present, deletedAt, stats: {files, filesTransferred, totalBytes,
transferredBytes, sentBytes}, pruned}`. Validation: hosts are names or IPv4 addresses,
users `[A-Za-z_][A-Za-z0-9._-]*`, remote paths absolute without spaces, quotes or shell characters; local paths
absolute or `~/…`; no `.`/`..` segments; nothing that looks like a secret (in paths and exclude patterns only
unmistakable credentials count: a hash-named directory is fine). `jobs.json` is read with the same validators: a part
written by hand that fails them is dropped, so the job reads as incomplete. Errors are `BACKUP_<REASON>` with a
sentence in `message` (`server/backup-runner.mjs → BACKUP_ERRORS`); a validation error also has `field`
(`target.path`, `sources[1].host`, …) and the English `details`. While the integration is off, reads carry `disabled` and
`test`, `trust`, `run`, `delete-snapshot` and `refresh` answer `409 INTEGRATION_DISABLED`.

MCP: `backup_jobs_list` (scope `read`) returns every job as in `GET /api/backup-jobs`.

**On the target, once per job** (the wizard shows the same): a user with a real shell (not `nologin`), the destination
directory owned by it, the `authorized_keys` line in `~<user>/.ssh/authorized_keys` (`.ssh` 0700, file 0600), SSH on,
rsync present. That user's login shell must accept POSIX `sh -c '…'` quoting (sh, bash, zsh, dash, ksh; fish works;
csh and tcsh do not). A source on another computer needs the same public key for the user the job names there. The key
gives a shell on each of those devices (restricted by `restrict`, and by `from="…"` when given). On the target an
`rrsync` forced command is not possible, because the hub runs `mkdir`, `mv`, `rm`, `ln`, `cat` and `df` in the
destination; on a source that only has to be read, `command="rrsync -ro <path>"` before the key narrows it to read-only
rsync (the wizard's connection test then reports `no-shell`; the runs work).

## Git LFS (UI: #git-lfs)

LFS objects of repositories on connected git hosts (GitHub, GitHub Enterprise, Gitea, Forgejo, or a plugin's
provider). The rules, the hosts' real capabilities and the token permissions are in `docs/git-lfs.md`. Reading needs
`read`. Managing connections and deleting needs `git-lfs:write`, a core scope that old write keys do not get. While
the integration `git-lfs.hosts` is off, every GET answers `200 {"disabled":{…}}` with empty lists and every POST
answers `409 INTEGRATION_DISABLED`.

- `GET /api/git-lfs` → `{"schemaVersion":1,"enabled","graceHours","refreshMinutes","maxDelete","git":{ok,version},"providers":[…],"connections":[…]}`.
  - `providers[]` = `{id, title, kind: builtin|plugin, capabilities:{listRepos, checkObjects, listObjects, deleteObjects, tokenScopes}, fixedBaseUrl, token:{permissions[], note, url, urlTemplate}}`. `urlTemplate` holds `{web}` for the host's address.
  - `connections[]` = `{id, provider, providerTitle, name, baseUrl, web, plainHttp, repoMode: all|owner|selected, owner, repos, login, scopes, tokenSet, createdAt, createdBy, updatedAt, updatedBy, capabilities, placement: {service:{id,name,device,deviceName}, storage:{…}|null}|null (where the inventory says the host and its LFS object store run; server/git-lfs-placement.mjs), scan:{running, startedAt, finishedAt, error, truncated, repos:[{fullName, state: ok|error, error, scannedAt, complete, incomplete: no-refs|no-default-branch|null, storedCheck: listed|ok|partial|failed|skipped, defaultBranch, refs, objects, bytes, url}]}}`. The token itself is never in an answer; `tokenSet` says whether one is stored.
- `GET /api/git-lfs/objects?connection=&repo=&q=&ext=&status=all|current|branch|history|orphaned&minSize=&maxSize=&sort=size|path|repo|status|commit|lastSeen|oid&dir=asc|desc&offset=&limit=` (`commit` = the date of `lastCommit`; `limit` 1–200, default 50; sizes in bytes; `ext=-` = no extension) → `{"total","offset","limit","totals","filtered","extensions":[{ext,count}],"items":[…]}`.
  - `totals` (for the chosen connection or repository) and `filtered` (after every filter) = `{count, bytes, reclaimableCount, reclaimableBytes, byStatus:{current|branch|history|orphaned:{count, bytes}}}`.
  - An item = `{oid, size, status, stored: true|false|null, paths[], pathCount, currentPaths[], refs[] (tips that contain it), refCount, via[] (refs its commits were reached from), firstCommit:{sha,at}, lastCommit, commits, remembered, firstSeenAt, lastSeenAt, lastReferencedAt, unreferencedSince, createdAt, connection, connectionName, provider, repo, repoUrl, extension, reclaimable, canDelete, deleteBlocked, manual?}`. `deleteBlocked` is `current`, `history`, `unverified`, `storage-unknown`, `grace`, `unsupported` or `null`. `manual` = `{text, url}`: how to remove a reclaimable object by hand on a host that cannot delete.
  - `400 INVALID_INPUT` for an unknown parameter or value.
- `POST /api/git-lfs/refresh` (`read`; an API key needs `git-lfs:write`) `{connection?, repo?}` → `202 {"started":[ids],"skipped":[{connection, reason: running|throttled}]}`. At most one scan per connection every 30 s.
- `POST /api/git-lfs/test` (`git-lfs:write`) `{provider, baseUrl?, token}` or `{provider, baseUrl?, connection}` (the stored token, same provider and host only) → `{"ok":true,"web","api","plainHttp","user":{login,name},"scopes":[…]|null,"scopesNote","warnings":[…],"capabilities","git"}`.
- `POST /api/git-lfs/repos` (`git-lfs:write`) `{provider, baseUrl?, token | connection, owner?}` → `{"repos":[{fullName, owner, private, archived, defaultBranch}],"total","truncated"}` (at most 1000).
- `POST /api/git-lfs/connections` (`git-lfs:write`) `{id?, provider, name, baseUrl?, token?, repoMode, owner?, repos?}` → `201` (new) or `200 {"connection":{…}}`. The token is checked against the host before anything is stored. Leaving out `token` keeps the stored one, but only while provider and host stay the same (`400 GIT_LFS_TOKEN_REQUIRED` otherwise). Up to 200 repositories. Saving starts a scan.
- `POST /api/git-lfs/connections/remove` (`git-lfs:write`) `{id}` → `{"removed":id}`. Removes the token, the catalog and the mirrors; the host is not touched.
- `POST /api/git-lfs/delete/preview` (`git-lfs:write`) `{connection, repo, oids:[…]}` or `{connection?, repo?, filter:{q?, ext?, minSize?, maxSize?}}` (orphaned objects only) → `{"groups":[{connection, connectionName, provider, repo, revision, scannedAt, canDelete, manual?, eligible:[{oid, size, paths, lastCommit, unreferencedSince, createdAt}], refused:[{oid, size, status, reason, message}], bytes}],"eligibleCount","eligibleBytes","graceHours"}`. `reason` also covers `not-found` and `in-use-elsewhere`.
- `POST /api/git-lfs/delete` (`git-lfs:write`) `{connection, repo, oids:[1–500], revision, requestId}` → `{"requestId","deleted":[{oid,size}],"refused":[{oid,reason,message}],"failed":[{oid,error}],"bytes","stopped?","stoppedMessage?","refsChangedDuring?"}`, after a fresh scan of the repository.
  - Before every 25 deletions the host's refs are read again. `stopped` is `refs-changed` or `refs-unverified` when that check stops the rest, and `audit-failed` when an audit line could not be written. Objects not reached are in `refused` with the same reason.
  - `refsChangedDuring: true` means the refs changed after the last check, when nothing was left to stop.

  Errors:
  - `409 GIT_LFS_UNSUPPORTED`: the host cannot delete. This is every built-in provider.
  - `409 GIT_LFS_CONFLICT`: the revision is not the preview's, or the refs or the stored list changed.
  - `503 GIT_LFS_UNVERIFIED`: the fresh scan failed or was incomplete. Nothing is deleted.
  - `409 GIT_LFS_BUSY`: a scan or another deletion is running.

  The same `requestId` again returns the first answer (`repeated: true`).
- `GET /api/git-lfs/audit` (`git-lfs:write`) → `{"items":[…]}`, the last 50 audit lines, newest first: `{at, requestId, actor, connection, provider, host, repo, oid, size, revision, result: started|deleted|failed, error?}`.
- Host failures answer `502 GIT_LFS_HOST` with `error.host` = `auth`, `forbidden`, `not-found`, `network`, `timeout`, `rate-limited`, `redirect`, `host-error`, `bad-response`, `too-large` or `too-many`. git failures are recorded per repository (`scan.repos[].error`). A missing git binary is `503 GIT_LFS_GIT_MISSING`.

## Version and updates

Home Hub tells which release it runs and whether a newer one is known. It never applies an update: there is no
route for that, and no MCP tool. The check itself is the integration `updates.check` (Administration →
Integrations); `HOME_HUB_UPDATE_CHECK=off` in the environment turns it off for good.

- `GET /api/updates` (any signed-in account, or an API key: scope `read`) →
  `{schemaVersion:1, generatedAt, state, code, summary, summaryT?, installed:{version, label, exact, commit, dataEpoch}, latest:{version, tag, url, publishedAt, notes} | null, updateAvailable, dismissed, quarantined:{version, at, reason} | null, checkedAt, failedAt, error, notBefore, nextCheckAt, repo, repoSource, channel, intervalHours, apply:{automatic:false, tag, command}, disabled?}`.
  - `state` is an integration state; `code` says which case it is:

    | `state` | `code` | Meaning |
    |---|---|---|
    | `ok` | `current` | The last check succeeded and `latest` is the release that is running |
    | `ok` | `available` | … and `latest` is newer: `updateAvailable: true` |
    | `ok` | `development` | … and this is a development build (`installed.exact` is `false`), or a version ahead of every release. `updateAvailable` still says whether `latest` is newer |
    | `ok` | `no-release` | … and the repository has published no release that counts (`latest: null`) |
    | `stale` | `failed` | The last attempt failed (`error`, `failedAt`). `latest` is what was known at `checkedAt`; whether it is still the newest is **not known** |
    | `stale` | `old` | No attempt failed, but the last success is older than three intervals (36 h by default) |
    | `stale` | `pending` | Nothing has been attempted yet: the first check runs 2 to 5 minutes after start |
    | `error` | `never` | No check has succeeded yet (`error`) |
    | `off` | `env-off` | `HOME_HUB_UPDATE_CHECK=off` |
    | `not-configured` | `no-repo` | No repository is named (`package.json → homeHub.updates.repo`, `site.json → updates.repo`) |
    | `disabled` | `disabled` | An administrator turned the integration off: `disabled: {id, title, by, at}`, `latest: null` |

    A failed check never answers `current`. A client that wants one bit shows "update available" only for
    `updateAvailable && !dismissed`, and shows nothing, not "up to date", in every other case.
  - `latest.notes` is the text of the Release (at most 8 000 characters): somebody else's prose, to be shown as
    plain text. `latest.url` always starts with `https://github.com/<repo>/releases/`.
  - `error` is short: `HTTP 403`, `timeout`, `ENOTFOUND`. `notBefore` is set while GitHub's rate limit asks the hub
    to wait (at most a day); `nextCheckAt` is the next scheduled attempt.
  - `quarantined` marks a release that was tried on this hub and rolled back (written to `state/updates.json` by
    `scripts/update.mjs`, `docs/updating.md`). `apply.tag` is the release tag to switch to and `apply.command` the
    command a person runs on the server for it, from the core checkout (`node scripts/update.mjs apply <tag>`;
    `null` when no newer release is known); `apply.automatic` is always `false`.
- `POST /api/updates/check` `{}` (administrator, password sign-in; never an API key or an app token) →
  `{checked, reason?, updates}`. `checked: false` with `reason` `too-soon` (one forced check a minute),
  `rate-limited`, `env-off` or `no-repo` means no request was made. `409 INTEGRATION_DISABLED` while it is off.
- `POST /api/updates/dismiss` `{version}` (the same) → `{updates}`: stop pointing at that release in the footer.
  Only the newest known release that is newer than the running one can be dismissed (`409 UPDATE_NOT_CURRENT`
  otherwise); the next release is told again.

`state/run.json` (0600) is written when the server listens: `{version, commit, exact, dataEpoch, pid, startedAt,
plugins:[{id}]}`. A tool that changed the code reads it to confirm which process is answering.

## Other read-only routes

- `GET /api/inventory`: the inventory (`{"doc","gaps","hashes","provenance"}`); `GET /api/services`: its runtime entries; `GET /api/inventory/export`: the file as a download.
- `GET /api/systems` and `GET /api/security` (any role or API key that holds `security:read`: the owner, Admin, a custom role that lists it): OS and software versions with host protection, and the SSH key inventory. Each `software` row carries `inventory`: the inventory entry ids it describes when the id/name match would miss them (from the software watch list); the web inventory map uses it for its version block.
- `GET /healthz` → `{"ok":true}` with no auth. Use it as a reachability probe.

## Example (curl)

```bash
H='https://hub.example.lan'
curl -s -c jar -H "Origin: $H" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"…"}' "$H/api/session"
TOKEN=$(curl -s -b jar -H "Origin: $H" -H 'Content-Type: application/json' \
  -d '{"name":"curl test"}' "$H/api/app-tokens" | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" "$H/api/home" | jq '.devices[] | {id, online}'
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"project":"my-app","title":"Filed from curl"}' "$H/api/tickets"
```

## Device catalog and service registration

`GET /api/device-catalog` (scope `security:read`) and MCP `device_catalog` join the overview, inventory, runtime observations and software watch. The response contains `schemaVersion:1`, `devices`, `services`, `software`, `models`, `clients`, `uses`, `warnings`, `kinds` and `platforms`. Configured detection rules are not evidence that software is installed; missing model/client relationships stay unknown.

`POST /api/service-registrations` (scope `inventory:write`) and MCP `service_register` create or update an inventory runtime's typed service descriptor. Required fields are `id`, `device`, `name`, `kind`, `binary`, `platform`, `port`. Optional fields are `mode` (`server` or `on-demand`), `address`, `endpointId`, `watchId`, and `base`. Existing entries require the current inventory hash as `base`; a conflict returns 409 without writing. Invalid references or descriptors return 422. A successful response is `{ok:true, entry, hash, published}`. The existing inventory writer performs validation and publication; no binary is executed or service installed.

See [the type model, schemas and per-OS setup](services.md) for stable IDs, registration examples, supported kinds and extension instructions.

### Platform search settings (administrator password session)

`GET /api/admin/platform/search` returns `{defaultMode:"text",configured,enabled,model,status}`.
`POST /api/admin/platform/search` accepts only `{enabled:boolean}`; enabling requires a configured
provider. Viewers, other non-admin roles, app tokens and API keys cannot use these routes. No
provider credential or URL is returned. The setting persists across restarts; changing it cancels
and rebuilds the derived service without changing canonical tickets.

Global `GET /api/search?q=...` and MCP `search` include attachment metadata and supported UTF-8
contents by default. HTTP accepts `mode=text|semantic|hybrid`, default text; semantic/hybrid search
covers tickets only. Its response adds `mode`, `semanticAvailable`, and `attachmentSearch` readiness.
Existing field filters and the legacy `ticket_search` response are preserved. The attachment-aware
`ticket_hybrid_search` tool also defaults to text; request semantic or hybrid mode explicitly.
The platform toggle enables provider use, not an implicit change to query semantics.

### Release package discovery (additive)

`GET /api/updates/releases` (authenticated, scope `read`) returns cached published release selection, repository,
channel, discovery time and deterministic package assets. Reading it makes no network request. Drafts and excluded
prereleases are absent; a disabled integration returns no releases. `GET /api/updates` retains `latest`, dismissal,
`apply.tag`, the existing Git `apply.command` and `apply.automatic:false`, and adds `discovery`, `trust` and `package`.
Package entries include CLI download/preflight/apply instructions, hosting-provided manifest digest when available,
`signature:not-checked`, `compatibility:unknown`, verification time and asset links. This is discovery evidence;
only CLI preflight establishes real instance compatibility and independently configured signatures authorize code.
There is no package upload, installation, trust-write or restart route or MCP tool. `/healthz` remains unauthenticated
with exactly `{ok:true}`; `X-Home-Hub-Run-Id` correlates it with the local runtime identity file without exposing version.

## References

All readers can browse Settings → References, read model documentation and inspect incoming uses. A
project-local reference is available for mentions in its owning project. Existing Home Hub read
access covers all projects. A native wiki page, tracker ticket, project or machine keeps its source ID.
A wiki ID is the full `project/pageId`; encode it as one query parameter. Model and Custom IDs are opaque.

| HTTP route | Scope | Input and result |
|---|---|---|
| `GET /api/references` | read | Filter by optional `kind` (machine, model, project, custom, wiki, ticket), `scope` (global, local), owning `project`, and prefix `q`. Returns `{items,total}` with offset/limit pagination (50 by default, 100 maximum). |
| `GET /api/references/suggest` | read | Same filters, with `project` meaning the project being edited. Includes its local items and all global items. Default 8, maximum 20. Matches case- and accent-insensitive prefixes of labels, words and IDs. |
| `GET /api/references/item?kind=…&id=…` | read | Returns `{record,note,usages,usageTotal}`. Each usage has a source kind, ID, label, direct href, excerpt and update date. Ticket uses also identify the description or comment. Page with `offset` and `limit`. |
| `POST /api/references/resolve` | read | `{refs:[{kind,id}]}`, maximum 100. Returns `{items}` with current labels and source links for known IDs. |
| `POST /api/references/local/save` | tickets:write | `{kind:"custom",project,label,description?,id?,rev?}` creates or replaces a project record. |
| `POST /api/references/global/save` | references:write | `{kind:"custom"\|"model",label,description?,id?,rev?}` creates or replaces a Settings record. Models are documentation for readers and agents. |
| `POST /api/references/local/delete` | tickets:write | `{project,kind,id,rev}`. Existing mentions retain their saved labels. |
| `POST /api/references/global/delete` | references:write | `{kind,id,rev}` for a Custom or model record. |
| `POST /api/references/promote` | tickets:write + references:write | `{kind:"custom",project,id,rev}`. Atomically moves a local record to Settings with the same ID. |
| `POST /api/references/share` | tickets:write + references:write | `{kind,id,rev}` allows a native wiki page or ticket to be mentioned across projects. Pass the annotation revision, initially zero. |
| `POST /api/references/note` | references:write | `{kind,id,description,rev}` sets the optional description on a native source. Pass the annotation revision, initially zero. An empty description clears the text. |

Creation omits ID and revision. Updates send both. A stale revision or a duplicate label of the same
kind in the destination returns 409. Labels accept 1–200 characters, descriptions up to 8,000.
A record save supplies its full label and description. Read the current record before editing.

Agents can call `references_search` and `reference_get` with `read`. The corresponding mutation tools are
`project_reference_save`, `reference_save`, `project_reference_delete`, `reference_delete`,
`reference_promote`, `reference_share`, and `reference_note_save`. They use the same inputs, scopes and revision rules.

Ticket description and comment mentions use `@[Label](ref:kind/id)`, for example
`@[Build host](ref:machine/build-host)`. Escape brackets and backslashes within the label with a
backslash. A backslash immediately before the token displays it literally. Fenced and inline code
remain literal. Legacy ticket IDs keep their existing automatic links. Wiki mentions use typed inline
runs as described in [Wiki](wiki.md). External Atlassian Jira tickets are outside the native tracker catalog.
