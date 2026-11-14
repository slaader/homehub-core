# Changelog

Home Hub core, newest first. One section per release; the section is the text of that release on GitHub
(`node scripts/release.mjs <version> --notes` prints it). Parts, in this order, empty ones left out:
**Added**, **Changed**, **Deprecated**, **Fixed**, **Plugin contract**, **Data**, **Upgrade notes**. What the version
number promises is in `AGENTS.md` → Versioning. The top section is the release being prepared, `## Unreleased`
until the release gives it its number: a change to the public surface adds its line there in the same commit.

## 2.0.0

A major release: names on the public surface change, with no alias for the old ones.

### Added

- `node scripts/convert-site.mjs [<site.json>]` converts a 1.x site file to 2.0 in place (written whole: a
  temporary file, then a rename) and keeps the 1.x file beside it as `site.v1.json`. It prints what it renamed, and
  refuses, writing nothing, a file that is already 2.0, one that is not a valid 1.x file, and a directory that
  already holds `site.v1.json`. Without a file it converts the one the hub reads.

### Changed

- **Breaking: device tokens are now app tokens.** The long-lived `hh_…` token of a native app keeps working, and
  everything that named it changes. A native app must be updated together with the hub:
  - Routes: `GET` and `POST /api/app-tokens` and `POST /api/app-tokens/revoke` replace `/api/devices/tokens` and
    `/api/devices/tokens/revoke`, which now answer `404`.
  - Answers: issuing returns `{token, app}` (was `{token, device}`); the list and the revoke answer carry `tokens`
    (was `devices`).
  - The error code `APP_TOKEN_LIMIT` replaces `DEVICE_LIMIT`.
  - `GET /api/me` reports `authKind: "app"` (was `"device"`) and the user name `Native app` (was `Native device`).
    Records written under the old name keep it and are still counted as a person's work.
  - The audit: `GET /api/admin/audit?kind=app` (was `kind=device`), with the events `app-token-issued` and
    `app-token-revoked` (were `device-issued`, `device-revoked`). Events recorded by 1.0 are shown under the new names.
  - A custom role can no longer be created with the id `app` (`device` is free again). A role that already has that
    id keeps working.
- **Breaking: the overview's routes are laid out again**, so that one path means one thing:
  - `GET /api/home/devices` is the list and `POST /api/home/devices` the hash-checked upsert (scope `home:write`).
    They replace `GET` and `POST /api/home/machines`, which now answer `404`, to an API key too: a path that no
    route has, by any method, is `404 NOT_FOUND` for a key as for a person (1.x refused a key's `POST` to such a path
    with `403 SCOPE_REQUIRED`). A path with a route that keys may not use is still refused with `403`.
  - `POST /api/home/devices/add` is the overview's **Add device** form (a person or an app, never an API key). It was
    `POST /api/home/devices`; a client that still posts the form there gets `400` from the upsert.
  - `POST /api/home/devices/remove` `{id, base?}` is the one removal and answers `{ok: true, id, removed: true}`
    (the overview's old route answered `{removed: <id>}`). It replaces `POST /api/home/machines/remove`. An API key
    needs the scope `home:write` and sends `base`, checked as before. A person or an app with write access may remove
    with `{id}` alone, whatever the role's scopes, as the overview's old route allowed; a `base` that is sent is checked.
- **Breaking: a machine is now a device, everywhere.** What the hub called a machine (a computer, a NAS, the router:
  whatever `site.json` lists or the overview adds) is a device in the configuration, the API, the MCP tools, the
  commands and the plugin contract. The old names are gone, with no alias. Where the difference matters, a **site
  device** is one from `site.json` and an **added device** one added on the overview or written by an agent.
  - `site.json`: the key `machines` is `devices`, and `runtimes[].machine` is `runtimes[].device`. A file that still
    has `machines` is refused at start with a message that names the new key. Host agents are placed under
    `plugins.<id>.agents.<agent>.<device id>`, as before. 1.x refuses the 2.0 file in turn, so the file is converted
    with a command that keeps the 1.x file beside it (Added, and Upgrade notes).
  - HTTP fields and parameters: `machine` → `device` and `machines` → `devices` in every answer and body, among them
    `GET /api/home` (`devices`), `GET` and `POST /api/home/devices` (`{devices}`, `{device, base?}`),
    `POST /api/home/devices/site`, `POST /api/home/runtime`, `GET /api/home/history?device=`, `GET /api/systems`,
    `GET /api/security`, `GET /api/collectors`, `GET /api/models` (`clientDevice`), `GET /api/software-watch`,
    `GET` and `POST /api/admin/agents` and the inventory (below). `machineCollectedAt` is `deviceCollectedAt`.
    `GET /api/router` names the site's own router entry `siteDevice` (was `machine`).
  - `GET /api/admin/devices` replaces `GET /api/admin/machines`.
  - Error codes: `MACHINE_INVALID`, `MACHINE_SECRET`, `MACHINE_NOT_FOUND`, `MACHINE_READ_ONLY`, `MACHINE_CONFLICT`,
    `MACHINE_DUPLICATE` and `MACHINE_LIMIT` are `DEVICE_…`; `AGENT_MACHINE_GONE` is `AGENT_DEVICE_GONE`. Note that
    `DEVICE_LIMIT` now means "the overview holds its 20 added devices"; the app-token limit is `APP_TOKEN_LIMIT`.
  - MCP: the tools `machine_list`, `machine_upsert` and `machine_remove` are `device_list`, `device_upsert` and
    `device_remove`; the argument `machine` is `device` there and in `runtime_publish`, `inventory_search` and
    `runtime_endpoint_upsert`. A tool whose schema says `additionalProperties: false` (every core tool) now refuses
    an argument it does not list, where 1.x ignored it: an `inventory_search` with `machine` was a search on every
    device, and is now an error that says `machine` was renamed to `device`.
  - Inventory: the entry kind `machine` is `device` and the entry field `machine` is `device`. An entry's hash covers
    its fields, so every entry of kind `device` and every entry placed on one has a new hash (only an entry that
    named no machine, such as a `network` or an `external` one, keeps its hash): a client that kept one reads the
    entry again. The document is
    `schema: 2` (`GET /api/inventory`, the export, `inventory_describe`); a document with `schema: 1` is refused by
    the checker (`schema must be 2`). The import on the inventory page still takes a file exported by 1.x.
  - `GET /api/systems` and `GET /api/security` answer `schemaVersion: 2` (their `machines` are `devices`), also when
    their integration is turned off. The other answers whose fields were renamed (`GET /api/home`,
    `GET /api/admin/devices`, `GET /api/models`, `GET /api/collectors`, `GET /api/software-watch`) keep the
    `schemaVersion` they had in 1.x: tell 1.x from 2.0 by the hub's version (`GET /api/ui/manifest`, `hub_version`).
  - Push agent: an agent key is bound to `device` (`GET /api/admin/agents`, the key file's `agent.device`); a key is
    revoked by the hub as `device-removed` or `device-changed`.
  - Commands: `--device` replaces `--machine` (`scripts/manage-access.mjs create-agent-key`,
    `scripts/import-runtime-history.mjs`, `scripts/install-host-agent.mjs`; given `--machine`, each says that it was
    renamed and stops), and the environment variable
    `DEVICES_DIR` replaces `MACHINES_DIR`.
- **Breaking: the router's census is `clients`**, so that a device is only ever the household's. `GET /api/router`
  answers `schemaVersion: 2` with the network clients the router saw as `clients` (was `devices`) and their counts as
  `health.clientCounts` (was `health.clients`); `health.hardware` (gateway, switches, access points) is unchanged.
  `GET /api/home → router.clients` and a router tile's `quad.clients` were already counts and stay as they are.
  The UniFi collector writes `clients` and `hardware` (were `devices` and `unifiDevices`), `schemaVersion: 2`.
- **Breaking: the Czech UI says "zařízení" instead of "stroj"** for a device, in every form and with the words that
  agree with it. The dictionary keys are the Czech source strings, so about 380 keys changed (for example `Upravit stroj`
  is `Upravit zařízení`, `Stroje` is `Seznam zařízení`): a plugin's dictionary that translated core keys must follow,
  or those strings show in Czech. The English texts are unchanged. A 1.x key inventory's findings are read in the new
  wording.

### Plugin contract

- **Breaking:** a plugin's MCP tool whose `inputSchema` says `additionalProperties: false` gets only the arguments
  its `properties` list: a call with any other is refused before `run`, as for the core tools (it reached `run`).
- A route may declare `people: "write"`: a person or a native app then needs only write permission, not the
  route's `scope`; an API key still needs the scope (docs/plugins.md → Route fields).
- **Breaking:** `principal.authKind` is `app` for a native app's token (was `device`), and a route handler's context
  carries `appToken` (was `device`).
- **Breaking:** the extension point `machines.facets` is `devices.facets`, and an integration's field `machines` is
  `devices`. `hub.site.machines` is `hub.site.devices`; a page's context carries `device` (was `machine`).
- **Breaking:** `home-hub/testing` exports `deviceKind` and `systemDevices` (were `machineKind`, `systemMachines`);
  `buildSystems`, `buildGraph` and `liveState` take `devices` (was `machines`) and answer with `device` and `devices`.
- **Breaking:** a provenance source counts `unit: "devices"` (was `"machines"`), and a `runtimes.requests` item
  names `device` and `clientDevice` (were `machine`, `clientMachine`).
- **Breaking:** a host agent's `config` module gets `{site, device}` (was `{site, machine}`).
- **Breaking:** a `router.adapter` observation lists the router's network clients as `clients` (was `devices`); one
  that still returns `devices` reports no clients. `readRouter` and `readRouterFor` answer with `clients` and
  `health.clientCounts`, and `mergeRouter` reads `router.clients`.
- **Breaking:** `createKnowledgeEditor` and `validateKnowledge` work on the `schema: 2` inventory document (kind and
  field `device`). The editor reads a `schema: 1` file forward; `validateKnowledge` refuses a `schema: 1` document.

### Data

- **The data epoch is 2.** Going back to 1.x after 2.0 has started needs the backup made before the update
  (`node scripts/update.mjs apply` makes one), not only the older code, and the 1.x site file put back: the archive
  holds the site file as it was when the hub stopped, converted (Upgrade notes).
- **Nothing has to be run on the state.** Every file 1.x wrote is read in its old form the first time 2.0 opens it
  and written in the new one in its place, once and whole (a temporary file, then a rename). Ids and dates are
  unchanged, and so are the hashes of tokens and keys; the inventory's entry hashes change as above.
  `docs/storage.md` → State written by 1.x has the table. Only the site file is converted, by a command.
- `state/device-tokens.json` (`{schemaVersion: 1, devices}`) becomes `state/app-tokens.json`
  (`{schemaVersion: 2, tokens}`) and `state/device-tokens-audit.jsonl` becomes `state/app-tokens-audit.jsonl`. Both
  are moved once, at the first start; ids and hashes are unchanged, so every issued token keeps working. A 1.x hub
  started on the migrated state finds no token file: every app token is refused until the backup is restored.
- Push agent: `state/agents.json` is `schemaVersion: 2` (`agents[].device`, `deviceCreatedAt`, and `revokedBy`
  `device-removed` or `device-changed`), and each `state/agent/<id>.json` is `schemaVersion: 2` (`device`). Every
  agent key keeps working. A 1.x hub does not start at all while `state/agents.json` exists (any key issued by 1.x or
  2.0 leaves one); without it, a 1.x hub starts and refuses the reports of every device whose `state/agent/<id>.json`
  2.0 wrote.
- Collector output: `data/systems/snapshot.json` (`devices`), `data/security/ssh-keys.json` (`devices`, and `device`
  in every copy, access target, route, other key, unknown authorized key and stored finding template) and
  `data/security/probes.json` (`extraDevices`) are `schemaVersion: 2`. The hub writes a 1.x file forward when it
  first reads it and keeps the file's time, never over a file the collector wrote since it was read; where it may not write the collectors' directory it reads the file
  forward each time, until the 2.0 collector runs. The trend files (`data/systems/history.jsonl`,
  `state/agent/history.jsonl`) hold `devices` in each line.
- LLM runtimes: `state/runtimes-config.json` is `schema: 2` (`endpoints[].device`), and the request history
  (`state/runtimes/<id>/requests-YYYY-MM.jsonl`) holds `device` and `clientDevice` in each line.
  `scripts/import-runtime-history.mjs` still takes a history file of a 1.x store.
- Inventory: `data/knowledge.json` is `schema: 2`, with the kind and the field `device`.
- Router: `data/router-observations.json` is the UniFi collector's file, and the collector may run on another host,
  its file copied to the hub. The 2.0 collector writes `schemaVersion: 2` with `clients` and `hardware`; the hub
  reads a 1.x collector's file (`devices`, `unifiDevices`) forward on every read and never rewrites it, so a collector
  left on 1.x keeps working. A 1.x hub reads a 2.0 collector's file as no clients.
- The descriptor directory `data/machines/` is renamed to `data/devices/` at the first start, while no
  `data/devices/` exists. A directory named by `DEVICES_DIR` is used as it is.
- The audit files are not rewritten. Lines 1.x wrote about agents and agent keys are shown with the new words.
- A 1.x hub on this state does not start while `state/agents.json` exists (above). Without that file it starts,
  refuses the agent reports and the inventory, shows no SSH key inventory, and reads the snapshot, the runtime
  endpoints and the request history without their devices.

### Upgrade notes

- **Convert the site file, then apply.** 2.0 refuses a 1.x `site.json` and 1.x refuses a 2.0 one, and the update's
  start-up check runs 2.0 on the instance's file, so the file is converted first. The command is in 2.0, not in the
  installed 1.x checkout: run it from a scratch worktree of the tag, right before the update (a 1.x collector or a
  1.x hub that restarts in between refuses the converted file).

  ```sh
  git -C <core> fetch --tags
  git -C <core> worktree add --detach /tmp/hub-2.0.0 v2.0.0
  node /tmp/hub-2.0.0/scripts/convert-site.mjs <config>/site.json    # keeps the 1.x file as <config>/site.v1.json
  git -C <core> worktree remove /tmp/hub-2.0.0
  node <core>/scripts/update.mjs apply v2.0.0
  ```

  `<config>` is the instance's `config/` (or `HOME_HUB_CONFIG_DIR`, or `local/` of the checkout; a
  `HOME_HUB_SITE_CONFIG` names the file itself). A hub without a site file has nothing to convert.
- **Going back to 1.x** (an `apply` that rolls back by itself, or `node scripts/update.mjs rollback --yes` later):
  the rollback restores the archive and starts 1.x, which refuses the converted site file, so the rollback stops
  with exit 3 and leaves the service stopped. Put the 1.x file back and run the rollback again; it goes on from
  where it stopped and does not restore the archive a second time:

  ```sh
  cp <config>/site.v1.json <config>/site.json
  node <core>/scripts/update.mjs rollback        # with the same --service, --health … as the update, if any
  ```

  Restoring `config/` from the archive does not help: the archive was made after the conversion. Changes made to
  the site file under 2.0 are not in `site.v1.json`; make them again in the 1.x form.
- **Update the collectors with the hub.** `scripts/collect-systems.mjs` and `scripts/collect-security.mjs` run from a
  checkout of their own schedule; one left on 1.x does not read a 2.0 `site.json`.
  The UniFi collector (`scripts/collect-router-unifi.py`) may be updated later: the hub reads its 1.x file, and a
  1.x collector finds the gateway through `router.host` (or `UNIFI_HOST`), since it does not read a 2.0 `devices` list.
- **The push agents keep reporting**: the report format and the keys are unchanged. A key file downloaded from 1.x
  (`agent.machine`) is still accepted by the 2.0 installers; the hub now writes `agent.device`.
- **Plugins** must name a core range that holds 2.x (`plugin.json → core`) and move to the new names before the hub
  starts with them. `docs/plugins.md` → Upgrading a plugin from 1.x lists every name, old and new.
- A browser keeps its inventory map layout: one saved by 1.x loads with its column and card order.

## 1.0.0

The first release of Home Hub core: one hub for a household's machines, services, software and work, with an HTTP
API, an MCP endpoint and a plugin contract. Everything below is new in the sense that nothing was released before it.

### Added

- **The hub.** The overview with Thermo and agent-less telemetry, the inventory map and services catalog, software
  versions and host protection, SSH keys, the router census, LLM runtimes and the LLM & Diffusion page, backup jobs,
  the Git LFS view, search, and the integrations page with a switch for everything the hub reads from outside.
- **The tracker and review.** Projects, tickets and features with comments and file attachments (up to 100 MB each,
  with a viewer for text, images, audio and video), and review items.
- **Access.** Sign-in, users and roles, service accounts, scopes and API keys, and an audit of who did what.
- **The MCP endpoint and the HTTP API** (`docs/API.md`).
- **Plugins** (`docs/plugins.md`). A plugin source is a directory of its own with `plugins/<id>/plugin.json` and
  `index.mjs`; a plugin registers routes, scopes, MCP tools, pollers, assets, integrations and sidebar entries, states
  the core range it supports, and imports core only as `home-hub/plugin-api` and `home-hub/testing`.
- **The instance directory** (`HOME_HUB_HOME`, `docs/storage.md`): configuration (`config/site.json`,
  `software-watch.json`, `images/`), data and secrets kept apart from the code, with `instance.json` naming the
  plugin sources, the service and its health check.
- **The push agent** for macOS, Linux and Windows (`docs/agent.md`). A machine reports its system and updates, the
  watched software, SSH keys and local LLM runtimes to the hub with a key of its own; the pages say whose record they
  show. `node scripts/install-host-agent.mjs --core` installs it as a launchd agent, a launchd daemon that runs from
  boot (`--service launchd-daemon`) or a systemd system service; `install-agent.ps1` installs it on Windows. The hub
  also checks every minute whether each machine's address answers.
- **Versions and updates.** The version in the footer, the manifest, the MCP `serverInfo` and `<state>/run.json`; an
  update check that only tells (`HOME_HUB_UPDATE_CHECK=off` turns it off); and `node scripts/update.mjs apply <tag>`
  (`docs/updating.md`), which checks, stops, archives, switches, starts, and puts the previous version back on any
  failure.
- **Release tooling.** `node scripts/release.mjs`, the leak scan (`node scripts/leak-scan.mjs`) and the pre-push hook
  that refuses to publish a household value.

### Deprecated

All of these keep working through 1.x and are removed in 2.0.

- **The in-tree overlay `local/` as the default** for the site configuration (`local/site.json`,
  `local/software-watch.json`, `local/images/`) and the plugins (`local/plugins/`). Keep them outside the code: an
  instance directory (`HOME_HUB_HOME`), or `HOME_HUB_CONFIG_DIR` and `HOME_HUB_PLUGINS_DIR`.
- **`edition.json`**, `HOME_HUB_EDITION` and `server/edition.mjs` (`readEdition`, `isPublicRelease`; `readEdition` is
  also exported by `home-hub/testing`). The file stays `{"edition":"public"}` and nothing new reads it.
- **The export**: `scripts/export-public.mjs`, `scripts/publish-public-branch.mjs`, `npm run export:public` and the
  private mode of `scripts/release.mjs`. Run by hand, the two scripts say so.
- **A plugin without `plugin.json`** still loads, with a warning; 2.0 will require the file.

### Upgrade notes

- **The agents do not update themselves.** A newer agent reaches a machine when its installer is run again from a
  newer checkout.
- **Not yet verified on a real machine:** the launchd daemon on a Mac; on Windows, an install whose health check
  passes on the machine itself, and the Windows Update search, which Windows refuses to `LocalService` (the update
  check then shows `unknown`); and the items each first-run checklist in `docs/agent.md` marks as not tried.
