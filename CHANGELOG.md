# Changelog

What changed in each version of the relay, newest first. Every push to `main` is a release: CI's `bump` job (`.github/workflows/release.yml`) writes the released version's section from the commit subjects since the previous tag, and that section is the GitHub release's notes. A section written here by hand for the version being released is kept as it is, so write one when the commit subjects don't say enough.

## 1.2.7 (2026-10-09)

- Small fixes and improvements.

## 1.2.6 (2026-10-09)

- Small fixes and improvements.

## 1.2.5 (2026-10-09)

- Small fixes and improvements.

## 1.2.4 (2026-10-09)

- Each release now includes a CHANGELOG section, and its notes appear on the GitHub release page.

## 1.2.3 (2026-10-09)

- Each address can register at most 30 new relay IDs per hour. Macs that the relay already knows are never turned away by this limit.
- The relay keeps at most `GRENADE_RELAY_MAX_MACS` Macs, which defaults to 5000. A Mac over that limit is disconnected with code 1013 ("try again later") and reconnects by itself.
- A Mac's upgrade is refused with HTTP 429 while its address has 10 connections that have not registered.
- The relay handles at most 1200 pushes per minute in total.

## 1.2.2 (2026-10-09)

- Every push to main now publishes a release. If the pushed version was already released, the patch number is bumped automatically. A version you set yourself, such as a minor bump, is kept.

## 1.2.1 (2026-10-08)

- Small fixes and improvements.

## 1.2.0 (2026-10-08)

- Browsers can now pass the access key in the WebSocket subprotocol header as `grenade-access.<access>`, so the key no longer has to appear in the connection URL.

## 1.1.2 (2026-10-03)

- Small fixes and improvements.

## 1.1.1 (2026-10-03)

- A malformed connection request from a stranger, or a client that disconnects while its connection is being refused, no longer crashes the relay.
- A failed save of the records, such as a full disk or an unwritable folder, is logged once instead of crashing the relay.
- GRENADE_RELAY_TRUST_PROXY is now the number of proxies in front of the relay. The relay reads the client address that many entries from the right of X-Forwarded-For, and it must be a valid IP. Clients can no longer pick their own address to get around push limits.

## 1.1.0 (2026-10-03)

- The push route now accepts a second kind of push, `kind "board"`, for the Mac board's Live Activity. Protocol 1.4.0 documents it.
- Board pushes are checked strictly. They may contain only opaque keys, statuses, and whole-second times.
- Board pushes go to Apple as Live Activity updates sent to each activity's own token, using the payload format shown in the board examples.
- Board pushes get the same responses, size limits, topic check, and upstream handling as sealed pushes.
- Activity tokens are never written to logs.

## 1.0.0 (2026-10-01)

- Relays can now pass sealed push notifications to Apple. `POST /v1/push` takes one push from a Mac and hands it to APNs. The relay can't read the push and keeps nothing, because the Mac sends the device token with each push, and device tokens are never logged.
- A relay with an APNs key (`GRENADE_RELAY_APNS_KEY`, `GRENADE_RELAY_APNS_KEY_ID`, `GRENADE_RELAY_APNS_TEAM_ID`) sends pushes itself. A relay without one passes each push to its upstream relay, which defaults to the main one. A push is passed on at most once.
- Push limits are 60 a minute per sender address and 20 per device token.
- The iOS app's bundle ID is now `com.holdgrenade.grenade`, and the APNs topic follows it. The Mac's launchd label is unchanged.
- The main relay's address is now `https://relay.holdgrenade.com`.
- The Docker image runs on Node 24.

## 0.1.0 (2026-09-27)

- First release of the Grenade relay, which you can run yourself to host your own relay.
