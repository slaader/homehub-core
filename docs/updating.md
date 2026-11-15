# Updating

Home Hub never updates itself. It tells you that a newer release exists (the card "Home Hub update check" on
Administration → Integrations, and the footer for an administrator); **a command applies it**, run on the server by
whoever may restart the service:

```sh
node scripts/update.mjs status              # what is installed and running, the newest tag, the last update
node scripts/update.mjs preflight v1.3.0    # every check that needs no change to the instance
node scripts/update.mjs apply v1.3.0        # preflight, stop, archive, switch, start, health check; back on any failure
node scripts/update.mjs rollback            # undo the last update
node scripts/update.mjs backup              # only the archive (stop, archive, start)
```

Without a tag, `preflight` and `apply` take the newest release tag after a fetch. `--to v1.3.0` is the same as the
bare tag. There is no button and no MCP tool for any of this, on purpose: the hub holds SSH keys and tokens for other
devices, and a web request that can replace its code would turn a stolen session into code execution with them.

The original commands below operate on a Git checkout; signed packages are described later in this page. A container is rebuilt instead: [docker.md](docker.md).

## Tell it about your installation

The command has to know three things that are not in the code: where the instance's files are, how its service is
stopped and started, and where it answers.

**With an instance directory** (`HOME_HUB_HOME`, [storage.md](storage.md)) they are in `<home>/instance.json`, next to
the plugin sources that file already names:

```json
{"schemaVersion": 1,
 "sources": {"core": "core", "plugins": ["household"]},
 "service": "launchd:system/com.example.home-hub",
 "health": {"url": "http://127.0.0.1:8781/healthz", "seconds": 60},
 "backups": {"keep": 5}}
```

```sh
HOME_HUB_HOME=/srv/home-hub node /srv/home-hub/core/scripts/update.mjs apply
```

**With everything in the checkout** (the default layout) they are flags, the same on every call:

```sh
node scripts/update.mjs apply v1.3.0 \
  --service launchd:system/com.example.home-hub \
  --health http://127.0.0.1:8781/healthz
```

| What | `instance.json` | Flag | Default |
|---|---|---|---|
| The core checkout | `sources.core` (a directory of the instance) | `--root DIR` | the checkout this script is in |
| Plugin sources | `sources.plugins` | (`HOME_HUB_PLUGINS_DIR`); `--add-plugin-source NAME` stages an addition | `local/plugins` in the checkout |
| Replacement site for the target | | `--site-config FILE` (preflight/apply) | the current site; pre-1.0 core keys are converted in staging |
| The service | `service` | `--service SPEC` | none: `apply`, `rollback` and `backup` refuse without it |
| Where it answers | `health.url`, `health.seconds` | `--health URL`, `--health-seconds N` | none; 60 s |
| Archives | `backups.keep` | `--backups DIR`, `--keep N` | `<home>/backups`, else `<checkout>/backups`; the newest 5 |
| Instance directory | | `--home DIR` or `HOME_HUB_HOME` | none |
| Data, state, secrets | | `--data`, `--state`, `--private`, or `DATA_DIR`, `STATE_DIR`, `HOME_HUB_PRIVATE_DIR` | as the server resolves them |

A flag wins over `instance.json`. **The paths must be the ones the service runs with**: when its unit sets `STATE_DIR`
or `DATA_DIR`, give the command the same values. It checks this before it touches anything: an `apply` refuses unless
`<state>/run.json` exists, names a live process of the installed version, and the health address answers.

`service` is one of:

| Form | Stop | Start |
|---|---|---|
| `launchd:system/<label>` | `launchctl bootout system/<label>` | `launchctl bootstrap system /Library/LaunchDaemons/<label>.plist` |
| `launchd:gui/<uid>/<label>` (or `user/<uid>/…`) | `launchctl bootout gui/<uid>/<label>` | `launchctl bootstrap gui/<uid> ~/Library/LaunchAgents/<label>.plist` |
| `systemd:<unit>` | `systemctl stop <unit>` | `systemctl start <unit>` |
| `systemd-user:<unit>` | `systemctl --user stop <unit>` | `systemctl --user start <unit>` |
| `{"stop": ["…"], "start": ["…"]}` (as a flag: `command:{"stop":[…],"start":[…]}`) | the first command | the second |

A system service (`launchd:system/…`, `systemd:…`) is driven through `sudo -n` unless the command runs as root, so
the account needs a sudoers rule for exactly those commands. Commands run without a shell. The health address is the
hub's own `/healthz` on its local port, not the reverse proxy in front of it.

## What `apply` does

| # | Step | If it fails |
|---|---|---|
| 1 | Takes exclusive locks. Reconciles an unfinished transaction before doing anything new. | stops |
| 2 | Checks that the hub is running the installed version and that the health address answers. | stops |
| 3 | `git fetch --tags`; resolves the target. Refuses a lower version, a tag whose `package.json` says another version, a checkout with changed tracked files, a release that was rolled back here before (`--force` tries again), and, when the installed checkout has `config/release-signers`, a tag without a good signature (`--allow-unsigned`). | stops |
| 4 | Checks out the target in a scratch worktree (`<home>/staging/`, else the temp directory), with every plugin source beside it. From those files: each plugin's `core` range must include the target version, each `requires` must be met, the Node version must fit, and the data epoch is compared. | stops, naming the plugin |
| 5 | In the scratch worktree: the target's `npm test`, each plugin source's tests separately with its own fixture site against the target core, then `node server/index.mjs --check` with **this instance's** secrets and plugins, and its site file (a staged copy when configuration changes). The worktree is removed. | stops; nothing was touched |
| 6 | Writes the journal, stops the service, waits for its process to exit. | starts it again |
| 7 | Archives `config/` (an instance directory), `data/`, the state directory and `private/` into `pre-<from>-to-<to>-<time>.tgz` (0600) and lists it back. The hub is stopped, so the SQLite file is closed and consistent. A backup job's `staging/` mirror and `*.tgz` files are left out. A site being replaced is also saved separately, even outside these directories. | starts the old version |
| 8 | `git checkout --detach <tag>` in each source that changes. Atomically install any replacement site configuration checked in step 5. | rolls back |
| 9 | Starts the service. Within `health.seconds` readiness must begin, then pass ten consecutive seconds with the exact process, build and plugin identity. | rolls back |
| 10 | Marks the journal done, appends to `<state>/update-history.jsonl`, removes archives beyond `backups.keep`. | |

After an update the checkout is on a detached tag, not on a branch: `git pull` no longer applies, the next update is
another `apply`.

**Rolling back** (automatic from step 6 on, or `rollback` later) stops the service, switches each source back to the
commit it was on (and onto its branch, when that branch still names that commit), starts it, and runs the same health
check for the old version. A release that failed is noted in `<state>/updates.json → quarantined`; the update card
then says "tried on … and rolled back", and `apply` refuses it without `--force`. An update that was only interrupted
(Ctrl-C, a lost session) is put back without that note. If the old version does not come up either, the command
stops, leaves the service **stopped**, exits 3 and prints the journal, the archive and the history file. It does not
loop; `rollback` tries again once the cause is fixed.

When the update replaces the site configuration, it keeps the original bytes in a 0600 sidecar next to the
archive (`<archive>.site.json`), including a site selected by `HOME_HUB_SITE_CONFIG` outside an instance directory.
The journal records the path and hash before replacement. Rollback restores the original site before starting the
old code, even if the new version never started. The original file permissions are preserved. A crash between the
file rename and the next journal write is recoverable too. Later site edits are lost when this original is restored.

For another configuration change needed by the target plugins, prepare a separate candidate file and pass
`--site-config /path/to/candidate.json` to both `preflight` and `apply`. The candidate is checked with the target,
while the live file stays unchanged until the service has stopped and its original state is archived. The candidate
file is no longer needed for rollback. A site changed by another process during preflight makes the update refuse;
refetch it and prepare the candidate again. The separate `--add-plugin-source` option stages additions to the instance source list (below). Other
configuration changes need their own migration plan.

To add a separate plugin repository during an upgrade, first prepare its inactive checkout at `<home>/<name>`.
Do not add it to the live `instance.json` yourself: its plugins might require the new core and prevent the old
service from restarting. Include both of these options in the same preflight/apply command:

```sh
--add-plugin-source public-plugins --plugins public-plugins=v1.0.0
```

`--add-plugin-source` is repeatable. It needs an existing instance with an explicit `sources.plugins` list, no
`HOME_HUB_PLUGINS_DIR` override, and an explicit target tag for each added source. Preflight stages all existing and
added sources together and checks their core ranges and dependencies. It runs each source's tests independently
with that source's fixture, then checks all target sources together with the staged real site. The
source list is appended only after stop/archive. The original `instance.json` is saved as a 0600
`<archive>.instance.json` sidecar and journalled before replacement, then restored before an old-code restart on
failure or rollback. A changed manifest during preflight is refused. The inactive checkout remains on disk after
rollback, but the old hub no longer loads it. This option does not change the core location, service commands,
health settings, or remove existing sources.

Exit codes: 0 done; 1 refused, or failed and put back; 2 usage; 3 the rollback failed.

### Moving from a pre-1.0 build

Builds that ran before 1.0.0 carried other version numbers, some of them higher than 1.0.0. `update.mjs` never applies
a version lower than the one that is running, so a hub on such a build is switched **by hand, once**. When its
data epoch is 4 or 5 (`package.json → homeHub.dataEpoch`; 1.0.0 is 5), no site file changes are needed and state moves
forward by itself the first time 1.0.0 opens it, so the archive of step 1 is what going back needs:

1. `node scripts/update.mjs backup` (stop, archive, start), so there is an archive to go back to.
2. Check the `core` range in each plugin source's `plugin.json` and `package.json`: core refuses to start with a
   plugin outside its range, and a plugin written for a pre-1.0 build names a range that does not hold 1.0.0.
3. Stop the service, `git fetch --prune --prune-tags --force`, `git checkout v1.0.0`, start the service.
4. Check `/healthz`, that the footer reads `1.0.0` (not `1.0.0+dev`), and `node scripts/update.mjs status`.

Going back is `git checkout` of the previous commit and, when the epoch differs, a restore of the archive from step 1.
From 1.0.0 on, every update is `apply`.

A hub older than that (data epoch below 4, or a site file with the pre-1.0 key names) is moved with the update driver
below, which converts the site file in a staged copy.

Before 1.0 `site.json` named devices `machines` (`runtimes[].machine` for `runtimes[].device`). Use the **1.0
update driver from a separate verified checkout**, with `--root` naming the real deployment checkout. The updater of
such a build cannot perform this transaction. Keep the driver checkout until the update and its rollback window are
finished, and use that same driver for recovery. The hub service continues to run from the deployment checkout.

With an instance directory (use the same environment as the service):

```sh
git -C <core> fetch --tags
# Verify the release tag against your trusted release signers before executing its code.
git -C <core> worktree add --detach /tmp/hub-update-driver v1.0.0
HOME_HUB_HOME=<home> node /tmp/hub-update-driver/scripts/update.mjs preflight v1.0.0 --root <core>
HOME_HUB_HOME=<home> node /tmp/hub-update-driver/scripts/update.mjs apply v1.0.0 --root <core>
```

For an installation without `HOME_HUB_HOME`, pass the service, health, data, state, secrets and site settings the
service uses, as described above. Compatible plugin releases belong in the same command with
`--plugins <source>=<tag>`. A new repository also needs `--add-plugin-source <source>`; its checkout must already
exist under the instance directory. If their settings also changed, pass a separately prepared `--site-config` candidate;
the automatic conversion only knows core's two renamed keys. Do not convert the live site before `apply`.

The driver converts the known pre-1.0 keys in a staged copy and validates it with 1.0. A refused preflight leaves the
running hub and its collectors' configuration intact. A failed start automatically restores old code, data when
required, and the original site before restarting the old build. To undo a successful update, or recover after the driver's
process was interrupted:

```sh
HOME_HUB_HOME=<home> node /tmp/hub-update-driver/scripts/update.mjs rollback --yes --root <core>
```

Use the same path/settings flags as the update when there is no instance directory. `--yes` acknowledges restoring
the pre-update data after an epoch rise. Once the update is accepted and recovery is no longer needed, remove the
driver worktree with `git -C <core> worktree remove /tmp/hub-update-driver`.

`convert-site.mjs` remains an offline file-conversion utility, with a `site.v1.json` copy for manual work. It is not
the upgrade or rollback driver and must not be run against a live pre-1.0 site's file before updating.

## The data epoch: when going back needs the archive

State migrates forward when newer code first opens it, and older code refuses newer state. `package.json →
homeHub.dataEpoch` (and a plugin's `plugin.json → dataEpoch`) rises in any release that changes a format on disk; the
changelog says so under **Data**. The preflight states which case this is:

| From → to | Going back |
|---|---|
| Same epoch (every patch, most minors) | The code switches back. Nothing written since is lost. |
| The epoch rose | The code switches back **and the pre-update archive is restored**. Everything written after the update is lost. Replaced roots remain in unique adjacent `.failed-*` paths, indexed under `<backups>/failed-<time>/roots.json`. |

An automatic rollback restores without asking (the new version ran for seconds). A later `rollback` after a rise
needs `--yes`, and refuses when the archive is gone.

A restored archive brings back `state/agents.json` as it was: a push agent key revoked after the archive was made works
again. Revoke such keys again after a restore (`GET /api/admin/agents`, `POST /api/admin/agents/revoke`).

## Plugin sources

A plugin source that is a git checkout of its own (an instance's `sources.plugins`) is switched in the same
transaction, by its own tag: one preflight, one archive, one restart, one rollback.

```sh
node scripts/update.mjs apply v1.3.0 --plugins v1.1.0            # core and the only plugin source
node scripts/update.mjs apply --plugins household=v1.1.0         # only that source; core stays
```

The core range check holds in every combination: a plugin that does not support the target core stops the preflight
with its name, and so does a plugin tag that needs a newer core than the one installed. Plugins inside the checkout
(`local/plugins`) travel with it; when they are not tracked there, they are copied into the scratch worktree for
the checks.

## An interrupted update

The journal (`<home>/update-journal.json`; without an instance directory `<checkout>/backups/update-journal.json`)
is written before every step. If the command dies, `status` says `UNFINISHED`, and the next `apply` or `rollback`
first puts the previous version back from the journal: nothing new is applied in that run. A second update cannot
start meanwhile (`update.lock`, retained after a crash until explicit manual maintenance; see Recovery guarantees and limits).

## Rehearsing the rollback

Worth doing once per installation: it proves that the service commands, the health address and the paths are right
before a real release depends on them. Make a local tag that passes its tests and exits when started, apply it, watch
it come back, delete the tag. Nothing is pushed. The tag carries a version that will never be released (here
`1.2.999`: a plain version, because a pre-release such as `1.2.1-rc.1` is outside every plugin's core range and would
fail the tests instead of the start).

```sh
cd /srv/home-hub
git worktree add --detach /tmp/hub-rehearsal v1.2.0 && cd /tmp/hub-rehearsal      # the release that is installed
sed -i.bak 's/"version":"1.2.0"/"version":"1.2.999"/' package.json && rm package.json.bak
awk '!d&&/^## /{print "## 1.2.999\n\nA rehearsal: this build exits when it is started.\n";d=1}1' CHANGELOG.md > c && mv c CHANGELOG.md
printf '\nif(process.argv[1]===fileURLToPath(import.meta.url))setTimeout(()=>{console.error("rehearsal build: exiting");process.exit(1);},300);\n' >> server/index.mjs
git -c user.name=rehearsal -c user.email=rehearsal@example.invalid commit -qam 'rehearsal: exits at start'
git tag v1.2.999 && cd /srv/home-hub && git worktree remove --force /tmp/hub-rehearsal

node scripts/update.mjs apply v1.2.999 --no-fetch --health-seconds 20 --service … --health …
#   → "failed at "starting": health check failed … It was rolled back", exit 1, and the old version answers
node scripts/update.mjs status --service … --health …
git tag -d v1.2.999
```

Delete the tag right away: while it is there, a bare `apply` would take it for the newest release. The note
`quarantined → 1.2.999` stays in `updates.json`; it names a version that will never be released, so nothing shows it. The archive it made counts toward `backups.keep`.

## Limits

- The tests of step 5 run in a fresh worktree with only operating-system and toolchain environment settings (paths,
  home and temporary directories, locale, and Windows process/profile settings). Live service and plugin settings,
  credentials, sockets and Node injection settings are excluded. The final `--check` retains the full instance
  environment with its staged configuration and plugins. Plugin tests that need files which are not in git (a household's
  data, generated media) fail there; `--skip-tests` skips step 5's test runs (not the `--check`) when you have run
  them where those files are.
- The Node that runs the command is the one whose version is checked and that runs the tests; start the command with
  the Node the service uses.
- A relative `DATA_DIR`, `STATE_DIR` or `AUTH_FILE` is resolved against the directory the command is run in.
- The command does not install or update host agents on other devices (`scripts/install-host-agent.mjs` does, on
  the device in question).

## Operator trust and signed packages

Signed packages sit beside the Git commands, which keep their legacy semantics (data epoch 5):
without independently configured trust they display `legacy-unverified` or legacy-policy warnings. An installed
`config/release-signers` is still used by the legacy path, and its existing `--allow-unsigned` override remains.
These updates are **not authenticated by the new operator trust policy**. Bare `apply` still selects the highest
stable local tag after fetching. `--latest-published` instead uses the UI's repository, channel and published
release selector (drafts excluded; prereleases only in the prerelease channel).

A policy selected with `--trust FILE`, or present at `<home>/update/trust.json`, is mandatory for that operation.
Invalid, missing, revoked or unauthorized keys and bad signatures refuse the operation; `--allow-unsigned`,
`--force` and `--skip-tests` never bypass it. Every package operation requires signature verification. Making trust
mandatory for old Git commands remains a separately agreed breaking change; historical tags are not rewritten.

Trust schema 1 has `publishers`, keyed by `owner/repository`. Each publisher has `gitSigners` and `packageKeys`
arrays; every record has `id`, `publicKey`, `fingerprint`, `role` (`git` or `package`), `status` (`active`, `retired`,
`revoked`), optional `minimumVersion`/`maximumVersion` and public `provenance`. Package keys are Ed25519 SPKI PEM;
the ID and expected fingerprint are the lowercase SHA-256 of SPKI DER. Git signers are SSH Ed25519 public keys;
the ID is the lowercase SHA-256 of the SSH key blob, and the fingerprint is the usual `SHA256:…` OpenSSH form.
No trust is obtained from a release, hosting badge, package, downloaded key, or restored backup. Core authorization
does not authorize a plugin publisher; plugin source package.json uses `homeHub.publisher` for its own repository.

Obtain each public key and expected fingerprint through an independently authenticated channel, then import it
locally. The import prints the exact repository, role and fingerprint being authorized and refuses to reactivate
an existing revoked/retired record. No private key is accepted or generated:

```sh
node scripts/update.mjs trust-import --home /srv/home-hub \
  --repository example/core --role package --public-key /secure/publisher-public.pem --fingerprint EXPECTED_HEX
node scripts/update.mjs trust-import --home /srv/home-hub \
  --repository example/core --role git --public-key /secure/publisher.pub --fingerprint SHA256:EXPECTED
```

Without an instance, supply `--trust /secure/trust.json`. The file must be owner-controlled, regular, not writable
by other accounts, with protected parent directories, and outside code and every backed-up/restored root.
Selecting trust in an instance also writes `<home>/update/trust-required.json` (schema 1), outside restored roots. Subsequent operations retain that selection: removing the policy file or all authorized keys refuses the operation instead of reviving legacy behavior. Preflight may persist this trust selection as well as fetching/staging Git metadata.

`config/release-signers` is only an import candidate after independent review and fingerprint comparison.
Rotation/revocation is an explicit local administrative edit: preserve revoked records, narrow version bounds,
and never replace the policy with an older copy. There is no automatic rotation protocol in package format 1.
The updater never restores trust from its application archives.

Run an **already trusted driver**, independently verified and retained through the rollback window. Downloading
an updater and running it to verify its own package does not establish trust. Package transactions retain a copy
of this driver under `<home>/update/drivers/<transaction>/`; its journal names that driver and the old core.
Its target tests and `--check` run authenticated code under the updater account: they are **not a sandbox**.
Tests use a sanitized environment; `--check` may read the instance configuration and plugin settings.

```sh
node /trusted/driver/scripts/update.mjs download v1.0.0 --home /srv/home-hub --output /secure/downloads
# Copy the verified manifest digest printed by download into every following command.
node /trusted/driver/scripts/update.mjs verify-package --home /srv/home-hub \
  --package /secure/downloads/home-hub-v1.0.0-node-source.tar.gz --manifest-sha256 MANIFEST_HEX
node /trusted/driver/scripts/update.mjs preflight --home /srv/home-hub \
  --package /secure/downloads/home-hub-v1.0.0-node-source.tar.gz --manifest-sha256 MANIFEST_HEX --migrate-from-git
node /trusted/driver/scripts/update.mjs apply --home /srv/home-hub \
  --package /secure/downloads/home-hub-v1.0.0-node-source.tar.gz --manifest-sha256 MANIFEST_HEX --migrate-from-git
```

`verify-package` is offline and executes no package code. `download` authenticates metadata before fetching the
payload and verifies the whole result without tests. Sidecars are deterministic siblings:
`home-hub-vX.Y.Z.manifest.json` and `.manifest.sig.json`. A replaced asset under an existing tag fails the pinned
digest or signature check. Download uses HTTPS with bounded time/bytes, restricted CDN redirects, and no API token
on asset requests. A disabled update integration or `HOME_HUB_UPDATE_CHECK=off` makes no update discovery requests.

Package activation initially supports **macOS/Linux, arm64/x64, local filesystems**, an existing configured service
and a replaceable independent core directory in `HOME_HUB_HOME`. Configuration, data, state, auth/private files,
instance.json and household plugins must be external. Code-root symlinks, mount-point swaps and linked Git
worktrees are refused with relocation guidance. Git migration requires `--migrate-from-git` and retains the complete
old checkout including `.git`; no history is deleted. Package updates keep external plugin sources fixed; their
existing Git updates remain available separately. `install --package FILE` is an alias for this existing-instance
activation, with the same migration/verification requirements. Fresh service, owner and privilege setup is outside
this command. Containers continue to use image replacement. Windows has no advertised managed activation support.

The browser displays cached releases, discovery time, package links, manifest digest when hosting provides one,
explicit `not-checked` signatures and `unknown` compatibility, and local commands. The hosting digest is discovery
evidence: the CLI signature check is still mandatory. Complete compatibility is known only after local preflight.
No browser or MCP route installs, uploads executable packages, restarts services or edits trust.

## Recovery guarantees and limits

The instance lock is an atomically created **directory at the existing `update.lock` pathname**. Canonical source
locks are held in a private per-account `/tmp/home-hub-updater-<uid>` registry on macOS/Linux (independent of `TMPDIR`) in deterministic order, including Git common-dir
locks. They also cover standalone preflight fetch/worktree mutation. A lock is removed only by its ownership token
and original filesystem identity. PID existence alone is never enough to break a lock. Local filesystems are required;
network filesystem locking semantics are unsupported.

After an interrupted process, establish that **no updater or child operation remains active**, preserve the journal
and lock metadata, and manually move each reported stale lock aside to a unique evidence path. This includes old
file-format PID locks, missing owner files and ambiguous ownership. Do not automatically remove a lock based on a
PID check. Then run the retained driver's `rollback` with the original instance settings. Apply first reconciles an
unfinished transaction and exits without beginning a new update. Corrupt or future journals block mutation and are
preserved; schema-1 journals are read explicitly, with the strongest available legacy recovery checks.

Schema-2 journals record source switches and per-root restore progress before and after mutations, flushing files
and directories where supported. A multi-root change is **recoverable, not globally atomic**. Package activation
moves core to a unique sibling and then moves verified staging into its stable pathname. Restore prepares and
validates **every root** before the first replacement, on each destination filesystem, then reconciles partial
renames on the next run. Failed roots are retained in unique adjacent `.failed-*` paths; `failed-<time>/roots.json`
is an index of them. No archive is extracted directly into a live parent. A failed unrecoverable transaction leaves
the service stopped, exits 3 and names the journal, backup, retained driver and failed state. Unrelated code edits
cause a safe refusal instead of a forced checkout.

Backups use stable `root-0001` IDs and a private schema-1 manifest plus integrity sidecar. Coverage includes data,
state, private, configuration even without HOME_HUB_HOME, instance.json, site/watch overrides, external AUTH_FILE
and its sibling secret.key, and explicit secret-key/integration-secret/GitHub-token/TLS files. Physical ancestors
are deduplicated, top-level symlink topology is checked, nested links are preserved without traversal, and escaping
links require explicitly covered targets. Add `--backup-root PATH` for each plugin-managed external resource.
Environment keys and macOS Keychain keys are reported as external prerequisites, never serialized. The service's
stop command must stop all managed writers; core cannot infer arbitrary plugin jobs or independently running
writers. Hard-linked files, unsupported special files/modes and layouts are refused before switching. Archives inside data (including
legitimate `.tgz` files) are retained. There are no wildcard exclusions in this implementation.

Backup creation inventories bytes/modes/links, streams a restricted USTAR gzip, reads it completely, stages a restore
and compares its complete inventory before publishing. Local limits are 20,000 entries, 256 MiB compressed,
1 GiB expanded and 64 MiB per file; larger instances need a separately verified backup procedure. Legacy `.tgz`
archives are inspected and staged by the same restricted reader, explicitly labelled as lacking integrity provenance;
unsupported PAX/GNU extensions, special entries and ambiguous metadata require manual recovery. A retained journal's
archive is never pruned; archive sidecars are pruned together. Old core and failed roots require manual retention
review, and are never automatically deleted.

Readiness retains `/healthz` body `{ok:true}` and adds `X-Home-Hub-Run-Id`. `run.json` retains existing fields and adds
boot ID, capability 1, full commit/package digest and exact loaded-plugin and complete source-content fingerprints (excluding `.git` and `node_modules`). Modern updates of a selected Git plugin source require a reproducible tracked tree; untracked/ignored resources must be relocated outside that source first. Every sample checks
HTTP body/status, local boot identity, live new process, full target identity and complete plugin versions/content.
It requires **10 consecutive seconds**, resetting on failure or restart; `health.seconds` remains the initial startup
deadline, with up to ten extra seconds for observation. Old recovery targets use sustained legacy checks, explicitly
with reduced assurance. An expected modern identity never downgrades when fields/header are missing.

## Preparing source package assets (publisher machine only)

The release script still prepares commits/tags locally and never pushes or publishes. After the exact release tag
is signed and independently authorized, run `scripts/package-release.mjs --tag … --key FILE --trust FILE --output DIR`
from the trusted driver. Its package key is Ed25519 PKCS8, owner-only and outside the repository; the package public
key must already be authorized alongside the Git signer. No actual key is supplied by core. The tool materializes
tracked regular blobs from the exact commit using Git plumbing (no filters/hooks), leak scans them, emits all three
assets, verifies the emitted package locally, and runs its full extracted test suite without `.git`.

Manifest schema 1 records product/repository/version/tag/fullCommit, epoch, Node/updater requirements, platforms,
architectures, readiness protocol, payload bytes/hash/expanded bytes, and every regular file's bytes/hash/mode.
Its size is bounded to 8 MiB. The signature sidecar contains schema 1, `ed25519`, the SHA-256 SPKI key ID and one
canonical base64 64-byte signature over `UTF8("home-hub-release-manifest-v1\\n") || exact_manifest_bytes` (the domain
ends with one newline byte). Unknown fields/algorithms, duplicate JSON keys, malformed UTF-8, traversal, aliases,
case-fold collisions, links, special files, `.git`, reserved receipt paths, unsupported tar extensions, wrong hashes,
truncation and unlisted files are refused. Signed declarations cannot raise local limits. Packages contain core only,
no household files, runtime, npm dependencies, bundled executable tools or installation hooks. Review the assets and
attach them to the release separately; nothing in packaging uploads them.
