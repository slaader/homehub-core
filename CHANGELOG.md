# Changelog

Home Hub core, newest first. One section per release; the section is the text of that release on the forge
(`node scripts/release.mjs <version> --notes` prints it). Parts, in this order, empty ones left out:
**Added**, **Changed**, **Deprecated**, **Fixed**, **Plugin contract**, **Data**, **Upgrade notes**. What the version
number promises is in `AGENTS.md` → Versioning. The top section is the release being prepared, `## Unreleased`
until the release gives it its number: a change to the public surface adds its line there in the same commit.

## Unreleased

### Added

- Operator-configured release trust and signed source packages, with local verification and CLI migration; configured trust failures never fall back to the legacy Git policy.
- Exclusive updater locks, verified backups with staged restoration, per-root recovery and sustained exact runtime readiness.

### Deprecated

- Git updates without independently configured trust retain legacy signature/unsigned behavior and now display explicit legacy warnings. Bare Git apply still chooses the highest stable local tag. Stale locks require manual maintenance after checking that no updater or child remains active.

### Data

- Data epoch 5. It holds schema-2 update journals, backup manifests and integrity sidecars, operator trust and
  required-policy markers and package receipts; schema-1 journals and older backups stay recoverable. State written
  by a pre-1.0 build is read in the form that build wrote it and written in the 1.0 form in its place, once
  (`server/state-forward.mjs`, `docs/storage.md` → State written before 1.0). Going back to a pre-1.0 build, or across
  the epoch boundary, needs the archive made before the update; trust and revocations stay outside the restored paths.

### Upgrade notes

- **The update check reads GitHub releases only** (`docs/updating.md`, `README.md`). A hub whose releases live on
  another forge applies updates with `node scripts/update.mjs apply <tag>` and turns the check off
  (`HOME_HUB_UPDATE_CHECK=off`) or points `site.json → updates.repo` at a GitHub mirror.
- **The agents do not update themselves.** A newer agent reaches a machine when its installer is run again from a
  newer checkout.
- **Not yet verified on a real machine:** the launchd daemon on a Mac; on Windows, an install whose health check
  passes on the machine itself, and the Windows Update search, which Windows refuses to `LocalService` (the update
  check then shows `unknown`); and the items each first-run checklist in `docs/agent.md` marks as not tried.
