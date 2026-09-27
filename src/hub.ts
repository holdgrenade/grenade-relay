/**
 * The relay's live state: which daemon links are up and which phone pipes ride on them.
 * Transport-agnostic: the server hands it sockets as `Pipe`s and raw text, so tests drive it with fakes.
 * It owns registration (TOFU claim of a relay id), routing of open/data/close, and presence.
 */
import { keyMatches, safeEqual, sha256hex } from "./auth.js";
import { safeCloseCode, safeCloseReason } from "./closeCode.js";
import {
  CLOSE_DAEMON_OFFLINE,
  RELAY_PROTOCOL_VERSION,
  parseRelayDaemonFrame,
  type Presence,
  type RelayErrorCode,
  type RelayRegisterFrame,
  type RelayServerFrame,
} from "./frames.js";
import type { Logger } from "./log.js";
import { byPresence, presenceOf } from "./presence.js";
import type { DaemonRecord, DaemonStore } from "./store.js";

/** The two things the hub does with any socket. */
export interface Pipe {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export const MAX_PIPES_PER_DAEMON = 8;
/** Close code for a daemon link that another link with the same id replaced. */
export const CLOSE_REPLACED = 4000;

/** One daemon's WebSocket, before and after it registers. */
export class DaemonLink {
  id: string | null = null;
  since = 0;
  closed = false;
  nextConn = 1;
  readonly pipes = new Map<string, PhonePipe>();
  constructor(readonly socket: Pipe, readonly ip: string | undefined, readonly authorization: string | null) {}
}

export class PhonePipe {
  closed = false;
  constructor(readonly socket: Pipe, readonly link: DaemonLink, readonly conn: string) {}
}

export type Admission = "ok" | "unauthorized" | "unknown" | "offline" | "busy";

export interface HubDeps {
  store: DaemonStore;
  log: Logger;
  registrationKey?: string | undefined;
  now?: () => number;
}

export class Hub {
  private readonly live = new Map<string, DaemonLink>();
  private readonly now: () => number;

  constructor(private readonly d: HubDeps) {
    this.now = d.now ?? Date.now;
  }

  // ---- daemon links -----------------------------------------------------------

  /** A daemon's WebSocket opened. `authorization` is the bearer token it presented, if any. */
  attachDaemon(socket: Pipe, ip: string | undefined, authorization: string | null): DaemonLink {
    return new DaemonLink(socket, ip, authorization);
  }

  isRegistered(link: DaemonLink): boolean {
    return link.id !== null && this.live.get(link.id) === link;
  }

  handleDaemonMessage(link: DaemonLink, raw: string): void {
    if (link.closed) return;
    const parsed = parseRelayDaemonFrame(raw);
    if (!parsed.ok) return this.refuse(link, "bad_frame", parsed.message);
    const frame = parsed.frame;
    if (link.id === null) {
      if (frame.type !== "register") return this.refuse(link, "bad_frame", "the first frame must be register");
      return this.register(link, frame);
    }
    if (!this.isRegistered(link)) return;
    switch (frame.type) {
      case "register":
        return this.refuse(link, "bad_frame", "already registered");
      case "update":
        return this.update(link.id, frame);
      case "data": {
        const pipe = link.pipes.get(frame.conn);
        if (pipe && !pipe.closed) pipe.socket.send(frame.text);
        return;
      }
      case "close": {
        const pipe = link.pipes.get(frame.conn);
        if (!pipe) return;
        link.pipes.delete(frame.conn);
        pipe.closed = true;
        pipe.socket.close(safeCloseCode(frame.code), safeCloseReason(frame.reason));
        return;
      }
    }
  }

  /** The daemon's socket closed (or was terminated for missing pongs). */
  handleDaemonClose(link: DaemonLink): void {
    if (link.closed) return;
    link.closed = true;
    this.closePipes(link, "mac went offline");
    if (link.id === null || this.live.get(link.id) !== link) return;
    this.live.delete(link.id);
    const record = this.d.store.get(link.id);
    if (record) this.d.store.put({ ...record, lastSeen: new Date(this.now()).toISOString() });
    this.d.log.info(`Mac went offline: ${record?.name ?? link.id}`, { id: link.id });
  }

  private register(link: DaemonLink, frame: RelayRegisterFrame): void {
    if (!keyMatches(this.d.registrationKey, link.authorization)) return this.refuse(link, "unauthorized", "this relay needs a registration key");
    if (frame.protocol !== RELAY_PROTOCOL_VERSION) return this.refuse(link, "bad_frame", `unsupported protocol ${frame.protocol}`);
    const now = this.now();
    const secretHash = sha256hex(frame.secret);
    const existing = this.d.store.get(frame.id);
    if (existing && !safeEqual(existing.secretHash, secretHash)) return this.refuse(link, "id_taken", "this relay id belongs to another Mac");

    const previous = this.live.get(frame.id);
    if (previous && previous !== link) {
      previous.closed = true;
      this.closePipes(previous, "mac reconnected");
      previous.socket.close(CLOSE_REPLACED, "replaced by a newer link");
    }

    const record: DaemonRecord = {
      id: frame.id,
      secretHash,
      name: frame.name,
      version: frame.version,
      access: frame.access,
      localIps: frame.localIps,
      lastSeen: new Date(now).toISOString(),
      createdAt: existing?.createdAt ?? new Date(now).toISOString(),
    };
    if (link.ip) record.publicIp = link.ip;
    this.d.store.put(record);
    link.id = frame.id;
    link.since = now;
    this.live.set(frame.id, link);
    this.sendTo(link, link.ip ? { type: "registered", publicIp: link.ip } : { type: "registered" });
    this.d.log.info(`Mac online: ${frame.name}`, { id: frame.id, ip: link.ip, new: existing ? undefined : true });
  }

  private update(id: string, frame: { name?: string | undefined; localIps?: string[] | undefined; access?: string[] | undefined }): void {
    const record = this.d.store.get(id);
    if (!record) return;
    this.d.store.put({
      ...record,
      ...(frame.name !== undefined ? { name: frame.name } : {}),
      ...(frame.localIps !== undefined ? { localIps: frame.localIps } : {}),
      ...(frame.access !== undefined ? { access: frame.access } : {}),
      lastSeen: new Date(this.now()).toISOString(),
    });
  }

  private refuse(link: DaemonLink, code: RelayErrorCode, message: string): void {
    this.sendTo(link, { type: "error", code, message });
    this.d.log.warn(`Refused a Mac link: ${message}`, { code, id: link.id ?? undefined, ip: link.ip });
    link.socket.close(4400, safeCloseReason(message));
    this.handleDaemonClose(link);
  }

  private closePipes(link: DaemonLink, reason: string): void {
    for (const pipe of link.pipes.values()) {
      pipe.closed = true;
      pipe.socket.close(CLOSE_DAEMON_OFFLINE, reason);
    }
    link.pipes.clear();
  }

  private sendTo(link: DaemonLink, frame: RelayServerFrame): void {
    if (!link.closed) link.socket.send(JSON.stringify(frame));
  }

  // ---- phone pipes ------------------------------------------------------------

  /** Whether a phone presenting `access` may open a pipe to `id`. Checked before the WebSocket upgrade. */
  admitPhone(id: string, access: string | null): Admission {
    const record = this.d.store.get(id);
    if (!record) return "unknown";
    if (!this.accessOk(record, access)) return "unauthorized";
    const link = this.live.get(id);
    if (!link) return "offline";
    if (link.pipes.size >= MAX_PIPES_PER_DAEMON) return "busy";
    return "ok";
  }

  /** The phone's WebSocket is up. Returns null (and closes it) if the daemon went away meanwhile. */
  attachPhone(id: string, socket: Pipe, ip: string | undefined): PhonePipe | null {
    const link = this.live.get(id);
    if (!link) {
      socket.close(CLOSE_DAEMON_OFFLINE, "mac is offline");
      return null;
    }
    const conn = `c${link.nextConn++}`;
    const pipe = new PhonePipe(socket, link, conn);
    link.pipes.set(conn, pipe);
    this.sendTo(link, ip ? { type: "open", conn, ip } : { type: "open", conn });
    this.d.log.debug("Phone connected", { id, conn, ip });
    return pipe;
  }

  handlePhoneMessage(pipe: PhonePipe, text: string): void {
    if (pipe.closed) return;
    this.sendTo(pipe.link, { type: "data", conn: pipe.conn, text });
  }

  handlePhoneClose(pipe: PhonePipe): void {
    if (pipe.closed) return;
    pipe.closed = true;
    pipe.link.pipes.delete(pipe.conn);
    this.sendTo(pipe.link, { type: "close", conn: pipe.conn });
    this.d.log.debug("Phone disconnected", { id: pipe.link.id ?? undefined, conn: pipe.conn });
  }

  // ---- presence -----------------------------------------------------------------

  /** GET /v1/presence/<id>. */
  presence(id: string, access: string | null): { status: 200; body: Presence } | { status: 401 | 404; body: { error: string } } {
    const record = this.d.store.get(id);
    if (!record) return { status: 404, body: { error: "unknown_daemon" } };
    if (!this.accessOk(record, access)) return { status: 401, body: { error: "unauthorized" } };
    return { status: 200, body: this.presenceOf(record) };
  }

  /** Every daemon, for the admin list and dashboard. */
  list(): Presence[] {
    return this.d.store.all().map((r) => this.presenceOf(r)).sort(byPresence);
  }

  isLive(id: string): boolean {
    return this.live.has(id);
  }

  /** Closes every link and pipe (shutdown). */
  closeAll(): void {
    for (const link of [...this.live.values()]) {
      link.socket.close(1001, "relay stopping");
      this.handleDaemonClose(link);
    }
  }

  private presenceOf(record: DaemonRecord): Presence {
    return presenceOf(record, this.live.get(record.id)?.since ?? null, this.now());
  }

  private accessOk(record: DaemonRecord, access: string | null): boolean {
    if (!access) return false;
    const hash = sha256hex(access);
    return record.access.some((h) => safeEqual(h, hash));
  }
}
