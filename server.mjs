import { createServer } from "node:http";
import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const config = {
  host: process.env.HOST || "127.0.0.1",
  port: numberFromEnv("PORT", 8787, 1, 65_535),
  registrationTimeoutMs: numberFromEnv("REGISTRATION_TIMEOUT_MS", 10_000, 1_000, 60_000),
  joinTimeoutMs: numberFromEnv("JOIN_TIMEOUT_MS", 60_000, 10_000, 300_000),
  resumeGraceMs: numberFromEnv("RESUME_GRACE_MS", 300_000, 10_000, 3_600_000),
  heartbeatMs: numberFromEnv("HEARTBEAT_MS", 25_000, 5_000, 60_000),
  maxBackpressureBytes: numberFromEnv("MAX_BACKPRESSURE_BYTES", 2_000_000, 64_000, 16_000_000),
  maxFrameBytes: numberFromEnv("MAX_FRAME_BYTES", 2_097_152, 64_000, 8_000_000),
  allowedOrigins: new Set(
    String(process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ),
};

const controllerHtml = await readFile(
  fileURLToPath(new URL("./public/index.html", import.meta.url)),
);

const hostsByCode = new Map();
const clients = new Map();
const requests = new Map();
const joinAttempts = new Map();
let shuttingDown = false;
let droppedFrames = 0;

function numberFromEnv(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return Math.trunc(parsed);
}

function sendJson(socket, value) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(value));
  return true;
}

function safeTokenEquals(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function newPairingCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    if (!hostsByCode.has(code)) return code;
  }
  throw new Error("pairing code space exhausted");
}

function clientAddress(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || request.socket.remoteAddress || "unknown";
}

function joinRateLimited(address) {
  const now = Date.now();
  const existing = joinAttempts.get(address);
  if (!existing || now - existing.windowStartedAt >= 60_000) {
    joinAttempts.set(address, { count: 1, windowStartedAt: now });
    return false;
  }
  existing.count += 1;
  return existing.count > 12;
}

function clearPendingRequest(hostInfo, errorCode) {
  if (!hostInfo.requestId) return;
  const pending = requests.get(hostInfo.requestId);
  requests.delete(hostInfo.requestId);
  hostInfo.requestId = null;
  if (!pending) return;
  clearTimeout(pending.timer);
  sendJson(hostInfo.socket, {
    type: "join_cancelled",
    requestId: pending.controllerInfo.requestId,
    reason: errorCode,
  });
  clients.delete(pending.controllerInfo.socket);
  sendJson(pending.controllerInfo.socket, { type: "error", code: errorCode });
  pending.controllerInfo.socket.close(1000, errorCode);
}

function clearResume(hostInfo) {
  hostInfo.resumeToken = null;
  hostInfo.resumeUntil = 0;
  if (hostInfo.resumeTimer) clearTimeout(hostInfo.resumeTimer);
  hostInfo.resumeTimer = null;
}

function expireResume(hostInfo) {
  clearResume(hostInfo);
}

function endController(controller, reason) {
  const info = clients.get(controller);
  if (!info || info.role !== "controller") return;

  clients.delete(controller);
  if (info.requestId) {
    const pending = requests.get(info.requestId);
    if (pending) clearTimeout(pending.timer);
    requests.delete(info.requestId);
    if (info.hostInfo.requestId === info.requestId) info.hostInfo.requestId = null;
    sendJson(info.hostInfo.socket, {
      type: "join_cancelled",
      requestId: info.requestId,
      reason: "controller_disconnected",
    });
  }

  if (info.hostInfo.controller === controller) {
    info.hostInfo.controller = null;
    info.hostInfo.approved = false;
    info.hostInfo.resumeUntil = Date.now() + config.resumeGraceMs;
    if (info.hostInfo.resumeTimer) clearTimeout(info.hostInfo.resumeTimer);
    info.hostInfo.resumeTimer = setTimeout(() => expireResume(info.hostInfo), config.resumeGraceMs);
    info.hostInfo.resumeTimer.unref?.();
    sendJson(info.hostInfo.socket, { type: "controller_disconnected" });
  }

  sendJson(controller, { type: "session_ended", reason });
}

function endHost(host, reason) {
  const info = clients.get(host);
  if (!info || info.role !== "host") return;

  hostsByCode.delete(info.code);
  clients.delete(host);
  clearPendingRequest(info, "host_disconnected");
  clearResume(info);

  if (info.controller) {
    const controller = info.controller;
    clients.delete(controller);
    sendJson(controller, { type: "session_ended", reason });
    if (controller.readyState === WebSocket.OPEN) controller.close(1012, reason);
  }
}

function sanitizeControl(message) {
  const action = String(message.action || "");
  if (!['tap', 'swipe', 'back', 'home'].includes(action)) return null;
  const result = { type: "control", action };
  if (action === "tap") {
    if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) return null;
    result.x = Math.max(0, Math.min(1, message.x));
    result.y = Math.max(0, Math.min(1, message.y));
  }
  if (action === "swipe") {
    for (const key of ["fromX", "fromY", "toX", "toY"]) {
      if (!Number.isFinite(message[key])) return null;
      result[key] = Math.max(0, Math.min(1, message[key]));
    }
    result.durationMs = Math.max(50, Math.min(3_000, Number(message.durationMs) || 300));
  }
  return result;
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(controllerHtml);
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    jsonResponse(response, shuttingDown ? 503 : 200, {
      ok: !shuttingDown,
      uptimeSeconds: Math.trunc(process.uptime()),
      hosts: hostsByCode.size,
      controllers: [...clients.values()].filter((client) => client.role === "controller").length,
      droppedFrames,
    });
    return;
  }
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

const sockets = new WebSocketServer({
  noServer: true,
  maxPayload: config.maxFrameBytes,
  perMessageDeflate: false,
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", "http://localhost");
  const origin = String(request.headers.origin || "");
  if (
    shuttingDown ||
    url.pathname !== "/ws" ||
    (config.allowedOrigins.size > 0 && origin && !config.allowedOrigins.has(origin))
  ) {
    socket.write(`HTTP/1.1 ${shuttingDown ? "503 Service Unavailable" : "403 Forbidden"}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (webSocket) => {
    sockets.emit("connection", webSocket, request);
  });
});

sockets.on("connection", (socket, request) => {
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });

  const registrationTimer = setTimeout(() => {
    if (!clients.has(socket)) socket.close(1008, "registration timeout");
  }, config.registrationTimeoutMs);

  socket.on("message", (data, isBinary) => {
    const client = clients.get(socket);

    if (isBinary) {
      if (client?.role === "host" && client.approved && client.controller) {
        const controller = client.controller;
        if (controller.readyState === WebSocket.OPEN) {
          if (controller.bufferedAmount <= config.maxBackpressureBytes) {
            controller.send(data, { binary: true });
          } else {
            droppedFrames += 1;
          }
        }
      }
      return;
    }

    if (data.length > 16_384) {
      socket.close(1009, "message too large");
      return;
    }

    let message;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      sendJson(socket, { type: "error", code: "invalid_json" });
      return;
    }

    if (!client) {
      if (message.type === "host") {
        clearTimeout(registrationTimer);
        const code = newPairingCode();
        const hostInfo = {
          role: "host",
          socket,
          code,
          controller: null,
          requestId: null,
          approved: false,
          resumeToken: null,
          resumeUntil: 0,
          resumeTimer: null,
        };
        clients.set(socket, hostInfo);
        hostsByCode.set(code, hostInfo);
        sendJson(socket, { type: "host_ready", code });
        return;
      }

      if (message.type === "controller") {
        clearTimeout(registrationTimer);
        const address = clientAddress(request);
        if (joinRateLimited(address)) {
          sendJson(socket, { type: "error", code: "rate_limited" });
          socket.close(1008, "rate limited");
          return;
        }

        const code = String(message.code || "").replace(/\D/g, "").slice(0, 6);
        const hostInfo = hostsByCode.get(code);
        if (!hostInfo || hostInfo.socket.readyState !== WebSocket.OPEN) {
          sendJson(socket, { type: "error", code: "invalid_code" });
          socket.close(1008, "invalid code");
          return;
        }

        const resumeAllowed =
          hostInfo.resumeToken &&
          Date.now() <= hostInfo.resumeUntil &&
          safeTokenEquals(message.resumeToken, hostInfo.resumeToken);
        if (resumeAllowed) {
          clearResume(hostInfo);
          const controllerInfo = { role: "controller", socket, hostInfo, requestId: null };
          clients.set(socket, controllerInfo);
          hostInfo.controller = socket;
          hostInfo.approved = true;
          hostInfo.resumeToken = randomUUID();
          sendJson(hostInfo.socket, { type: "controller_connected" });
          sendJson(socket, { type: "controller_connected", resumeToken: hostInfo.resumeToken, resumed: true });
          return;
        }

        if (hostInfo.controller || hostInfo.requestId || hostInfo.resumeToken) {
          sendJson(socket, { type: "error", code: "host_busy" });
          socket.close(1008, "host busy");
          return;
        }

        const requestId = randomUUID();
        const controllerName = String(message.name || "iPhone").slice(0, 40);
        const controllerInfo = { role: "controller", socket, hostInfo, requestId };
        clients.set(socket, controllerInfo);
        hostInfo.requestId = requestId;
        const timer = setTimeout(() => clearPendingRequest(hostInfo, "approval_timeout"), config.joinTimeoutMs);
        timer.unref?.();
        requests.set(requestId, { hostInfo, controllerInfo, timer });
        sendJson(hostInfo.socket, { type: "join_request", requestId, controllerName });
        sendJson(socket, { type: "join_pending" });
        return;
      }

      sendJson(socket, { type: "error", code: "registration_required" });
      socket.close(1008, "registration required");
      return;
    }

    if (client.role === "host" && message.type === "approve") {
      const pending = requests.get(String(message.requestId || ""));
      if (!pending || pending.hostInfo !== client) {
        sendJson(socket, { type: "error", code: "unknown_request" });
        return;
      }
      requests.delete(client.requestId);
      clearTimeout(pending.timer);
      client.requestId = null;
      const controller = pending.controllerInfo.socket;
      if (!message.allow) {
        clients.delete(controller);
        sendJson(controller, { type: "error", code: "rejected" });
        controller.close(1000, "rejected");
        return;
      }
      client.controller = controller;
      client.approved = true;
      client.resumeToken = randomUUID();
      pending.controllerInfo.requestId = null;
      sendJson(socket, { type: "controller_connected" });
      sendJson(controller, { type: "controller_connected", resumeToken: client.resumeToken });
      return;
    }

    if (client.role === "controller" && client.hostInfo.approved) {
      const control = message.type === "control" ? sanitizeControl(message) : null;
      if (control) sendJson(client.hostInfo.socket, control);
    }
  });

  socket.on("close", () => {
    clearTimeout(registrationTimer);
    const client = clients.get(socket);
    if (client?.role === "host") endHost(socket, "华为手机已断开");
    if (client?.role === "controller") endController(socket, "iPhone 已断开");
  });

  socket.on("error", () => {
    // The close handler performs all cleanup.
  });
});

const heartbeat = setInterval(() => {
  for (const socket of sockets.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }

  const cutoff = Date.now() - 120_000;
  for (const [address, value] of joinAttempts) {
    if (value.windowStartedAt < cutoff) joinAttempts.delete(address);
  }
}, config.heartbeatMs);
heartbeat.unref?.();

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; closing PhoneBridge relay`);
  clearInterval(heartbeat);
  for (const socket of sockets.clients) socket.close(1012, "server restarting");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(config.port, config.host, () => {
  console.log(`PhoneBridge relay listening on http://${config.host}:${config.port}`);
});
