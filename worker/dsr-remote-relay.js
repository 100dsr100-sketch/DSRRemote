/* ============================================================
   DSR Remote — relay Worker  (Cloudflare Workers, Durable Objects)
   ------------------------------------------------------------
   Pure two-party WebSocket relay between the PC host app and the
   Android controller app. The room name IS the pairing token, so
   knowing the token is the only auth (same trust model as the
   LAN token baked into DSR Plex Client) — keep both app repos
   private. The relay never inspects or stores screen frames,
   input events, clipboard text or file bytes; it only forwards
   whatever one side sends to whichever other socket is in the
   same room. Max two sockets per room (host + controller) so a
   leaked token can't be used to silently join an active session
   as a third party.

   Uses the WebSocket Hibernation API (see DSR LiveChat's
   ChatRoom for the same pattern) so an idle-but-connected pairing
   doesn't rack up Durable Object active duration.
   ============================================================ */

export class RemoteRoom {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }
    if (this.state.getWebSockets().length >= 2) {
      return new Response('Room full', { status: 409 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Fan out to the other socket in the room (there are only ever up to
  // two — the PC host and the Android controller). Binary frames (screen
  // JPEGs, file chunks) and text frames (JSON control messages) are
  // relayed as-is, untouched.
  async webSocketMessage(ws, message) {
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
