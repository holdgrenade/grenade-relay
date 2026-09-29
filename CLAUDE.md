# grenade-relay

The open-source relay that joins a Grenade phone to its Mac when they are on different networks. Macs (`grenaded`) dial out to `/v1/daemon`; phones dial `/v1/connect/<relay id>`; the relay forwards frames and reports presence (online, last seen, public and local IPs). Anyone can host one; we run the main one on Heroku at `https://grenade-relay-7a47b5a07a7d.herokuapp.com` (see "Main instance"). It also carries push notifications: Macs post sealed pushes to `POST /v1/push` and the relay hands them to Apple's push service, or to another relay that can. Read `../grenade-protocol/PROTOCOL.md` "Remote access (relay)" and "Push notifications" first: this project implements exactly that.

## Stack

Node 22+, TypeScript strict ESM, `ws`, `zod`. Tests: vitest. Deploy: Docker (`Dockerfile`) behind Caddy for TLS (`docker-compose.yml`, `Caddyfile`). `RELAY_HOST` is a public IP or a DNS name; Caddy gets a Let's Encrypt certificate for either, using the `shortlived` profile (required for IPs) and `default_sni` (IP clients send no SNI). No other runtime dependencies.

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
| `src/store.ts` | `DaemonStore`: records in memory, debounced atomic save to `<data>/daemons.json` (0600), forgets records unseen for 90 days |
| `src/frames.ts` | Mirror of `grenade-protocol/src/relay.ts` (schemas, paths, close codes) and of the push route's bodies in `src/push.ts` (`PushRequest`, `PushError`) |
| `src/push/pushRoute.ts` | `POST /v1/push`, transport-agnostic: key check, size, parse, topic, limits, then send, pass upstream, or 503. Tests drive it with a fake sender |
| `src/push/pushPayload.ts` | Pure: a push request → the APNs body (fallback alert + sealed content) and headers |
| `src/push/pushResult.ts` | Pure: what APNs answered → what the route answers (`replyForApns`, `refusal`) |
| `src/push/pushLimiter.ts` | `PushLimiter`: 60 a minute per sender address, 20 per phone; fixed windows, `now` passed in, ended windows swept |
| `src/push/apnsToken.ts` | Pure: the APNs provider token (ES256 JWT from the `.p8` key), `ProviderTokens` reuses one for 50 minutes |
| `src/push/apnsClient.ts` | `createApnsSender`: HTTP/2 to APNs, one session per host, re-made when it closes; 10 s timeout; never throws (status 0) |
| `src/push/upstream.ts` | `createUpstream`: passes a push, unchanged, to another relay's push route with `X-Grenade-Push-Hops` |
| `src/auth.ts` | Pure: SHA-256 hex, timing-safe compare, Bearer/Basic parsing, `keyMatches` |
| `src/presence.ts` | Pure: record + online-since → `Presence`; sort order |
| `src/dashboard.ts` | Pure: the admin HTML page (escaped, self-contained, light/dark, refresh 15 s) |
| `src/clientIp.ts` | Pure: socket address, or first `X-Forwarded-For` when the proxy is trusted |
| `src/closeCode.ts` | Pure: close codes/reasons that `ws` accepts |
| `src/log.ts`, `src/version.ts` | Logger (stderr, `key=value`), version from package.json |
| `test/fixtures/` | Copies of the relay fixtures from `../grenade-protocol/fixtures` |

## Main instance (Heroku)

- App `grenade-relay` (Croissant Heroku account), one Basic `web` dyno running `Procfile` (`node dist/main.js`); Heroku's Node buildpack runs `npm run build`. Deploy: `git push heroku main`. Logs: `heroku logs -t -a grenade-relay`.
- Config vars: `GRENADE_RELAY_TRUST_PROXY=1`, `GRENADE_RELAY_ADMIN_KEY` (read it with `heroku config:get`), no registration key (open relay). Heroku terminates TLS, so Caddy is not used there.
- Push: the main relay is the one that must hold the APNs key, and it is **not set yet**. Setting `GRENADE_RELAY_APNS_KEY` (the `.p8` text; `\n` for newlines is fine), `GRENADE_RELAY_APNS_KEY_ID` and `GRENADE_RELAY_APNS_TEAM_ID` is Adam's to do; never create, read or set them on Adam's behalf. Until then the main relay's default upstream is itself, so it answers `503 push_unavailable` to every push (one hop, then the hop guard stops it). Set `GRENADE_RELAY_PUSH_UPSTREAM=off` there to skip that hop.
- Keep it at **one dyno**: all state is in one process. The disk is ephemeral, so `daemons.json` is lost on each restart (at least daily). Macs re-register within seconds with their access lists; a Mac that is off drops out of presence until it reconnects.
- The router closes connections idle for 55 s; the 15 s pings keep links open.

## Invariants

- **The relay never reads a phone ↔ daemon frame.** `data.text` is opaque (E2E sealed by the endpoints). Never parse, log, or store it. Never add a feature that needs it.
- Nothing secret is stored: only `sha256(secret)` per daemon and `sha256(access)` per phone. Compare with `safeEqual`.
- Every daemon frame goes through `parseRelayDaemonFrame`; a bad one gets `error` then the link closes. The first frame must be `register` within 5 s.
- The first link to register an id owns it (by secret). A later link with the right secret replaces the old one (old closed with 4000, its phones with 4503).
- Unpairing is the daemon's `update {access}` with a shorter list: the relay admits exactly the phones in the latest list, and the daemon closes that phone's open pipes itself (`close`). Nothing in the relay knows what a pairing is.
- Phones are checked before the upgrade: 404 unknown id, 401 access not in the daemon's list, 503 daemon offline, 429 over 8 pipes. The access list is persisted, so presence answers while the Mac is off.
- Every socket is pinged every 15 s and terminated after 30 s without a pong. A dropped daemon link closes its phone pipes with 4503 and sets `lastSeen`.
- `GRENADE_RELAY_REGISTRATION_KEY` unset = open relay (the main one); set = private. `GRENADE_RELAY_ADMIN_KEY` unset = no dashboard, no list (404).
- Max WebSocket message 4 MB (screen frames with colors).
- **The push route is blind and keeps nothing.** `c` is sealed to the phone; never try to open it, and never add a push feature that needs the session, the Mac or the text in the clear. No device token is stored: the daemon sends it with every push, so a restart loses nothing.
- **A device token is never logged**, nor `e` or `c`. A log line names a phone by the first 8 hex of `sha256(deviceToken)`. `pushRoute.test.ts` checks every answer's log lines for it.
- The APNs key is read once at start and never printed; the start-up line only says `push=apns`, `push=upstream <url>` or `push=off`. A key without key id and team id stops the start with a message that names the missing setting.
- A push is passed upstream at most once: a request that carries `X-Grenade-Push-Hops` is sent by this relay or refused with 503, never passed on. A relay with its own key never passes anything on and checks the topic; one that only passes on does not.
- Push bodies are capped at 8 KB (`MAX_PUSH_BODY_BYTES`); the reader stops a little past it and the route answers 413.
- Pure modules take no I/O and no clock; inject `now`.

## Changing the contract

1. Change `../grenade-protocol` first (`PROTOCOL.md`, `src/relay.ts`, fixtures).
2. Mirror it in `src/frames.ts`.
3. Copy the fixtures: `cp ../grenade-protocol/fixtures/{relay.*,http.relay.*,e2e.*}.json test/fixtures/` (the push route's bodies are `http.relay.push.*`). The fixture test fails until every frame type has one.
4. Update the daemon (`grenade-backend/src/relay/`) and the phone clients to match.
5. Update the public docs: this `README.md` and `../grenade-website/src/pages/relay.astro` (self-hosting guide + API reference).

## Known gaps

- No rate limiting beyond 8 pipes per daemon, the 4 MB message cap and the push route's limits. Put the public relay behind a proxy with connection limits if abuse shows up.
- The push route on an open relay takes a push from anyone who knows a device token. Tokens are 32 random bytes that only a phone, the Macs it paired with and the relay ever see, and the limits cap what a leaked one is worth. A relay that passes pushes upstream is one sender to the upstream, so all its Macs share 60 a minute there.
- Push limits are per process and in memory, like everything else here.
- One process holds all state in memory; it does not scale out across instances.
- The relay knows nothing about pairing. A phone that scanned a Mac's QR code comes in like any other: the Mac adds the access hash of the code's one-time secret to its list for at most two minutes (PROTOCOL.md "Pairing offer (QR code)"). Do not add a pairing route here.
