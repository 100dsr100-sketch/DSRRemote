/* ============================================================
   DSR Remote — relay Worker  (Cloudflare Workers, Durable Objects)
   ------------------------------------------------------------
   Pure two-party WebSocket relay between the PC host app and one
   controller (Android, browser). The room name IS the pairing
   token, so knowing the token is the only auth (same trust model
   as the LAN token baked into DSR Plex Client) — keep the app
   repos private. The relay never inspects or stores screen
   frames, input events, clipboard text or file bytes - the only
   content it ever looks at is the "type"/"role" fields of a
   'hello' text message, purely for the eviction logic below.

   Uses the WebSocket Hibernation API (see DSR LiveChat's ChatRoom
   for the same pattern) so an idle-but-connected pairing doesn't
   rack up Durable Object active duration.

   Eviction, not a hard cap - the ORIGINAL version of this file
   just rejected any 3rd connection attempt outright once 2 sockets
   were in the room. That's wrong: a connection that drops without
   a clean close frame (extremely common on a flaky mobile network
   - the OS just loses signal, nothing gets sent) leaves a dead
   socket that Cloudflare has no fast way to notice is actually
   gone. That stale socket then sits in the room indefinitely,
   silently blocking every real reconnect attempt from either
   device with nothing for either side to see or recover from -
   confirmed live, the hard way. Instead: each socket tags itself
   with its role (host/controller) the moment it sends its own
   'hello', and claiming a role evicts any OTHER socket already
   holding that same role. A stale duplicate is gone the instant
   anything new actually tries to take its place, with no timeout
   to wait out and nothing for the user to manually clear.
   ============================================================ */

const MAX_SOCKETS = 4; // generous sanity bound only - role eviction is the real mechanism

export class RemoteRoom {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }
    if (this.state.getWebSockets().length >= MAX_SOCKETS) {
      return new Response('Room full', { status: 409 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  getRole(ws) {
    try {
      const a = ws.deserializeAttachment();
      return a && a.role;
    } catch (err) {
      return undefined;
    }
  }

  async webSocketMessage(ws, message) {
    if (typeof message === 'string') {
      try {
        const parsed = JSON.parse(message);
        if (parsed && parsed.type === 'hello' && parsed.role) {
          for (const other of this.state.getWebSockets()) {
            if (other === ws) continue;
            if (this.getRole(other) === parsed.role) {
              try { other.close(4000, 'Replaced by a newer connection'); } catch (err) { /* already gone */ }
            }
          }
          ws.serializeAttachment({ role: parsed.role });
        }
      } catch (err) { /* not JSON, or not hello - not our concern, just relay it below */ }
    }

    for (const other of this.state.getWebSockets()) {
      if (other === ws) continue;
      try { other.send(message); } catch (err) { /* peer gone, ignore */ }
    }
  }

  webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code, reason); } catch (err) { /* already closed */ }
  }

  webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch (err) { /* already closed */ }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9_-]{16,128})$/);
    if (!m) return new Response('Not found', { status: 404 });

    const token = m[1];
    const id = env.REMOTE_ROOM.idFromName(token);
    return env.REMOTE_ROOM.get(id).fetch(request);
  },
};
