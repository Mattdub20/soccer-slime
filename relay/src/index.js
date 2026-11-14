// Soccer Slime online relay.
// Players connect to  wss://<worker>/room/<CODE>?role=host|join
// Everything one player sends is passed straight to the other player in the same room.
// The relay also sends small status messages of its own, always shaped {"relay": "..."}:
//   waiting      you're the host and nobody has joined yet
//   peer-here    the other player is already connected
//   peer-joined  the other player just connected
//   peer-left    the other player disconnected
//   nohost       you tried to join a code nobody is hosting
//   full         someone has already joined that room

const ALLOWED_ORIGINS = [
  /^https:\/\/soccerslime\.web\.app$/,
  /^https:\/\/soccerslime\.firebaseapp\.com$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([A-Za-z0-9]{3,12})$/);
    if (!match) return new Response("Soccer Slime relay is running.", { status: 200 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket.", { status: 426 });
    const origin = request.headers.get("Origin") || "";
    if (origin && !ALLOWED_ORIGINS.some((re) => re.test(origin))) return new Response("Not allowed.", { status: 403 });
    const room = env.ROOMS.get(env.ROOMS.idFromName(match[1].toUpperCase()));
    return room.fetch(request);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const role = new URL(request.url).searchParams.get("role") === "host" ? "host" : "join";
    const other = role === "host" ? "join" : "host";
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server, [role]);

    const status = (ws, s) => { try { ws.send(JSON.stringify({ relay: s })); } catch (e) {} };

    if (role === "join") {
      if (this.state.getWebSockets("host").length === 0) { status(server, "nohost"); server.close(4004, "no host"); return new Response(null, { status: 101, webSocket: client }); }
      if (this.state.getWebSockets("join").length > 1) { status(server, "full"); server.close(4009, "room full"); return new Response(null, { status: 101, webSocket: client }); }
    } else {
      // a host reconnecting replaces its old connection
      for (const old of this.state.getWebSockets("host")) if (old !== server) { try { old.close(4001, "replaced"); } catch (e) {} }
    }

    const others = this.state.getWebSockets(other);
    others.forEach((ws) => status(ws, "peer-joined"));
    status(server, others.length ? "peer-here" : "waiting");
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const role = this.state.getTags(ws)[0];
    const target = role === "host" ? "join" : "host";
    for (const o of this.state.getWebSockets(target)) { try { o.send(message); } catch (e) {} }
  }

  webSocketClose(ws) { this.left(ws); }
  webSocketError(ws) { this.left(ws); }

  left(ws) {
    const role = this.state.getTags(ws)[0];
    const target = role === "host" ? "join" : "host";
    for (const o of this.state.getWebSockets(target)) { try { o.send(JSON.stringify({ relay: "peer-left" })); } catch (e) {} }
  }
}
