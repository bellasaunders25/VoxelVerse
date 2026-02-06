import { WebSocketServer } from "ws";

const port = Number(process.env.PORT || 8080);
const wss = new WebSocketServer({ port });
let nextPeerId = 1;

const peers = new Map(); // socket -> { id, name, skin, room, state }
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
  peers.set(ws, {
    id: `p${nextPeerId++}`,
    name: "Player",
    skin: "",
    room: "GLOBAL",
    state: {
      x: 0,
      y: 80,
      z: 0,
      yaw: 0,
      pitch: 0,
      moving: false,
      crouching: false,
      punchAnim: 0,
      placeAnim: 0,
      heldBlock: 0
    }
  });
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
      peer.skin = typeof msg.skin === "string" ? msg.skin.slice(0, 200000) : "";
      peer.room = room;

      if (oldRoom !== room) {
        removeFromRoom(ws, oldRoom);
        addToRoom(ws, room);
      }

      const roomPeers = rooms.get(room);
      const snapshot = [];
      if (roomPeers) {
        for (const client of roomPeers) {
          if (client === ws) continue;
          const roomPeer = peers.get(client);
          if (!roomPeer) continue;
          snapshot.push({
            id: roomPeer.id,
            name: roomPeer.name,
            skin: roomPeer.skin,
            x: roomPeer.state.x,
            y: roomPeer.state.y,
            z: roomPeer.state.z,
            yaw: roomPeer.state.yaw,
            pitch: roomPeer.state.pitch,
            moving: roomPeer.state.moving,
            crouching: roomPeer.state.crouching,
            punchAnim: roomPeer.state.punchAnim,
            placeAnim: roomPeer.state.placeAnim,
            heldBlock: roomPeer.state.heldBlock
          });
        }
      }

      ws.send(JSON.stringify({ type: "SYSTEM", text: `Joined room ${room}` }));
      ws.send(JSON.stringify({ type: "ROOM_SNAPSHOT", peers: snapshot }));
      ws.send(JSON.stringify({ type: "SELF", id: peer.id }));
      broadcastToRoom(room, { type: "PLAYER_JOIN", id: peer.id, name: peer.name, skin: peer.skin }, ws);
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
      return;
    }

    if (msg.type === "PLAYER_STATE") {
      const x = Number(msg.x);
      const y = Number(msg.y);
      const z = Number(msg.z);
      const yaw = Number(msg.yaw);
      const pitch = Number(msg.pitch);
      const punchAnim = Number(msg.punchAnim);
      const placeAnim = Number(msg.placeAnim);
      const heldBlock = Number(msg.heldBlock);
      if (![x, y, z, yaw, pitch].every(Number.isFinite)) return;

      peer.state = {
        x,
        y,
        z,
        yaw,
        pitch,
        moving: !!msg.moving,
        crouching: !!msg.crouching,
        punchAnim: Number.isFinite(punchAnim) ? Math.max(0, Math.min(1, punchAnim)) : 0,
        placeAnim: Number.isFinite(placeAnim) ? Math.max(0, Math.min(1, placeAnim)) : 0,
        heldBlock: Number.isFinite(heldBlock) ? heldBlock : 0
      };
      broadcastToRoom(peer.room, {
        type: "PLAYER_STATE",
        id: peer.id,
        name: peer.name,
        skin: peer.skin,
        ...peer.state
      }, ws);
    }
  });

  ws.on("close", () => {
    const peer = peers.get(ws);
    if (!peer) return;
    removeFromRoom(ws, peer.room);
    broadcastToRoom(peer.room, { type: "PLAYER_LEAVE", id: peer.id }, ws);
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
