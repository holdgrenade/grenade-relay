# Changelog

What changed in each version of the relay, newest first. Every push to `main` is a release: CI's `bump` job (`.github/workflows/release.yml`) writes the released version's section from the commit subjects since the previous tag, and that section is the GitHub release's notes. A section written here by hand for the version being released is kept as it is, so write one when the commit subjects don't say enough.

## 1.2.6 (2026-10-09)

- Release notes written by Claude from each version's commits

## 1.2.5 (2026-10-09)

- CHANGELOG.md: every earlier version, from history

## 1.2.4 (2026-10-09)

- A CHANGELOG section for every release, its notes on the GitHub release

## 1.2.3 (2026-10-09)

- Limits on new Macs and on pushes in all

## 1.2.2 (2026-10-09)

- Every push releases: CI bumps the patch when a push did not

## 1.2.1 (2026-10-08)

- CLAUDE.md: deploy before push, port, versioning

## 1.2.0 (2026-10-08)

- a browser can send its access key as the subprotocol grenade-access.<access>

## 1.1.2 (2026-10-03)

- how the main relay is hosted is not in this repo

## 1.1.1 (2026-10-03)

- nothing a stranger sends ends the relay; a client's address is what the proxy saw

## 1.1.0 (2026-10-03)

- board pushes on POST /v1/push (Mac board Live Activity)

## 1.0.0 (2026-10-01)

- versioned releases through GitHub Actions
- Push route: pass sealed push notifications to Apple
- Unpairing and pairing through the relay: tests and docs
- Link to holdgrenade.com; ignore secrets and key files
- Link to www.holdgrenade.com
- grenade-backend is now grenade-cli
- TypeScript 7, and the latest ws types
- The Docker image runs on Node 24
- Move the iOS app to bundle id com.holdgrenade.grenade
- The main relay is https://relay.holdgrenade.com

## 0.1.0 (2026-09-27)

- grenade-relay: initial release, deployable to Heroku
