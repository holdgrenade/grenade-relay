# grenade-relay

The relay that lets [Grenade](https://grenade.dev) reach your Mac from anywhere. When your phone and your Mac are on different networks, both dial out to a relay and it joins them up. The Mac needs no open port, no VPN and no port forwarding.

We run the main relay at `https://relay.grenade.dev`. You can host your own: for your team, your company, or just yourself.

## What the relay can and cannot see

Everything between the phone and the Mac is **end-to-end encrypted** (X25519 + ChaCha20-Poly1305). The phone pins the Mac's key when it pairs on the same Wi‑Fi, so a relay can neither read the traffic nor pose as your Mac. The relay forwards opaque bytes.

What a relay does know about each Mac:

- its name and Grenade version,
- whether it is online, since when, and when it was last seen,
- the public IP its connection came from, and the local IPs it reports,
- the SHA-256 of each paired phone's *access key* (derived from, but not, the pairing token), so it can decide who may see and reach the Mac.

It never sees terminal contents, keystrokes, or pairing tokens.

Push notifications pass through a relay too, sealed for the phone. See "Push notifications" below for what a relay learns from them.

## Quick start (Docker + automatic TLS)

You need a server with Docker, a public IP (a DNS name is optional), and ports 80 and 443 open.

```bash
git clone <this repo> grenade-relay && cd grenade-relay
cp .env.example .env        # set RELAY_HOST to the public IP (or a DNS name); optionally the keys
docker compose up -d
curl https://203.0.113.7/health
```

Caddy gets and renews the certificate from Let's Encrypt, for an IP as well as for a name. IP certificates last about 6 days, and Caddy renews them on its own, so keep ports 80 and 443 open. Use a static IP (an Elastic IP, a reserved IP): each Mac stores the relay URL, so moving the relay to a new address means running `grenade relay on <new url>` on every Mac again. The relay keeps its records in the `relay-data` volume.

## Without Docker

Node 22 or newer. Put it behind anything that terminates TLS (Caddy, nginx, a load balancer) and passes WebSocket upgrades.

```bash
npm ci && npm run build
GRENADE_RELAY_ADMIN_KEY=$(openssl rand -hex 24) PORT=8787 npm start
```

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on. |
| `HOST` | `0.0.0.0` | Address to bind. |
| `GRENADE_RELAY_DATA` | `./data` | Folder for `daemons.json` (records of Macs; mode 0600). |
| `GRENADE_RELAY_REGISTRATION_KEY` | unset | When set, only Macs that present this key may register. Use it for private and company relays. Unset means anyone's Mac may use the relay. |
| `GRENADE_RELAY_ADMIN_KEY` | unset | Turns on the dashboard at `/` (HTTP Basic, any user name, this password) and `GET /v1/daemons`. Unset means both answer 404. |
| `GRENADE_RELAY_TRUST_PROXY` | unset | `1` takes client IPs from `X-Forwarded-For`. Only set it behind a proxy you run (the compose file does). |
| `GRENADE_RELAY_PUSH_UPSTREAM` | the main relay | The relay that pushes are passed on to. `off` turns push off on this relay. Ignored when an APNs key is set. |
| `GRENADE_RELAY_PUSH_UPSTREAM_KEY` | unset | The upstream relay's registration key, when it requires one. |
| `GRENADE_RELAY_APNS_KEY` | unset | The text of an APNs key (`.p8`), for a relay that sends pushes itself. Newlines may be written as `\n`. |
| `GRENADE_RELAY_APNS_KEY_FILE` | unset | The same key as a file path, in place of `GRENADE_RELAY_APNS_KEY`. |
| `GRENADE_RELAY_APNS_KEY_ID` | unset | The key's id (10 characters). Required with a key. |
| `GRENADE_RELAY_APNS_TEAM_ID` | unset | The Apple Developer team the key belongs to. Required with a key. |
| `GRENADE_RELAY_APNS_TOPICS` | `com.adamchew.grenade` | Bundle ids the key sends for, separated by commas. |
| `GRENADE_LOG` | `info` | `debug` also logs every phone connecting and leaving, and every push sent. |

## Pointing a Mac at your relay

On each Mac, with the Grenade daemon installed:

```bash
grenade relay on https://203.0.113.7                   # an open relay, by IP
grenade relay on https://relay.example.com              # an open relay, by name
grenade relay on https://203.0.113.7 --key <key>        # a relay with a registration key
grenade relay on                                        # the main relay, relay.grenade.dev
```

Phones that already paired with that Mac learn the relay the next time they connect on the same Wi‑Fi. From then on they reach the Mac from any network, and show whether it is online and its IP addresses.

## Push notifications

A phone is told that an agent needs it, or has finished, even while the app is closed. The Mac seals each notification for the phone and posts it to the relay's push route, `POST /v1/push`. The relay hands it to Apple's push service (APNs), which needs a key tied to the app. The Mac cannot hold that key, so a relay does.

What a relay learns from a push:

- the phone's device token (the address Apple delivers to),
- the public IP the push came from, and the time,
- the size of a blob it cannot open.

It does not learn the session's name, the question, or which Mac the push is for. It keeps nothing: the Mac sends the device token with every push, and the relay never writes a device token to its log (a log line names a phone by the first 8 hex digits of the token's SHA-256).

The route is limited to 60 pushes a minute per sender address and 20 a minute per phone. On a relay with a registration key, a push must bring that key.

### On your own relay

Only the main relay holds the key for the Grenade app from the App Store. So by default your relay passes each push, unchanged and still sealed, to the main relay, which sends it. The main relay then sees what is listed above, with your relay's address as the sender. Nothing to set up.

- **Turn that off:** `GRENADE_RELAY_PUSH_UPSTREAM=off`. Your relay then answers `503` to pushes, and phones notify only while the app is running.
- **Pass pushes to another relay:** `GRENADE_RELAY_PUSH_UPSTREAM=https://relay.example.com`, plus `GRENADE_RELAY_PUSH_UPSTREAM_KEY` when that relay has a registration key.
- **Send them yourself:** if you ship your own build of the app, create an APNs key for your Apple Developer team and set `GRENADE_RELAY_APNS_KEY` (or `GRENADE_RELAY_APNS_KEY_FILE`), `GRENADE_RELAY_APNS_KEY_ID`, `GRENADE_RELAY_APNS_TEAM_ID` and `GRENADE_RELAY_APNS_TOPICS` (your bundle id). A relay with a key passes nothing on, and answers `403` for apps it has no key for.

A push that was passed on once is never passed on again, so two relays that point at each other cannot loop.

## Dashboard

With `GRENADE_RELAY_ADMIN_KEY` set, open `https://<RELAY_HOST>/` and sign in with any user name and the admin key. It lists every Mac on the relay: online or last seen, public IP, local IPs, version. It refreshes every 15 seconds.

## How it works

The wire contract is in `grenade-protocol/PROTOCOL.md`, under "Remote access (relay)". In short:

- A Mac holds one WebSocket to `/v1/daemon`. It registers a random relay id plus a secret; the first Mac to register an id owns it. The relay pings every 15 s and marks the Mac offline after 30 s of silence.
- A phone opens `/v1/connect/<relay id>` with its access key. The relay tells the Mac `open`, then forwards `data` both ways until either side closes.
- `GET /v1/presence/<relay id>` (same access key) answers whether the Mac is online and its IPs, even while it is off.
- `POST /v1/push` sends one sealed push to a phone. It is in `PROTOCOL.md` under "Push notifications".

## License

MIT
