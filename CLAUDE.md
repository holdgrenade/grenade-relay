# grenade-relay

The open-source relay that joins a Grenade phone to its Mac when they are on different networks. Macs (`grenaded`) dial out to `/v1/daemon`; phones dial `/v1/connect/<relay id>`; the relay forwards frames and reports presence (online, last seen, public and local IPs). Anyone can host one; we run the main one at `https://relay.holdgrenade.com` (see "Main instance"). **This repo is public**: no secrets, no private paths and no personal data, in files or in commit messages. It also carries push notifications: Macs post sealed pushes, and board pushes for the Mac board's Live Activity, to `POST /v1/push` and the relay hands them to Apple's push service, or to another relay that can. Read `../grenade-protocol/PROTOCOL.md` "Remote access (relay)", "Push notifications" and "Mac board" ("Board push route") first: this project implements exactly that.

## Stack

Node 22+ (`@types/node` stays on 22 so the types match the oldest Node we support), TypeScript strict ESM, `ws`, `zod`. Tests: vitest. Deploy: Docker (`Dockerfile`) behind Caddy for TLS (`docker-compose.yml`, `Caddyfile`). `RELAY_HOST` is a public IP or a DNS name; Caddy gets a Let's Encrypt certificate for either, using the `shortlived` profile (required for IPs) and `default_sni` (IP clients send no SNI). No other runtime dependencies. It listens on `PORT` (8787 by default) behind TLS.

## Commands

```bash
npm install
npm run build        # → dist/
npm test             # unit + in-process integration over real sockets (port 0, temp dirs)
npm run typecheck    # src and test
npm run dev          # tsx src/main.ts
GRENADE_RELAY_ADMIN_KEY=dev PORT=8787 npm start
docker compose up -d # with .env from .env.example
```

## Layout

| File | Job |
| --- | --- |
| `src/main.ts` | Entry: env → `startRelay`, stop on SIGINT/SIGTERM |
| `src/config.ts` | Pure: environment → `RelayConfig` |
| `src/server.ts` | HTTP routes, WebSocket upgrades (refuses with 401/404/429/503 before upgrading), ping/pong liveness, hourly GC |
| `src/hub.ts` | Live state, transport-agnostic: daemon links, registration (TOFU claim), phone pipes, routing `open`/`data`/`close`, presence. Tests drive it with fake sockets |
| `src/store.ts` | `DaemonStore`: records in memory, debounced atomic save to `<data>/daemons.json` (0600), forgets records unseen for 90 days. A save that fails is logged once and never thrown |
| `src/frames.ts` | Mirror of `grenade-protocol/src/relay.ts` (schemas, paths, close codes) and of the push route's bodies in `src/push.ts` (`PushRequest`, `PushError`) and `src/board.ts` (`BoardPushRequest`, strict here); `parsePushRouteRequest` picks the kind |
| `src/push/pushRoute.ts` | `POST /v1/push`, transport-agnostic: key check, size, parse, topic, limits, then send, pass upstream, or 503. Tests drive it with a fake sender |
| `src/push/pushPayload.ts` | Pure: a push request → the APNs body (fallback alert + sealed content) and headers |
| `src/push/boardPayload.ts` | Pure: a board push → the Live Activity APNs payload and headers (`liveactivity`, times from `at`), as in `board.examples.json` |
| `src/push/pushResult.ts` | Pure: what APNs answered → what the route answers (`replyForApns`, `refusal`) |
| `src/push/pushLimiter.ts` | `PushLimiter`: 60 a minute per sender address, 20 per phone, 1200 in all; fixed windows, `now` passed in, ended windows swept |
| `src/registrationLimiter.ts` | `RegistrationLimiter`: 30 new relay ids an hour per address; a Mac the relay knows is never counted |
| `src/push/apnsToken.ts` | Pure: the APNs provider token (ES256 JWT from the `.p8` key), `ProviderTokens` reuses one for 50 minutes |
| `src/push/apnsClient.ts` | `createApnsSender`: HTTP/2 to APNs, one session per host, re-made when it closes; 10 s timeout; never throws (status 0) |
| `src/push/upstream.ts` | `createUpstream`: passes a push, unchanged, to another relay's push route with `X-Grenade-Push-Hops` |
| `src/auth.ts` | Pure: SHA-256 hex, timing-safe compare, Bearer/Basic parsing, `subprotocolAccess` (a browser's access key in `grenade-access.<access>`, used on `/v1/connect` only when there is no `Authorization`), `keyMatches` |
| `src/presence.ts` | Pure: record + online-since → `Presence`; sort order |
| `src/dashboard.ts` | Pure: the admin HTML page (escaped, self-contained, light/dark, refresh 15 s) |
| `src/clientIp.ts` | Pure: socket address, or the `X-Forwarded-For` entry your proxies wrote (`trustedProxies` from the right); never an entry the client sent, never a string that is not an IP |
| `src/socketPipe.ts` | `pipeOf`: a WebSocket as the hub's `Pipe`; drops a peer once `MAX_BUFFERED_BYTES` (16 MB) wait for it |
| `src/closeCode.ts` | Pure: close codes/reasons that `ws` accepts |
| `src/log.ts`, `src/version.ts` | Logger (stderr, `key=value`), version from package.json |
| `test/fixtures/` | Copies of the relay fixtures from `../grenade-protocol/fixtures` |

## Versions and releases

`version` in `package.json` is the relay's version (`/health` and the startup log show it). Every push to `main` is a release, and CI bumps the version: don't bump it by hand for a fix. The released version always has a section in `CHANGELOG.md`: the `bump` job writes it from the commits since the previous tag (`release-notes.mjs` in `holdgrenade/.github`: Claude's notes for its readers, or the plain subjects when it has no key; in the same bot commit, also for a version a commit set by hand), unless a section for that version was written by hand, and the GitHub release's notes are that section. Write the section yourself when the subjects don't say enough; the model reads your commit subjects and bodies, so say in them what changed for a reader. `.github/workflows/release.yml` first runs its `bump` job: when the pushed version is tagged already, it commits the next patch to `main` (a commit named just the version, by github-actions); a commit that sets a new version itself (a minor for a feature) keeps it. Then it type-checks, tests and builds that commit, tags `v<version>` and makes a GitHub release with generated notes. So `main` on GitHub is one commit ahead of yours after every push: pull before you commit again (`git pull --rebase origin main`). A release does not deploy the main relay: deploying it is a step of its own.

**A fix for a hole is deployed before it is pushed.** This repo is public, so a pushed fix shows everyone how to hit the main relay until it runs there. For a security fix: deploy the main relay first, check its `/health`, then push to `origin`.

## Main instance

- Served at `https://relay.holdgrenade.com` (`OFFICIAL_RELAY_URL`). An address it had before still reaches it, so Macs that stored that one keep working.
- **Where it is hosted and how it is deployed is not in this repo**, which is public: it is in the maintainers' own notes (the workspace `CLAUDE.md`, "Main relay"). Never name the host here, in a comment or in a commit message.
- It runs as `npm start` behind one proxy that terminates TLS, so Caddy is not used there. Settings: `GRENADE_RELAY_TRUST_PROXY=1`, an admin key, no registration key (open relay).
- Push: the main relay is the one that holds the APNs key (`GRENADE_RELAY_APNS_KEY`, the `.p8` text with `\n` for newlines; `GRENADE_RELAY_APNS_KEY_ID`; `GRENADE_RELAY_APNS_TEAM_ID`). They are Adam's: never create, read or set them on Adam's behalf.
- Keep it at **one process**: all state is in it. Its disk does not survive a restart, so `daemons.json` is lost each time. Macs re-register within seconds with their access lists; a Mac that is off drops out of presence until it reconnects.
- Its proxy closes idle connections; the 15 s pings keep links open.

## Invariants

- **The relay never reads a phone ↔ daemon frame.** `data.text` is opaque (E2E sealed by the endpoints). Never parse, log, or store it. Never add a feature that needs it.
- Nothing secret is stored: only `sha256(secret)` per daemon and `sha256(access)` per phone. Compare with `safeEqual`.
- Every daemon frame goes through `parseRelayDaemonFrame`; a bad one gets `error` then the link closes. The first frame must be `register` within 5 s.
- The first link to register an id owns it (by secret). A later link with the right secret replaces the old one (old closed with 4000, its phones with 4503).
- Unpairing is the daemon's `update {access}` with a shorter list: the relay admits exactly the phones in the latest list, and the daemon closes that phone's open pipes itself (`close`). Nothing in the relay knows what a pairing is.
- **New Macs are limited, known ones never.** A register for an id the relay has no record of is turned away past 30 an hour from its address (`RegistrationLimiter`) or past `GRENADE_RELAY_MAX_MACS` records (5000), and a Mac's upgrade is refused with 429 while its address has 10 links that have not registered. Turned away is closed with 1013 (WebSocket's "try again later") and no `error` frame, so the daemon reconnects with backoff and needs no new error code. After a restart every Mac is new again, so 30 an hour is per address, not per Mac: a team of more Macs behind one address fills in over the next hours.
- Phones are checked before the upgrade: 404 unknown id, 401 access not in the daemon's list, 503 daemon offline, 429 over 8 pipes. The access list is persisted, so presence answers while the Mac is off.
- Every socket is pinged every 15 s and terminated after 30 s without a pong. A dropped daemon link closes its phone pipes with 4503 and sets `lastSeen`.
- `GRENADE_RELAY_REGISTRATION_KEY` unset = open relay (the main one); set = private. `GRENADE_RELAY_ADMIN_KEY` unset = no dashboard, no list (404).
- Max WebSocket message 4 MB (screen frames with colors). A socket with more than 16 MB waiting to be read is terminated (`socketPipe.ts`): the relay never buffers without bound for a peer that stopped reading.
- **Nothing a stranger sends may end the process.** Node gives an upgrade's socket to the `upgrade` handler with no error listener, and an exception there is uncaught: the handler is wrapped, a request target that is not a path (`//`) is answered 400 (`pathOf`), and `refuseUpgrade` listens for the socket's error before it writes. Either used to end the relay with one request; `server.test.ts` sends them. The same goes for timers: `DaemonStore.flush` runs in one and catches a failed save (full disk, folder not writable), which used to end the process and again on every restart.
- **A client's address is what our proxy saw, never what the client says.** `GRENADE_RELAY_TRUST_PROXY` is the number of proxies in front; the address is read that many `X-Forwarded-For` entries from the right. The first entry is the client's own claim behind any proxy that appends to the header instead of replacing it, and believing it let anyone pick a new sender address per push and so skip the per-sender limit.
- A log sentence may quote a Mac's name, so `formatLine` turns control characters in it into spaces, and writes a value that holds one JSON-quoted: nothing a client sends can forge a log line.
- **The push route is blind and keeps nothing.** `c` is sealed to the phone; never try to open it, and never add a push feature that needs the session, the Mac or the text in the clear. No device token is stored: the daemon sends it with every push, so a restart loses nothing.
- **A device token is never logged**, nor `e` or `c`. A log line names a phone by the first 8 hex of `sha256(deviceToken)`. `pushRoute.test.ts` checks every answer's log lines for it.
- The APNs key is read once at start and never printed; the start-up line only says `push=apns`, `push=upstream <url>` or `push=off`. A key without key id and team id stops the start with a message that names the missing setting.
- A push is passed upstream at most once: a request that carries `X-Grenade-Push-Hops` is sent by this relay or refused with 503, never passed on. A relay with its own key never passes anything on and checks the topic; one that only passes on does not.
- **A board push is readable by design and carries nothing readable.** A Live Activity push cannot be sealed, so `BoardPushRequest` is strict (unknown keys refused at every level): opaque 16-hex keys, four statuses, integer times. Never loosen it or add a field that names a session, a Mac or text. It shares the sealed push's answers, limits (same per-sender and per-token counts, keyed by the activity's push token), topic check and upstream rule, and its push token is never logged either.
- Push bodies are capped at 8 KB (`MAX_PUSH_BODY_BYTES`); the reader stops a little past it and the route answers 413.
- Pure modules take no I/O and no clock; inject `now`.

## Changing the contract

1. Change `../grenade-protocol` first (`PROTOCOL.md`, `src/relay.ts`, fixtures).
2. Mirror it in `src/frames.ts`.
3. Copy the fixtures: `cp ../grenade-protocol/fixtures/{relay.*,http.relay.*,e2e.*,board.examples}.json test/fixtures/` (the push route's bodies are `http.relay.push.*`; `board.examples.json` holds what a board push sends to APNs). The fixture test fails until every frame type has one.
4. Update the daemon (`grenade-cli/src/relay/`) and the phone clients to match.
5. Update the public docs: this `README.md` and `../grenade-website/src/pages/relay.astro` (self-hosting guide + API reference).

## Known gaps

- Beyond the limits above (pipes per daemon, message and buffer caps, push limits, new Macs per address and in all, links waiting to register) there is no connection limit per address. Put the public relay behind a proxy with connection limits if abuse shows up.
- Each record may hold up to 1000 access hashes and the whole store is rewritten on every change, so `GRENADE_RELAY_MAX_MACS` bounds memory and disk only roughly (5000 full records is about 330 MB). Real Macs list a few phones each.
- The first link to register an id owns it, and the main relay loses its records at every restart (ephemeral disk). Someone who knows a Mac's relay id (128 random bits, known to its paired phones) could register it first after a restart and keep that Mac off the relay (`id_taken`). They could read nothing: phones pin the Mac's key.
- The admin key has no limit on wrong guesses; it relies on being long and random.
- The push limits count per IP address, so an IPv6 sender with a whole /64 has many. The main relay is reached over IPv4 only.
- The push route on an open relay takes a push from anyone who knows a device token. Tokens are 32 random bytes that only a phone, the Macs it paired with and the relay ever see, and the limits cap what a leaked one is worth. A relay that passes pushes upstream is one sender to the upstream, so all its Macs share 60 a minute there.
- Push limits are per process and in memory, like everything else here.
- One process holds all state in memory; it does not scale out across instances.
- The relay knows nothing about pairing. A phone that scanned a Mac's QR code comes in like any other: the Mac adds the access hash of the code's one-time secret to its list for at most two minutes (PROTOCOL.md "Pairing offer (QR code)"). Do not add a pairing route here.
