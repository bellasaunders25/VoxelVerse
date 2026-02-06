import { WebSocketServer } from "ws";

const port = Number(process.env.PORT || 8080);
const wss = new WebSocketServer({ port });

const peers = new Map(); // socket -> { name, room }
const rooms = new Map(); // room -> Set<socket>

function normalizeRoom(room) {
  return String(room || "GLOBAL").trim().toUpperCase().slice(0, 32) || "GLOBAL";
}

function addToRoom(ws, room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
}

function removeFromRoom(ws, room) {
  const set = rooms.get(room);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) rooms.delete(room);
}

function broadcastToRoom(room, payload, except = null) {
  const set = rooms.get(room);
  if (!set) return;
  const encoded = JSON.stringify(payload);
  for (const client of set) {
    if (client === except) continue;
    if (client.readyState === 1) {
      client.send(encoded);
    }
  }
}

wss.on("connection", (ws) => {
  peers.set(ws, { name: "Player", room: "GLOBAL" });
  addToRoom(ws, "GLOBAL");

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    const peer = peers.get(ws);
    if (!peer || !msg || typeof msg !== "object") return;

    if (msg.type === "JOIN") {
      const oldRoom = peer.room;
      const room = normalizeRoom(msg.room);
      peer.name = typeof msg.name === "string" ? msg.name.slice(0, 24) : "Player";
      peer.room = room;

      if (oldRoom !== room) {
        removeFromRoom(ws, oldRoom);
        addToRoom(ws, room);
      }

      ws.send(JSON.stringify({ type: "SYSTEM", text: `Joined room ${room}` }));
      broadcastToRoom(room, { type: "SYSTEM", text: `${peer.name} joined.` }, ws);
      return;
    }

    if (msg.type === "CHAT") {
      broadcastToRoom(peer.room, {
        type: "CHAT",
        name: peer.name,
        text: String(msg.text || "").slice(0, 280)
      });
      return;
    }

    if (msg.type === "BLOCK") {
      const x = Number(msg.x);
      const y = Number(msg.y);
      const z = Number(msg.z);
      const id = Number(msg.id);
      if (![x, y, z, id].every(Number.isFinite)) return;

      broadcastToRoom(peer.room, { type: "BLOCK", x, y, z, id }, ws);
    }
  });

  ws.on("close", () => {
    const peer = peers.get(ws);
    if (!peer) return;
    removeFromRoom(ws, peer.room);
    broadcastToRoom(peer.room, { type: "SYSTEM", text: `${peer.name} left.` }, ws);
    peers.delete(ws);
  });
});

const interval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.ping();
  }
}, 30000);

wss.on("close", () => clearInterval(interval));

console.log(`[VoxelVerse WS] listening on :${port}`);
