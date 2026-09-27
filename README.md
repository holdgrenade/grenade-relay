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
| `GRENADE_LOG` | `info` | `debug` also logs every phone connecting and leaving. |

## Pointing a Mac at your relay

On each Mac, with the Grenade daemon installed:

```bash
grenade relay on https://203.0.113.7                   # an open relay, by IP
grenade relay on https://relay.example.com              # an open relay, by name
grenade relay on https://203.0.113.7 --key <key>        # a relay with a registration key
grenade relay on                                        # the main relay, relay.grenade.dev
```

Phones that already paired with that Mac learn the relay the next time they connect on the same Wi‑Fi. From then on they reach the Mac from any network, and show whether it is online and its IP addresses.

## Dashboard

With `GRENADE_RELAY_ADMIN_KEY` set, open `https://<RELAY_HOST>/` and sign in with any user name and the admin key. It lists every Mac on the relay: online or last seen, public IP, local IPs, version. It refreshes every 15 seconds.

## How it works

The wire contract is in `grenade-protocol/PROTOCOL.md`, under "Remote access (relay)". In short:

- A Mac holds one WebSocket to `/v1/daemon`. It registers a random relay id plus a secret; the first Mac to register an id owns it. The relay pings every 15 s and marks the Mac offline after 30 s of silence.
- A phone opens `/v1/connect/<relay id>` with its access key. The relay tells the Mac `open`, then forwards `data` both ways until either side closes.
- `GET /v1/presence/<relay id>` (same access key) answers whether the Mac is online and its IPs, even while it is off.

## License

MIT
