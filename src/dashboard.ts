/** Pure: the admin dashboard, one self-contained HTML page listing every daemon on the relay. */
import type { Presence } from "./frames.js";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** "under a minute", "5 min", "3 h", "2 d". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "under a minute";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function ago(ms: number): string {
  return ms < 60_000 ? "just now" : `${duration(ms)} ago`;
}

export function renderDashboard(daemons: Presence[], now: number, version: string): string {
  const online = daemons.filter((d) => d.online).length;
  const rows = daemons.map((d) => row(d, now)).join("\n");
  const empty = `<tr><td colspan="6" class="empty">No Macs have connected to this relay yet. On a Mac: <code>grenade relay on &lt;this relay's URL&gt;</code></td></tr>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Grenade relay</title>
<style>
:root { --ground: #F3E9D2; --card: #FBF6EA; --ink: #141413; --muted: #6B665C; --line: #E2D6BA; --accent: #E0A93A; --on: #4CC38A; --off: #8A9099; }
@media (prefers-color-scheme: dark) { :root { --ground: #141413; --card: #1E1E1C; --ink: #F3E9D2; --muted: #A39C8C; --line: #2E2D29; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--ground); color: var(--ink); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 16px; }
h1 { font-size: 22px; margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }
h1 .mark { width: 14px; height: 14px; border-radius: 4px; background: var(--accent); }
.sub { color: var(--muted); margin: 0 0 24px; }
.table { background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
.name { font-weight: 600; }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 7px; vertical-align: 1px; }
.dot.on { background: var(--on); } .dot.off { background: var(--off); }
.muted, .empty { color: var(--muted); }
code, .mono { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
footer { color: var(--muted); font-size: 13px; margin-top: 16px; }
</style>
</head>
<body>
<main>
<h1><span class="mark"></span>Grenade relay</h1>
<p class="sub">${online} of ${daemons.length} Mac${daemons.length === 1 ? "" : "s"} online · refreshes every 15 s</p>
<div class="table"><table>
<thead><tr><th>Mac</th><th>Status</th><th>Public IP</th><th>Local IPs</th><th>Version</th><th>Relay id</th></tr></thead>
<tbody>
${daemons.length ? rows : empty}
</tbody>
</table></div>
<footer>grenade-relay ${escapeHtml(version)} · the relay forwards end-to-end encrypted frames and never sees a terminal.</footer>
</main>
</body>
</html>
`;
}

function row(d: Presence, now: number): string {
  const status = d.online
    ? `<span class="dot on"></span>Online <span class="muted">· for ${escapeHtml(duration(now - Date.parse(d.since ?? d.lastSeen)))}</span>`
    : `<span class="dot off"></span>Offline <span class="muted">· last seen ${escapeHtml(ago(now - Date.parse(d.lastSeen)))}</span>`;
  return `<tr><td class="name">${escapeHtml(d.name)}</td><td>${status}</td><td class="mono">${escapeHtml(d.publicIp ?? "—")}</td><td class="mono">${
    d.localIps.length ? d.localIps.map(escapeHtml).join("<br>") : "—"
  }</td><td class="mono">${escapeHtml(d.version)}</td><td class="mono muted">${escapeHtml(d.id)}</td></tr>`;
}
