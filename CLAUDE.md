# grenade-relay

The open-source relay that joins a Grenade phone to its Mac when they are on different networks. Macs (`grenaded`) dial out to `/v1/daemon`; phones dial `/v1/connect/<relay id>`; the relay forwards frames and reports presence (online, last seen, public and local IPs). Anyone can host one; we run the main one at `https://relay.grenade.dev`. Read `../grenade-protocol/PROTOCOL.md` "Remote access (relay)" first: this project implements exactly that.

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
| `src/frames.ts` | Mirror of `grenade-protocol/src/relay.ts` (schemas, paths, close codes) |
| `src/auth.ts` | Pure: SHA-256 hex, timing-safe compare, Bearer/Basic parsing, `keyMatches` |
| `src/presence.ts` | Pure: record + online-since → `Presence`; sort order |
| `src/dashboard.ts` | Pure: the admin HTML page (escaped, self-contained, light/dark, refresh 15 s) |
| `src/clientIp.ts` | Pure: socket address, or first `X-Forwarded-For` when the proxy is trusted |
| `src/closeCode.ts` | Pure: close codes/reasons that `ws` accepts |
| `src/log.ts`, `src/version.ts` | Logger (stderr, `key=value`), version from package.json |
| `test/fixtures/` | Copies of the relay fixtures from `../grenade-protocol/fixtures` |

## Invariants

- **The relay never reads a phone ↔ daemon frame.** `data.text` is opaque (E2E sealed by the endpoints). Never parse, log, or store it. Never add a feature that needs it.
- Nothing secret is stored: only `sha256(secret)` per daemon and `sha256(access)` per phone. Compare with `safeEqual`.
- Every daemon frame goes through `parseRelayDaemonFrame`; a bad one gets `error` then the link closes. The first frame must be `register` within 5 s.
- The first link to register an id owns it (by secret). A later link with the right secret replaces the old one (old closed with 4000, its phones with 4503).
- Phones are checked before the upgrade: 404 unknown id, 401 access not in the daemon's list, 503 daemon offline, 429 over 8 pipes. The access list is persisted, so presence answers while the Mac is off.
- Every socket is pinged every 15 s and terminated after 30 s without a pong. A dropped daemon link closes its phone pipes with 4503 and sets `lastSeen`.
- `GRENADE_RELAY_REGISTRATION_KEY` unset = open relay (the main one); set = private. `GRENADE_RELAY_ADMIN_KEY` unset = no dashboard, no list (404).
- Max WebSocket message 4 MB (screen frames with colors).
- Pure modules take no I/O and no clock; inject `now`.

## Changing the contract

1. Change `../grenade-protocol` first (`PROTOCOL.md`, `src/relay.ts`, fixtures).
2. Mirror it in `src/frames.ts`.
3. Copy the fixtures: `cp ../grenade-protocol/fixtures/{relay.*,http.relay.*,e2e.*}.json test/fixtures/`. The fixture test fails until every frame type has one.
4. Update the daemon (`grenade-backend/src/relay/`) and the phone clients to match.

## Known gaps

- No rate limiting beyond 8 pipes per daemon and the 4 MB message cap. Put the public relay behind a proxy with connection limits if abuse shows up.
- One process holds all state in memory; it does not scale out across instances.
- Pairing still needs the phone and Mac on the same network; the relay only carries already-paired phones.
