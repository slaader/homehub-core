# Storage

Everything Home Hub keeps is a file on the computer that runs it, under its state and data directories (`STATE_DIR`, `DATA_DIR`).

## Where everything is

`server/paths.mjs` is the one place that decides it; the server, the scripts and the collectors all ask it. With none
of these variables set every path is the checkout's own, as it always was. With `HOME_HUB_HOME` an **instance
directory** holds everything a deployment owns, so the code checkout holds code only and can be replaced by an update.

| Variable | With `HOME_HUB_HOME` | Without it |
|---|---|---|
| `HOME_HUB_CONFIG_DIR` (household configuration: `site.json`, `software-watch.json`, `images/`) | `<home>/config` | `<checkout>/local` |
| `HOME_HUB_SITE_CONFIG` (`none` = no file) | `<config>/site.json` | `<checkout>/local/site.json` |
| `DATA_DIR` (inventory, collector output) | `<home>/data` | `<checkout>/data` |
| `STATE_DIR` (what the hub writes) | `<data>/state` | `<data>/state` |
| `HOME_HUB_PRIVATE_DIR` (secrets) | `<home>/private` | `<checkout>/private` |
| `AUTH_FILE` | `<private>/auth.json` | `<checkout>/private/auth.json` |

A variable that is set always wins over the default another one derives (`HOME_HUB_HOME` with an explicit `DATA_DIR`
keeps the data where `DATA_DIR` says). Every file in `private/` that has its own variable (`INTEGRATION_SECRETS_FILE`,
`RUNTIME_TOKENS_FILE`, `GIT_LFS_TOKENS_FILE`, `THERMO_HOSTS_FILE`, `BACKUP_KEYS_DIR`, `GITHUB_TOKEN_FILE`, `TLS_KEY`,
`TLS_CERT`, `HOME_HUB_SECRET_KEY_FILE`) defaults to its name in the private directory. The UniFi collector
(`scripts/collect-router-unifi.py`) keeps `router-private/` in `HOME_HUB_HOME` (or `HOME_HUB_ROOT`) and writes its
snapshot to `DATA_DIR` when that is set. `sh scripts/systems/install-launchd.sh --home <home>` gives the collector jobs
the same instance.

A plugin keeps its own files in `hub.pluginData(id)`: `<data>/plugins/<id>/` (0700, made on first use), never in its
code directory.

| Where | What | Format |
|---|---|---|
| `state/hub.db` (+ `-wal`, `-shm`) | Tracker (projects, releases, epics and tickets with comments and history), Wiki spaces and trees, documents, asset records, import grants, uploads and retry receipts, the review index (sets → rounds → items → feedback, blob metadata), browser sign-in sessions, the full-text search index | SQLite, `node:sqlite` built into Node, no npm package |
| `state/wiki/blobs/` | Verified wiki asset payloads keyed by SHA-256. Multiple wiki assets can share a payload. Include this directory and `hub.db` in the same backup | files, 0600 |
| `state/wiki/uploads/` | Private resumable uploads and staged large wiki documents. Expire after 24 hours | files, 0600 |
| `state/review/blobs/` | Review files (mockups, images, `.glb`), content-addressed by sha256 | files |
| `state/access.json`, `state/app-tokens.json` | Users and their roles, custom roles, service accounts, API keys, per-account preferences, app tokens (hashes only; `{schemaVersion: 2, tokens}`). Legacy `device-tokens.json` and `device-tokens-audit.jsonl` files are moved to `app-tokens.json` and `app-tokens-audit.jsonl` once, at startup | JSON |
| `state/agents.json`, `state/agent/` | Push agent keys (hashes only, each bound to one device; `schemaVersion: 2`), and per device (`agent/<device>.json`, `schemaVersion: 2`) the latest copy of each part its agent reported, with the hub's receive time (0600, directory 0700); `agent/history.jsonl`, the agents' trend (one line per device at most every six hours, at most 3000 lines) | JSON / JSONL |
| `state/compute/`, `state/thermo/`, `state/windows/`, `state/linux/` | Telemetry history, one line per sample (`windows/`: Windows over SSH or WinRM; `linux/`: Node Exporter, Prometheus or SSH; a device that switches within a family keeps its history) | JSONL, monthly files |
| `state/home/` | Devices added on the overview (`devices.json`), their telemetry logins (`thermo-hosts.json`), Windows SSH connections (`windows-hosts.json`) and the other agent-less connections (`telemetry-hosts.json`: WinRM, Node Exporter, Prometheus, Linux SSH; holds the WinRM password, a Node Exporter's Basic password and a Prometheus password or bearer token; **this file and `thermo-hosts.json` are sealed**, see Secrets at rest), and which devices of the site configuration are read through one of them (`site-telemetry.json`: id, provider, platform, who and when; no secrets; their connections are in the two files above under the same id; `site.json` is never written), and the owner's display edits of those devices over the site's values (`site-overrides.json`: name, hostname, ip, hardware, picture, who and when; their uploaded picture in `images/`), all 0600 | JSON |
| `state/home/ssh/` | **Private SSH keys** of the hub's Windows and Linux SSH connections, each connection's verified host key, an empty ssh configuration (directories 0700, files 0600; on Windows an ACL for the hub's account and SYSTEM only) | PEM / OpenSSH text |
| `state/backup-jobs/` | Backup jobs (`jobs.json`, 0600), per job `<id>/runs.json` (≤ 200 runs, the last snapshot listing and free space), `<id>/logs/<run>.log` (≤ 256 KiB each), `<id>/run.lock`, and `<id>/staging/` (the hub's mirror of a source on another computer) | JSON / text |
| `state/*-audit.jsonl` | Audit logs, among them `app-tokens-audit.jsonl` (app tokens issued and revoked) and `agent-audit.jsonl` (the push agents' refusals and changes) | JSONL |
| `state/integrations.json` | Which integrations an administrator turned off | JSON |
| `state/updates.json` | The update check: the newest release it found, when, the ETags of GitHub's answers, a dismissed release (0600). Deleting it costs one full check | JSON |
| `state/run.json` | Written at every start: `{version, commit, exact, dataEpoch, pid, startedAt, plugins}` (0600). Not state to back up: it says what is answering right now | JSON |
| `state/runtimes-config.json`, `state/runtimes/<device>/` | The LLM runtime endpoints added through the API (`{schema: 2, endpoints}`), and the hub's own request history of the runtimes it reads, `requests-YYYY-MM.jsonl` per device | JSON / JSONL, monthly files |
| `data/` | Inventory (`knowledge.json`, `{schema: 2, updated_at, entries}`), collector output (`systems/snapshot.json` and `security/ssh-keys.json`, both `schemaVersion: 2`, each with its trend or probe file; `router-observations.json`, the UniFi collector's `{schemaVersion: 2, clients, hardware, …}`), the collected device descriptors (`devices/<id>.json`; `DEVICES_DIR`) | JSON |
| `data/security/probes.json` | Written by `scripts/collect-security.mjs` beside `ssh-keys.json` (0600; `schemaVersion: 2`): each device's raw probe output with `probedAt` (fingerprints, paths, public `authorized_keys` lines, `ssh -G` routes, `sudo -l` rules; never a private key), Forgejo and the router entry, so the hub can join the push agents' records | JSON |
| `data/plugins/<id>/` | A plugin's own files (`hub.pluginData(id)`) | the plugin's |
| `private/` | `auth.json` (the owner's hash and `passwordAt`; written by `scripts/setup.mjs`), TLS key, tokens; `backup-jobs/<id>/` (0700): each backup job's ed25519 key pair (private key 0600), its generated `ssh_config` and `known_hosts` with the pinned host keys | JSON / PEM |

Wiki attachments and upload reservations use a default budget of 20 GiB. Set `WIKI_MAX_BYTES` to
override it, or use `REVIEW_MAX_BYTES` for the same configured ceiling in each store. The wiki keeps
unreferenced assets for seven days and only deletes a payload once every wiki asset using it has
expired. Review stays usable when a wiki reference goes away. The normal updater backup covers both
wiki directories and their metadata under `STATE_DIR`.

## hub.db

`server/db.mjs` opens one connection per process (WAL mode, `0600`). The stores keep their document model:

- `docs(kind, coll, id, doc)`: one JSON document per ticket, epic, release, project, wiki space, wiki page, wiki page summary, review set or blob, plus
  `meta(kind, doc)` for the counters (`revision`, `next`). A write runs the store's validation on the loaded
  document, then saves **only the rows that changed** and their search entries in one transaction. A
  validation error writes nothing. Optimistic `rev` checks and the per-store write queue are unchanged.
- `sessions(hash, user_id, password_at, until)`: the SHA-256 of each `homehub` cookie token, never the token.
  Sessions expire 12 hours after sign-in and end when the user's `passwordAt` moves (password change or reset).
- `search`: an FTS5 table (`unicode61 remove_diacritics 2`, prefix indexes) filled by the stores. Bump
  `SEARCH_VERSION` in `db.mjs` when the indexed text changes; the index is rebuilt at the next start.
  Readers: `db.search({q,kind,project,limit})` (plain words, each a prefix; a query that is an id ranks that
  record first), `db.searchStats()` (documents per kind, so a client can tell an empty index from no match) and
  the ticket store's `search()`, which filters the hits by ticket fields. None of them changes the schema.
- `PRAGMA user_version` is the schema version. Newer code migrates forward; older code refuses a newer file
  rather than misreading it.
- Schema 6 (data epoch 11) gives every tracker project row `settings` with its defaults (`color:null, view:'board'`,
  the rest `true`); only rows without it change, and their `rev` and ticket counter stay. Releases before
  epoch 11 refuse the file; going back needs the pre-update backup.
- Schema 7 (data epoch 12) adds `labels`, `nextEpic` and `projectVersion: 1` to existing projects, preserving
  their revision and ticket counter. It records the owning project separately from the Wiki space ID (Wiki
  schema 5), preserving page and asset keys. New projects start at version 2. The optional project wizard
  changes project features and their data after database migration. Rolling back to epoch 11 restores the
  pre-update backup.


Query by hand (read-only is enough; the server may keep running):

```bash
sqlite3 -readonly state/hub.db "select id, json_extract(doc,'$.title') from docs where kind='tickets' and coll='tickets'"
sqlite3 -readonly state/hub.db "select kind, id, title from search where search match '\"prihlas\"*'"
```

## Migration from the JSON files

On first use each store imports its old file once, `state/tickets/tickets.json` and `state/review/review.json`,
then renames it to `*.migrated`. A file that does not parse or has the wrong shape is refused and left untouched,
and the store does not start with an empty tracker. To roll back to code from before hub.db: stop Home Hub, rename the
`*.migrated` files back (any change made since lives only in hub.db) and deploy the older commit.

## Stored-file compatibility

Core reads supported legacy state and collector files without invalidating agent keys; `server/state-forward.mjs` holds the field mappings.

## Backups

A backup of the state directory contains `state/home/ssh/`, the private keys the hub signs in to Windows with.
Keep it as private as `private/`. Restoring without it leaves those connections failing with `key-missing`
until a key is created again in the device dialog (and authorized on Windows).

Back the state directory up with Home Hub stopped: the database is then closed and consistent, and the
`-wal` file, if present, is copied with it. Do not copy `hub.db` from a running server with `cp`. Use
`sqlite3 state/hub.db ".backup /path/copy.db"` instead.

`node scripts/update.mjs backup` does exactly that for the whole instance (stop, archive `config/`, `data/`, the state
directory and `private/` into one 0600 file, start), and `apply` does it before every update (`docs/updating.md`).
Those archives hold every secret of the instance: `<home>/backups/`, or `backups/` in the checkout, is as private as
`private/`. The update command's own files are `update-journal.json` and `update.lock` (in the instance directory,
else in `backups/`) and `state/update-history.jsonl`, one line per update: `{at, id, from, to, by, seconds, result}`.

Restart Home Hub through the service manager configured for your installation. `state/` is gitignored, so
changing code does not replace the database, and sessions survive the restart. See [updating.md](updating.md).

### Secrets at rest

`state/home/thermo-hosts.json` (Thermo logins) and `state/home/telemetry-hosts.json` (WinRM, Node Exporter and
Prometheus passwords and tokens) are **sealed**: AES-256-GCM over the whole document, the file's purpose bound in as
additional data (`server/secret-box.mjs`). A copy of `state/` (a backup, a bundle, a mistaken commit) holds no
usable secret. The key is kept apart from the data; new files are sealed with the first source that applies:

1. `HOME_HUB_SECRET_KEY`: 64 hex characters (containers, a service manager's secret store, tests);
2. the macOS login **Keychain**, only with `HOME_HUB_SECRET_KEYCHAIN=1`: generic password, service `Home Hub`,
   account `secret-key`, handed to `security -i` on stdin (never on a command line). It needs the login keychain
   unlocked, which a LaunchDaemon after a reboot may not have; that is why it is not the default;
3. a **key file**: `HOME_HUB_SECRET_KEY_FILE`, else `secret.key` next to `AUTH_FILE` (`private/secret.key` by default;
   a preview with its own `AUTH_FILE` gets its own key and never sees the production one). 0600, created on first use,
   exclusively through a hard link (two processes agree on one key; a filesystem without hard links reports
   `SECRETS_LOCKED`: set `HOME_HUB_SECRET_KEY` there).

Nobody has to handle the key: the hub makes it, seals and opens with it. It lives in `private/` next to the
sign-in file, so updates, deploys and restarts never touch it, and a reinstall that keeps `private/` keeps it.

A sealed file is opened with the key of the source it names (`kid`) first, then with any other key that is there.
Each file also carries a fingerprint of its key (`kfp`, 64 bits of a hash; nothing about the key itself), and
`state/home/secret-key.json` records the fingerprints of the key files the files there were sealed with (the last 16)
and the key file in use; it is written before the sealed file.

When no key opens a file:

- **Reading** (pollers, dialogs) treats it as empty: its devices show "no login". The file is not touched, so a key
  that comes back (a volume mounted late, `private/` restored) makes everything work again.
- **The SSH key sweep** is skipped while the file cannot be read, so no SSH key is deleted meanwhile.
- **Saving or removing a login** sets the file aside (`<name>.lost-<time>`, never deleted) and goes on with a new key,
  but only when the loss is certain: the file was sealed with a key file the marker knows, no key file holds that
  key, and either the key file in use is the marker's and its directory is there (a reinstall that kept `state/` but
  not `secret.key`) or the marker's key directory is gone altogether (the hub moved). The owner then just enters the
  password again; the other file, sealed with the same lost key, goes aside the same way on its first change. In
  every other case (a launch with another key path while the marker's directory is still there, an unmounted volume,
  a locked or turned-off Keychain, another `HOME_HUB_SECRET_KEY`, a damaged file) nothing moves and the change is
  refused with `503 SECRETS_LOCKED` until the key is back.

A plain file from an older hub (or one sealed before files named their key) is read as before and sealed again on
first read (retried every ten minutes while no key can be made).

- Moving a hub to another computer with its passwords: carry `private/` along (or set the key as `HOME_HUB_SECRET_KEY`
  there). Without it the devices just need their passwords again.
- A container with a read-only `private/` cannot make its key: create it outside (`openssl rand -hex 32`, 0600, owned
  by the container's user) or pass `HOME_HUB_SECRET_KEY`.
- Sealing protects copies of the files (confidentiality). Someone who can already write `state/home/` as the hub's
  account can also put a plain file there; that is outside what it defends against.
- Older backups or snapshots of `state/` taken before sealing still hold these passwords in plain text: change
  those passwords, or delete those copies.
- Not sealed (yet): the SSH private keys in `state/home/ssh/` and `private/backup-jobs/` (OpenSSH reads them as
  files) and `private/git-lfs-tokens.json`. They rely on the file permissions below.

`private/integrations.json` (write-only plugin integration settings) is also sealed with the same key sources, with its own authenticated purpose. Its decrypted document is schema 2; plaintext schema 1 is atomically sealed on readiness before requests or pollers run. Unlike telemetry logins, a locked, corrupt or newer integration store stops startup and is never reset automatically. Restore the original key/file before restarting. Backups of the encrypted file must retain the key separately; an archive containing both the ciphertext and `private/secret.key` must itself remain private.

The files in `state/home/` use owner-only permissions: POSIX mode 0600 under a 0700 directory; on Windows, an explicit DACL permits only the Home Hub account and SYSTEM. New files are protected before the atomic rename, including `telemetry-hosts.json` passwords and tokens.

Ticket hybrid search stores a disposable derived SQLite cache under `<state>/tickets/search/`.
Schema 1 is covered by data epoch 4; canonical tickets and attachment blobs are unchanged.
An earlier store without a cache opens normally and builds it asynchronously. Newer cache
schemas are refused. Use the pre-update archive for rollback across data epochs. Search caches
contain ticket and attachment text and require the same private storage protection as tickets.

The `platform-search` collection metadata in `hub.db` stores schema 1 `{enabled: boolean}`,
initially false. It is an administrator's explicit permission to send ticket/accepted text to
the configured embedding provider. It stores no URL, model or token. Provider configuration
stays in the service environment. This addition is covered by data epoch 4.

### Update recovery metadata

`<home>/update/trust.json` is an operator-controlled public-key trust policy, outside every restored application
root. Revocations are never rolled back. The schema-1 `update/trust-required.json` remembers selection of an independent policy so deleting the policy cannot silently revive legacy updates. `<home>/update/drivers/<transaction>/` retains the trusted package-update
driver. `update.lock` is now an ownership-token lock directory; stale directories and legacy PID files require manual
maintenance after all updater/child activity has stopped. The schema-2 `update-journal.json` records per-source and
per-root recovery progress and reads schema 1 explicitly. Backups have private `.manifest.json` and `.integrity.json`
sidecars; failed roots remain adjacent to their destinations with an index under the backups directory. These formats
raise the data epoch to 5. `.home-hub-package.json` inside a package core is an updater-written schema-1 receipt of
the exact signed manifest digest and full release commit. See [updating.md](updating.md) for supported layouts and
external key/plugin-state recovery prerequisites.
