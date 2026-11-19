# Updating

Home Hub never updates itself. It tells you that a newer release exists (the card "Home Hub update check" on
Administration → Integrations, and the footer for an administrator); **a command applies it**, run on the server by
whoever may restart the service. In the examples, set `TARGET_TAG` to an existing published release tag
and `PLUGIN_TAG` to the desired tag in the plugin source; 1.0.0 is the first public core release:

```sh
node scripts/update.mjs status              # what is installed and running, the newest tag, the last update
node scripts/update.mjs preflight "$TARGET_TAG"    # every check that needs no change to the instance
node scripts/update.mjs apply "$TARGET_TAG"        # preflight, stop, archive, switch, start, health check; back on any failure
node scripts/update.mjs rollback            # undo the last update
node scripts/update.mjs backup              # only the archive (stop, archive, start)
node scripts/update.mjs backup-diagnose     # report backup coverage, limits and space
```

Without a tag, `preflight` and `apply` take the newest release tag after a fetch. `--to "$TARGET_TAG"` is the same as the
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
node scripts/update.mjs apply "$TARGET_TAG" \
  --service launchd:system/com.example.home-hub \
  --health http://127.0.0.1:8781/healthz
```

| What | `instance.json` | Flag | Default |
|---|---|---|---|
| The core checkout | `sources.core` (a directory of the instance) | `--root DIR` | the checkout this script is in |
| Plugin sources | `sources.plugins` | (`HOME_HUB_PLUGINS_DIR`); `--add-plugin-source NAME` stages an addition | `local/plugins` in the checkout |
| Replacement site for the target | | `--site-config FILE` (preflight/apply) | the current site; legacy core keys are converted in staging |
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
| 7 | Archives configuration, data, state, private files and configured external roots into `pre-<from>-to-<to>-<time>.tgz` (0600), then verifies the stream against its inventory. The hub is stopped, so SQLite is closed and consistent. Nested staging mirrors and `*.tgz` files are included. A site being replaced is also saved separately. | starts the old version |
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

### Site-file compatibility

The update driver validates a converted copy of a supported legacy site file and restores the original on rollback.

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
node scripts/update.mjs apply "$TARGET_TAG" --plugins "$PLUGIN_TAG"            # core and the only plugin source
node scripts/update.mjs apply --plugins household="$PLUGIN_TAG"         # only that source; core stays
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
`1.0.999`: a plain version, because prereleases usually fall outside plugins' declared core ranges and can
fail compatibility checks instead of testing the start). This example starts from the first public release,
`v1.0.0`, and uses legacy Git verification without independently configured trust. With operator trust configured,
an unsigned rehearsal tag is refused: use the disposable transaction tests in `tests/update-apply.test.mjs` instead;
do not remove or weaken trust to run this example.

```sh
cd /srv/home-hub
git worktree add --detach /tmp/hub-rehearsal v1.0.0 && cd /tmp/hub-rehearsal      # the release that is installed
sed -i.bak 's/"version":"1.0.0"/"version":"1.0.999"/' package.json && rm package.json.bak
awk '!d&&/^## /{print "## 1.0.999\n\nA rehearsal: this build exits when it is started.\n";d=1}1' CHANGELOG.md > c && mv c CHANGELOG.md
printf '\nif(process.argv[1]===fileURLToPath(import.meta.url))setTimeout(()=>{console.error("rehearsal build: exiting");process.exit(1);},300);\n' >> server/index.mjs
git -c user.name=rehearsal -c user.email=rehearsal@example.invalid commit -qam 'rehearsal: exits at start'
git tag v1.0.999 && cd /srv/home-hub && git worktree remove --force /tmp/hub-rehearsal

node scripts/update.mjs apply v1.0.999 --no-fetch --health-seconds 20 --service … --health …
#   → "failed at "starting": health check failed … It was rolled back", exit 1, and the old version answers
node scripts/update.mjs status --service … --health …
git tag -d v1.0.999
```

Delete the tag right away: while it is there, a bare `apply` would take it for the newest release. The note
`quarantined → 1.0.999` stays in `updates.json`; it names a version that will never be released, so nothing shows it. The archive it made counts toward `backups.keep`.

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

### Upgrade an installed v1.0.0 Git checkout

Use a separate, verified checkout of the release that contains the socket-aware updater. The stock v1.0.0
checkout stays on its original tag until the updater switches it. A source checkout works with both the default
in-checkout layout and an instance directory. No package migration is needed for this Git upgrade.

The public v1.2.0 Git tag is unsigned. For an installation already using unsigned releases, obtain its
full tag object and commit through an independently trusted channel. Using an owner-controlled directory for
the driver, fetch the tag into both checkouts and compare both IDs before executing the driver:

```sh
(
  set -eu
  umask 077
  git init --quiet "$DRIVER"
  for checkout in "$DRIVER" "$INSTALL"; do
    git -C "$checkout" fetch --no-tags "$PUBLISHER_URL" "refs/tags/$TARGET_TAG:refs/tags/$TARGET_TAG"
    test "$(git -C "$checkout" rev-parse "refs/tags/$TARGET_TAG")" = "$TAG_OBJECT"
    test "$(git -C "$checkout" rev-parse "refs/tags/$TARGET_TAG^{commit}")" = "$TARGET_COMMIT"
  done
  git -C "$DRIVER" -c core.hooksPath=/dev/null checkout --quiet --detach "$TARGET_COMMIT"
  # The v1.2.0 preflight tests expect the standard file creation mask.
  umask 022
  node "$DRIVER/scripts/update.mjs" apply "$TARGET_TAG" --no-fetch --root "$INSTALL" --home "$INSTANCE"
)
```

Run the backup diagnostics below first if the stock updater reports a coverage or budget error.
Instances configured to require signatures continue to enforce their publisher policy. For a signed
distribution, use the following verification procedure.

First obtain the target tag name, its full annotated tag object ID, the publisher's Git URL and approved SSH
signer through an independently authenticated channel. Keep the operator trust file and the driver's new Git
checkout in owner-controlled locations outside the installation. Import the Git signer with the stock updater
and its independently supplied expected fingerprint as shown above. Create an OpenSSH allowed-signers file
with the same authorized public key, on one line as `release namespaces="git" ssh-ed25519 KEY`.

Populate the separate driver checkout from the release. Set `DRIVER` to a new empty directory, `PUBLISHER_URL` to
the approved Git URL, `TARGET_TAG` and `TAG_OBJECT` to the authenticated release identifiers, and
`ALLOWED_SIGNERS` to the absolute path of that local signer file. Run this in an operator shell with its normal
Git executable and no repository overrides.

```sh
(
  umask 077
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1
  git init --quiet "$DRIVER" &&
  git -C "$DRIVER" fetch --no-tags "$PUBLISHER_URL" "refs/tags/$TARGET_TAG:refs/tags/$TARGET_TAG" &&
  test "$(git -C "$DRIVER" rev-parse "refs/tags/$TARGET_TAG")" = "$TAG_OBJECT" &&
  git -C "$DRIVER" -c gpg.format=ssh -c gpg.ssh.program=/usr/bin/ssh-keygen \
    -c "gpg.ssh.allowedSignersFile=$ALLOWED_SIGNERS" verify-tag "$TAG_OBJECT" &&
  git -C "$DRIVER" -c core.hooksPath=/dev/null checkout --quiet --detach "$TAG_OBJECT^{commit}"
)
```

After this block succeeds, run a single updater invocation against the installed instance. With an instance
directory, use its existing service and health settings.

```sh
node "$DRIVER/scripts/update.mjs" apply "$TARGET_TAG" \
  --root "$INSTALL" --home "$INSTANCE" --trust "$TRUST"
```

For the in-checkout layout, supply the same service, health address and path overrides the stock install used.

```sh
node "$DRIVER/scripts/update.mjs" apply "$TARGET_TAG" --root "$INSTALL" --trust "$TRUST" \
  --service systemd:home-hub.service --health http://127.0.0.1:8781/healthz
```

The invocation performs preflight, verifies the installed repository's target tag under operator trust, checks
backup coverage, and runs the target tests and startup check. Fetching reads Git metadata from the installed
checkout's configured remote. An offline install can fetch the approved tag into its checkout ahead of time,
compare the tag object to `TAG_OBJECT`, and pass `--no-fetch`. Keep the retained driver path printed by `apply`
for later rollback. The disposable rehearsal in `tests/large/update-stock-sockets.mjs` uses the real stock tag,
a locally signed candidate, the hub server and listening UNIX sockets. Run it with no options to create that
candidate. Add `--aliases` to exercise review and enrollment of an external hard link. To rehearse the exact
signed release already present in the repository, supply the authenticated release identifiers instead.

```sh
node tests/large/update-stock-sockets.mjs --tag "$TARGET_TAG" --tag-object "$TAG_OBJECT" \
  --public-key "$PUBLISHER_PUBLIC_KEY" --fingerprint "$PUBLISHER_FINGERPRINT"
```

Run an **already trusted driver**, independently verified and retained through the rollback window. Downloading
an updater and running it to verify its own package does not establish trust. Git and package transactions retain the executable driver under `<home>/update/drivers/<tree digest>/` (or
`<backups>/drivers/` without an instance directory). The journal records its path, capabilities and tree digest.
When obtaining a driver from a release package, use the already trusted installed updater's `verify-package`
with operator trust before invoking any code from the new package. Target tests and `--check` execute under
the updater account.
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

Schema-3 journals record source switches and per-root restore progress before and after mutations, flushing files
and directories where supported. A multi-root change is **recoverable, not globally atomic**. Package activation
moves core to a unique sibling and then moves verified staging into its stable pathname. Restore prepares and
validates **every root** before the first replacement, on each destination filesystem, then reconciles partial
renames on the next run. Failed roots are retained in unique adjacent `.failed-*` paths; `failed-<time>/roots.json`
is an index of them. No archive is extracted directly into a live parent. A failed unrecoverable transaction leaves
the service stopped, exits 3 and names the journal, backup, retained driver and failed state. Unrelated code edits
cause a safe refusal instead of a forced checkout.

New transactions use journal schema 3. The updaters shipped in v1.0.0 and v1.1.0 refuse that journal
before stopping the service, changing the checkout or restoring files. Use the retained driver path printed by
`apply` for `status`, `rollback` and recovery. After rolling back to v1.0.0 or v1.1.0, continue using that driver for subsequent backups and updates while the schema-3 journal is present. Supply the original `--root`, `--home` and any path overrides,
especially when the installed checkout has its data inside it.

```sh
node /srv/home-hub/update/drivers/TREE_DIGEST/scripts/update.mjs status --home /srv/home-hub
node /srv/home-hub/update/drivers/TREE_DIGEST/scripts/update.mjs rollback --home /srv/home-hub --yes
```

The driver reads schema-1 and schema-2 journals and restores both schema-1 manifests and older archives without
integrity metadata. Legacy archives use the restricted reader and staged inspection. Keep the archive and both
sidecars together. Pruning removes an old archive and its sidecars and skips the active journal's archive.
Review retained drivers, failed roots, old core and abandoned partial backup files separately before removing them.

## Backup coverage and budgets

A backup covers data, state, private files, configuration, `instance.json`, site/watch overrides, external
`AUTH_FILE` and its sibling `secret.key`, and configured secret-key, integration-secret, GitHub-token and TLS
files. Pause external writers to durable files during the transaction. Environment and Keychain keys appear as external
prerequisites. Use `--backup-root PATH` for a plugin's external data or `coverFiles` for individual hard-link aliases.

```sh
node /trusted/driver/scripts/update.mjs backup-diagnose --home /srv/home-hub \
  --search-root /srv/legacy-checkout --examples 5 --candidate-cover-files
node /trusted/driver/scripts/update.mjs preflight --read-only --home /srv/home-hub
```

Both commands report JSON, exit 1 for blockers, and leave the service, repositories, locks and recovery metadata
untouched. `preflight --read-only` checks the backup and journal state. Run regular `preflight <tag>` for target
compatibility, signature, target tests and startup checks. Regular preflight can fetch, stage and persist trust
selection. Diagnostic reports cover root sizes, discovered aliases by parent, filesystem space and blockers. The
optional search walks directories without following symlinks. It stops after two million entries by default.
Use `--search-max-entries N` for a smaller search. `--examples N` prints at most 100 names and
`--candidate-cover-files` supplies the discovered exact paths for operator review. Searches do not enroll any
files. The updater repeats coverage and space checks after the service stops.

Create an owner-only `<home>/update/backup-policy.json` outside restored and source roots. An alternate
`--backup-policy FILE` is selected explicitly on each diagnostic, backup, preflight or apply. Rollback uses
the coverage recorded with the archive. `instance.json` keeps its existing format.

```json
{"schemaVersion":1,
 "budget":{"maxBytes":6442450944,"maxEntries":50000,"maxFileBytes":536870912,"maxRoots":300,"gzipLevel":1},
 "coverFiles":["/srv/legacy-checkout/assets/linked-image.bin"]}
```

Each `coverFiles` path must be an existing hard-linked regular file outside the already covered roots and
installed sources. Each group must include at least one name in ordinary backup coverage. Every name counted by
the filesystem must be covered. An unknown name blocks backup, and rollback refuses if a covered exact path
has been replaced or there are additional live aliases outside coverage. The archive stores each hard-linked
payload once. On rollback every covered name in the group points to one restored inode, including names in
different roots. Only the exact enrolled files are replaced in the external directory. The failed pre-rollback
versions are retained at adjacent `.failed-*` paths.

| Budget | Default | Maximum |
|---|---:|---:|
| Unique file payload bytes | 1 GiB | 64 GiB |
| Entries, including aliases and directories | 20,000 | 200,000 |
| Bytes per file | 64 MiB | 8 GiB − 1 byte |
| Roots, including exact-file roots | 64 | 1,000 |
| gzip level | 1 | 9 |

The backup uses restricted USTAR plus a schema-2 JSON Lines manifest and integrity sidecar. The manifest is
capped at 128 MiB. Signed release packages keep their existing limits, including 256 MiB compressed and
64 MiB per file. The updater reserves space for the worst-case archive and destination staging, counting a
hard-linked payload once and budgeting sparse files at their apparent size. Existing archives consume disk
space until pruning at the end of a successful update. Use local filesystems and leave space for the retained
failed state. Mounted roots, unsupported special files/modes, unsafe links and paths outside USTAR limits are refused.

Filesystem UNIX sockets in covered roots are reported separately and left in place. The archive contains durable
files and the directory structure. During rollback the updater keeps directories leading to sockets and
unchanged socket aliases at their existing paths and inodes. It restores archived durable children individually
and retains durable paths created since the backup in the failed-state index. Sockets created after backup also
stay reachable. Leave the independent daemon running and keep its socket path topology stable during the update.
Rollback refuses if a live socket, socket alias, or directory needed to reach one conflicts with the archive.
It checks again after stopping the service, before switching code. It also refuses if a new durable child
appears in a retained directory after restore was journalled.
Resolve the conflict without removing a listening endpoint before retrying. Package activation requires sockets
outside the replaceable code directory. Legacy archive rollback refuses to move roots that contain sockets.

Backup verification reads the gzip and compares header, payload and manifest digests without extracting.
Rollback checks integrity and space before stopping the service. It creates all staged roots on their destination
filesystems, verifies their content, modes and inode graph, then begins the journalled rename sequence. If
preparation is interrupted, it discards the partial staging set and rebuilds it as a group. If renames are
interrupted, it validates and resumes the graph across the installed and staged locations.

The disposable Git rehearsal uses the local v1.0.0 and v1.1.0 tags and a stand-in service with real readiness probes.

```sh
node tests/large/backup-large.mjs
node tests/large/backup-large.mjs --small --interrupt=restore-prepare-mid
```

The default fixture has over 2.07 GiB of expanded payload and 268 external aliases. Add `--dense` to produce
a compressed archive over 2 GiB. The rehearsal skips the tagged releases' test suites and runs their actual
startup check. It removes its scratch instance on exit.

Readiness retains `/healthz` body `{ok:true}` and adds `X-Home-Hub-Run-Id`. `run.json` retains existing fields and adds
boot ID, capability 1, full commit/package digest and exact loaded-plugin and complete source-content fingerprints (excluding `.git` and `node_modules`). Modern updates of a selected Git plugin source require a reproducible tracked tree; untracked/ignored resources must be relocated outside that source first. Every sample checks
HTTP body/status, local boot identity, live new process, full target identity and complete plugin versions/content.
It requires **10 consecutive seconds**, resetting on failure or restart; `health.seconds` remains the initial startup
deadline, with up to ten extra seconds for observation. Old recovery targets use sustained legacy checks, explicitly
with reduced assurance. An expected modern identity never downgrades when fields/header are missing.

## Preparing source package assets (publisher device only)

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


## Update notifications and network requests
 About twice a day (first 2 to 5 minutes after start, then every
12 hours) the hub asks GitHub whether a newer release exists: two requests,
`GET https://api.github.com/repos/<repository>/releases?per_page=20` and `…/releases/latest`, where the repository is
the one named in `package.json → homeHub.updates.repo`. The requests carry the constant `User-Agent`
`home-hub-update-check` and nothing else: no version, no instance id, no site name, nothing about your devices.
Nothing is sent to the project; GitHub sees an address and a time, as for any `git fetch`. A token is not needed (if
you already keep one in `GITHUB_TOKEN` or `private/github-token` for the versions collector, it is used, for
`api.github.com` only). The result is on **Administration → Integrations** (card "Home Hub update check", with the
release notes) and, for an administrator, in the footer as `→ newer release`. When a check fails the card says so and says
what it last knew; it never claims you are up to date.

To turn it off: the switch on that card, or `HOME_HUB_UPDATE_CHECK=off` in the environment, which also removes the
switch. While it is off the hub makes no request about updates at all. `local/site.json → updates` follows another
repository (`repo`, for a fork), takes pre-releases (`channel: "prerelease"`) or changes how often it asks
(`intervalHours`, 6 to 168).
