const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Security headers
app.use((req, res, next) => {
  res.set({
    "X-XSS-Protection": "1; mode=block",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin"
  });
  next();
});

app.use(express.static(__dirname + "/public"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 30000,
  pingInterval: 10000,
  transports: ["websocket", "polling"]
});

// ─── ICE / TURN credentials ────────────────────────────────
const CF_APP_ID     = process.env.CF_APP_ID     || '';
const CF_APP_SECRET = process.env.CF_APP_SECRET || '';

const STUN_ONLY = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" }
];

app.get("/ice", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (!CF_APP_ID || !CF_APP_SECRET) return res.json(STUN_ONLY);
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${CF_APP_ID}/credentials/generate`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${CF_APP_SECRET}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ttl: 86400 })
      }
    );
    if (!r.ok) throw new Error("CF status " + r.status);
    const data = await r.json();
    res.json(data.iceServers || STUN_ONLY);
  } catch (e) {
    console.error("[ICE] error:", e.message);
    res.json(STUN_ONLY);
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", online: onlineUsers.size }));

// ─── State ─────────────────────────────────────────────────
// uid → socketId  (who is currently online)
const onlineUsers = new Map();
// socketId → uid
const socketToUid = new Map();
// callId → { callerUid, calleeUid, socketCaller, socketCallee, type }
const activeCalls = new Map();

// ─── Helpers ───────────────────────────────────────────────
function getSocketForUid(uid) {
  const sid = onlineUsers.get(uid);
  if (!sid) return null;
  return io.sockets.sockets.get(sid) || null;
}

// ─── Socket events ─────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[+] socket ${socket.id}`);

  // User comes online with their Google UID
  socket.on("user-online", (data) => {
    const { uid, displayName, photoURL } = data;
    if (!uid) return;

    // Remove old socket entry if they reconnected
    const oldSid = onlineUsers.get(uid);
    if (oldSid && oldSid !== socket.id) {
      socketToUid.delete(oldSid);
    }

    onlineUsers.set(uid, socket.id);
    socketToUid.set(socket.id, uid);
    socket.uid = uid;
    socket.displayName = displayName;
    socket.photoURL = photoURL;

    console.log(`[online] ${displayName} (${uid})`);
  });

  // Check if a UID is online
  socket.on("check-online", (uid, cb) => {
    cb({ online: onlineUsers.has(uid) });
  });

  // ─── Incoming Call ────────────────────────────────────────
  socket.on("call-user", (data) => {
    const { calleeUid, callType, callId } = data; // callType: 'video' | 'voice'
    const callerUid = socket.uid;
    if (!callerUid || !calleeUid) return;

    const calleeSocket = getSocketForUid(calleeUid);
    if (!calleeSocket) {
      socket.emit("call-failed", { reason: "User is offline" });
      return;
    }

    activeCalls.set(callId, {
      callerUid, calleeUid,
      callerSocket: socket.id,
      calleeSocket: calleeSocket.id,
      type: callType,
      state: "ringing"
    });

    calleeSocket.emit("incoming-call", {
      callId,
      callType,
      callerUid,
      callerName: socket.displayName,
      callerPhoto: socket.photoURL
    });

    console.log(`[call] ${callerUid} → ${calleeUid} (${callType})`);
  });

  // ─── Accept Call ──────────────────────────────────────────
  socket.on("accept-call", (data) => {
    const { callId } = data;
    const call = activeCalls.get(callId);
    if (!call) return;

    call.state = "connected";
    const callerSocket = io.sockets.sockets.get(call.callerSocket);
    if (callerSocket) {
      callerSocket.emit("call-accepted", { callId, calleeUid: call.calleeUid });
    }
    console.log(`[accept] callId ${callId}`);
  });

  // ─── Reject / Busy ────────────────────────────────────────
  socket.on("reject-call", (data) => {
    const { callId, reason } = data;
    const call = activeCalls.get(callId);
    if (!call) return;

    const callerSocket = io.sockets.sockets.get(call.callerSocket);
    if (callerSocket) {
      callerSocket.emit("call-rejected", { callId, reason: reason || "declined" });
    }
    activeCalls.delete(callId);
    console.log(`[reject] callId ${callId}`);
  });

  // ─── End Call ─────────────────────────────────────────────
  socket.on("end-call", (data) => {
    const { callId } = data;
    const call = activeCalls.get(callId);
    if (!call) return;

    const otherSocketId = socket.id === call.callerSocket ? call.calleeSocket : call.callerSocket;
    const otherSocket = io.sockets.sockets.get(otherSocketId);
    if (otherSocket) {
      otherSocket.emit("call-ended", { callId });
    }
    activeCalls.delete(callId);
    console.log(`[end] callId ${callId}`);
  });

  // ─── WebRTC Signaling ─────────────────────────────────────
  socket.on("signal", (data) => {
    const { callId, signal } = data;
    const call = activeCalls.get(callId);
    if (!call) return;

    const targetSid = socket.id === call.callerSocket ? call.calleeSocket : call.callerSocket;
    const targetSocket = io.sockets.sockets.get(targetSid);
    if (targetSocket) {
      targetSocket.emit("signal", { callId, signal, from: socket.uid });
    }
  });

  // ─── Disconnect ───────────────────────────────────────────
  socket.on("disconnect", (reason) => {
    const uid = socketToUid.get(socket.id);
    if (uid && onlineUsers.get(uid) === socket.id) {
      onlineUsers.delete(uid);
    }
    socketToUid.delete(socket.id);

    // End any active calls
    for (const [callId, call] of activeCalls) {
      if (call.callerSocket === socket.id || call.calleeSocket === socket.id) {
        const otherSid = call.callerSocket === socket.id ? call.calleeSocket : call.callerSocket;
        const otherSocket = io.sockets.sockets.get(otherSid);
        if (otherSocket) otherSocket.emit("call-ended", { callId, reason: "disconnected" });
        activeCalls.delete(callId);
      }
    }

    console.log(`[-] ${uid || socket.id} disconnected (${reason})`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`DirectCall server on port ${PORT}`));
