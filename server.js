import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const port = Number(process.env.PORT || 8080);
const wss = new WebSocketServer({ port });
let nextPeerId = 1;

const CHUNK_SIZE = 16;
const peers = new Map(); // socket -> { id, name, skin, room, state }
const rooms = new Map(); // room -> Set<socket>

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const WORLD_FILE = path.join(DATA_DIR, "world-state.json");

// room -> chunkKey -> blockKey -> { x, y, z, id }
const roomChunks = new Map();
let persistTimer = null;

function normalizeRoom(room) {
  return String(room || "GLOBAL").trim().toUpperCase().slice(0, 32) || "GLOBAL";
}

function blockChunkKey(x, z) {
  return `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
}

function blockKey(x, y, z) {
  return `${x},${y},${z}`;
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

function ensureRoomChunks(room) {
  if (!roomChunks.has(room)) roomChunks.set(room, new Map());
  return roomChunks.get(room);
}

function setRoomBlock(room, x, y, z, id) {
  const chunks = ensureRoomChunks(room);
  const cKey = blockChunkKey(x, z);
  if (!chunks.has(cKey)) chunks.set(cKey, new Map());
  const cMap = chunks.get(cKey);
  const bKey = blockKey(x, y, z);

  if (id <= 0) {
    cMap.delete(bKey);
    if (cMap.size === 0) chunks.delete(cKey);
    if (chunks.size === 0) roomChunks.delete(room);
    schedulePersist();
    return;
  }

  cMap.set(bKey, { x, y, z, id });
  schedulePersist();
}

function getChunkBlocks(room, cx, cz) {
  const chunks = roomChunks.get(room);
  if (!chunks) return [];
  const cMap = chunks.get(`${cx},${cz}`);
  if (!cMap) return [];
  return Array.from(cMap.values());
}

function serializeWorldState() {
  const out = { rooms: {} };
  for (const [room, chunks] of roomChunks) {
    const roomData = {};
    for (const [cKey, blockMap] of chunks) {
      roomData[cKey] = Array.from(blockMap.values());
    }
    out.rooms[room] = roomData;
  }
  return out;
}

function hydrateWorldState(raw) {
  roomChunks.clear();
  if (!raw || typeof raw !== "object" || !raw.rooms || typeof raw.rooms !== "object") return;

  for (const [room, roomData] of Object.entries(raw.rooms)) {
    if (!roomData || typeof roomData !== "object") continue;
    const chunks = new Map();

    for (const [cKey, blocks] of Object.entries(roomData)) {
      if (!Array.isArray(blocks)) continue;
      const blockMap = new Map();
      for (const b of blocks) {
        const x = Number(b?.x);
        const y = Number(b?.y);
        const z = Number(b?.z);
        const id = Number(b?.id);
        if (![x, y, z, id].every(Number.isFinite)) continue;
        if (id <= 0) continue;
        blockMap.set(blockKey(x, y, z), { x, y, z, id });
      }
      if (blockMap.size > 0) chunks.set(cKey, blockMap);
    }

    if (chunks.size > 0) roomChunks.set(room, chunks);
  }
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(WORLD_FILE, JSON.stringify(serializeWorldState()));
    } catch (err) {
      console.error("[VoxelVerse WS] failed to persist world state", err);
    }
  }, 250);
}

function loadPersistedWorld() {
  try {
    if (!fs.existsSync(WORLD_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(WORLD_FILE, "utf8"));
    hydrateWorldState(raw);
    console.log("[VoxelVerse WS] loaded persisted world state");
  } catch (err) {
    console.error("[VoxelVerse WS] failed to load persisted world state", err);
  }
}

loadPersistedWorld();

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
      heldBlock: 2
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
            moving: !!roomPeer.state.moving,
            crouching: !!roomPeer.state.crouching,
            punchAnim: Number(roomPeer.state.punchAnim) || 0,
            placeAnim: Number(roomPeer.state.placeAnim) || 0,
            heldBlock: Number(roomPeer.state.heldBlock) || 2
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

      setRoomBlock(peer.room, x, y, z, id);
      broadcastToRoom(peer.room, { type: "BLOCK", x, y, z, id }, ws);
      return;
    }

    if (msg.type === "CHUNK_REQUEST") {
      const cx = Number(msg.cx);
      const cz = Number(msg.cz);
      if (![cx, cz].every(Number.isFinite)) return;
      const blocks = getChunkBlocks(peer.room, cx, cz);
      ws.send(JSON.stringify({ type: "CHUNK_DATA", cx, cz, blocks }));
      return;
    }

    if (msg.type === "PLAYER_STATE") {
      const x = Number(msg.x);
      const y = Number(msg.y);
      const z = Number(msg.z);
      const yaw = Number(msg.yaw);
      const pitch = Number(msg.pitch);
      const moving = !!msg.moving;
      const crouching = !!msg.crouching;
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
        moving,
        crouching,
        punchAnim: Number.isFinite(punchAnim) ? punchAnim : 0,
        placeAnim: Number.isFinite(placeAnim) ? placeAnim : 0,
        heldBlock: Number.isFinite(heldBlock) ? heldBlock : 2
      };

      broadcastToRoom(peer.room, {
        type: "PLAYER_STATE",
        id: peer.id,
        name: peer.name,
        skin: peer.skin,
        x,
        y,
        z,
        yaw,
        pitch,
        moving,
        crouching,
        punchAnim: peer.state.punchAnim,
        placeAnim: peer.state.placeAnim,
        heldBlock: peer.state.heldBlock
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

wss.on("close", () => {
  clearInterval(interval);
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WORLD_FILE, JSON.stringify(serializeWorldState()));
  } catch (err) {
    console.error("[VoxelVerse WS] failed final world save", err);
  }
});

process.on("SIGINT", () => {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WORLD_FILE, JSON.stringify(serializeWorldState()));
  } catch {}
  process.exit(0);
});

console.log(`[VoxelVerse WS] listening on :${port}`);
