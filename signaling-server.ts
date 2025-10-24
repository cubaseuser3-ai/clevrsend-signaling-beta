/**
 * ClevrSend Signaling Server - BETA
 * Compatible with LocalSend protocol
 *
 * Deploy to: Render.com
 * URL: wss://clevrsend-signaling-beta.onrender.com
 */

const SERVER_VERSION = "1.6.0-beta.1";

interface ClientInfo {
  alias: string;
  version: string;
  deviceModel?: string;
  deviceType?: string;
  token: string;
}

interface Client {
  id: string;
  socket: WebSocket;
  info: ClientInfo | null;
  lastPing: number;
  ip: string;
}

// Store all connected clients
const clients = new Map<string, Client>();

// Store QR offers temporarily (short ID -> offer data)
interface StoredOffer {
  data: any;
  timestamp: number;
}
const qrOffers = new Map<string, StoredOffer>();

// ===== SECURITY: Rate Limiting =====
interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const rateLimits = new Map<string, RateLimitRecord>();
const connectionLimits = new Map<string, number>();

// Cleanup rate limit records every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimits.entries()) {
    if (now > record.resetAt) {
      rateLimits.delete(ip);
    }
  }
}, 5 * 60 * 1000);

/**
 * Check if IP is within rate limit
 * @param ip Client IP address
 * @param limit Max requests allowed
 * @param windowMs Time window in milliseconds
 * @returns true if within limit, false if exceeded
 */
function checkRateLimit(ip: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const record = rateLimits.get(ip);

  if (!record || now > record.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (record.count >= limit) {
    return false; // Rate limit exceeded
  }

  record.count++;
  return true;
}

/**
 * Check if IP has too many active connections
 * @param ip Client IP address
 * @param maxConnections Max allowed connections per IP
 * @returns true if allowed, false if exceeded
 */
function checkConnectionLimit(ip: string, maxConnections: number): boolean {
  const count = connectionLimits.get(ip) || 0;
  return count < maxConnections;
}

/**
 * Increment connection count for IP
 */
function incrementConnectionCount(ip: string): void {
  const count = connectionLimits.get(ip) || 0;
  connectionLimits.set(ip, count + 1);
}

/**
 * Decrement connection count for IP
 */
function decrementConnectionCount(ip: string): void {
  const count = connectionLimits.get(ip) || 0;
  if (count > 0) {
    connectionLimits.set(ip, count - 1);
  }
}

// ===== SECURITY: CORS Whitelist =====
const ALLOWED_ORIGINS = [
  "https://clevrsend.com",
  "https://www.clevrsend.com",
  "https://clevrsend.app",
  "https://www.clevrsend.app",
  "https://clevrsend.vercel.app",
  "http://localhost:3000", // Development only
];

/**
 * Get CORS headers for allowed origins only
 */
function getCorsHeaders(origin: string | null): Record<string, string> {
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type",
    };
  }
  return {}; // No CORS headers for disallowed origins
}

/**
 * Extract client IP from request
 */
function getClientIP(req: Request): string {
  // Try various headers (Cloudflare, Render.com, etc.)
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

// Generate short ID for QR codes (6 alphanumeric characters)
function generateShortId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed ambiguous chars (0, O, I, 1)
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// Cleanup interval (remove dead connections and old QR offers)
setInterval(() => {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes

  // Clean up inactive clients
  for (const [id, client] of clients.entries()) {
    if (now - client.lastPing > timeout) {
      console.log(`Removing inactive client: ${id}`);

      // Decrement connection count for this IP
      decrementConnectionCount(client.ip);

      client.socket.close();
      clients.delete(id);
      broadcast({
        type: "LEFT",
        peerId: id,
      });
    }
  }

  // Clean up expired QR offers
  for (const [id, offer] of qrOffers.entries()) {
    if (now - offer.timestamp > timeout) {
      console.log(`Removing expired QR offer: ${id}`);
      qrOffers.delete(id);
    }
  }
}, 60 * 1000); // Check every minute

Deno.serve({ port: 8080 }, (req) => {
  const url = new URL(req.url);
  const clientIP = getClientIP(req);
  const origin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // SECURITY: Check if origin is allowed (for non-preflight requests)
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    console.warn(`Blocked request from unauthorized origin: ${origin} (IP: ${clientIP})`);
    return new Response(JSON.stringify({
      error: "Forbidden: Unauthorized origin",
    }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  // Health check endpoint (public, no rate limit)
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({
      status: "ok",
      version: SERVER_VERSION,
      clients: clients.size,
      qrOffers: qrOffers.size,
      uptime: performance.now(),
    }), {
      headers: {
        "content-type": "application/json",
        ...corsHeaders,
      },
    });
  }

  // Store QR offer endpoint: POST /qr/store
  // SECURITY: Rate limit 10 requests per minute per IP
  if (url.pathname === "/qr/store" && req.method === "POST") {
    if (!checkRateLimit(clientIP, 10, 60000)) {
      console.warn(`Rate limit exceeded for /qr/store from IP: ${clientIP}`);
      return new Response(JSON.stringify({
        error: "Too many requests. Please try again later.",
      }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "60",
          ...corsHeaders,
        },
      });
    }

    return req.json().then((data) => {
      // Generate unique short ID
      let shortId = generateShortId();
      while (qrOffers.has(shortId)) {
        shortId = generateShortId();
      }

      // Store offer with timestamp
      qrOffers.set(shortId, {
        data,
        timestamp: Date.now(),
      });

      console.log(`Stored QR offer: ${shortId}`);

      return new Response(JSON.stringify({
        success: true,
        id: shortId,
        expiresIn: 5 * 60 * 1000, // 5 minutes
      }), {
        headers: {
          "content-type": "application/json",
          ...corsHeaders,
        },
      });
    }).catch((e) => {
      console.error("Failed to store QR offer:", e);
      return new Response(JSON.stringify({
        success: false,
        error: "Invalid request body",
      }), {
        status: 400,
        headers: {
          "content-type": "application/json",
          ...corsHeaders,
        },
      });
    });
  }

  // Retrieve QR offer endpoint: GET /qr/{id}
  if (url.pathname.startsWith("/qr/") && req.method === "GET") {
    const shortId = url.pathname.split("/")[2];
    const offer = qrOffers.get(shortId);

    if (offer) {
      console.log(`Retrieved QR offer: ${shortId}`);
      return new Response(JSON.stringify({
        success: true,
        data: offer.data,
      }), {
        headers: {
          "content-type": "application/json",
          ...corsHeaders,
        },
      });
    } else {
      return new Response(JSON.stringify({
        success: false,
        error: "QR offer not found or expired",
      }), {
        status: 404,
        headers: {
          "content-type": "application/json",
          ...corsHeaders,
        },
      });
    }
  }

  // WebSocket upgrade
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Expected WebSocket connection", { status: 426 });
  }

  // SECURITY: Check total client limit (prevent memory exhaustion)
  const MAX_TOTAL_CLIENTS = 1000;
  if (clients.size >= MAX_TOTAL_CLIENTS) {
    console.warn(`Server at capacity (${clients.size} clients). Rejecting new connection from IP: ${clientIP}`);
    return new Response(JSON.stringify({
      error: "Server at capacity. Please try again later.",
    }), {
      status: 503,
      headers: {
        "content-type": "application/json",
        "retry-after": "60",
      },
    });
  }

  // SECURITY: Check connection limit per IP (prevent single IP flooding)
  const MAX_CONNECTIONS_PER_IP = 5;
  if (!checkConnectionLimit(clientIP, MAX_CONNECTIONS_PER_IP)) {
    console.warn(`Connection limit exceeded for IP: ${clientIP} (max: ${MAX_CONNECTIONS_PER_IP})`);
    return new Response(JSON.stringify({
      error: `Too many connections from your IP. Maximum ${MAX_CONNECTIONS_PER_IP} connections allowed.`,
    }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "120",
      },
    });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  const clientId = crypto.randomUUID();

  // Track this connection
  incrementConnectionCount(clientIP);

  // Parse initial client info from query parameter (Base64 encoded)
  const encodedInfo = url.searchParams.get("d");
  let initialInfo: ClientInfo | null = null;

  if (encodedInfo) {
    try {
      const decoded = atob(encodedInfo);
      initialInfo = JSON.parse(decoded);
      console.log(`New client connecting: ${initialInfo.alias} (${clientId})`);
    } catch (e) {
      console.error("Failed to parse client info:", e);
    }
  }

  socket.addEventListener("open", () => {
    const client: Client = {
      id: clientId,
      socket,
      info: initialInfo,
      lastPing: Date.now(),
      ip: clientIP,
    };

    clients.set(clientId, client);

    // Send HELLO message with current client ID and list of all other peers
    const peers = Array.from(clients.values())
      .filter(c => c.id !== clientId && c.info)
      .map(c => ({ ...c.info!, id: c.id }));

    const helloMessage = {
      type: "HELLO",
      client: { ...initialInfo, id: clientId },
      peers,
    };

    socket.send(JSON.stringify(helloMessage));
    console.log(`Client ${clientId} connected. Total clients: ${clients.size}`);

    // Notify all other clients about the new peer
    if (initialInfo) {
      broadcast({
        type: "JOIN",
        peer: { ...initialInfo, id: clientId },
      }, clientId);
    }
  });

  socket.addEventListener("message", (event) => {
    const client = clients.get(clientId);
    if (!client) return;

    // Update last ping time
    client.lastPing = Date.now();

    // Handle ping (empty message)
    if (!event.data || event.data === "") {
      return;
    }

    try {
      const message = JSON.parse(event.data.toString());
      handleMessage(clientId, message, client);
    } catch (e) {
      console.error(`Failed to parse message from ${clientId}:`, e);
    }
  });

  socket.addEventListener("close", () => {
    const client = clients.get(clientId);
    if (client) {
      console.log(`Client ${clientId} disconnected. Total clients: ${clients.size - 1}`);

      // Decrement connection count for this IP
      decrementConnectionCount(client.ip);

      clients.delete(clientId);

      // Notify all other clients about the peer leaving
      broadcast({
        type: "LEFT",
        peerId: clientId,
      });
    }
  });

  socket.addEventListener("error", (error) => {
    console.error(`WebSocket error for client ${clientId}:`, error);
  });

  return response;
});

function handleMessage(senderId: string, message: any, sender: Client) {
  switch (message.type) {
    case "UPDATE":
      // Update client info
      sender.info = message.info;
      console.log(`Client ${senderId} updated info:`, message.info.alias);

      // Broadcast update to all other clients
      broadcast({
        type: "UPDATE",
        peer: { ...message.info, id: senderId },
      }, senderId);
      break;

    case "OFFER":
      // Forward OFFER to target peer
      const offerTarget = clients.get(message.target);
      if (offerTarget && offerTarget.socket.readyState === WebSocket.OPEN) {
        offerTarget.socket.send(JSON.stringify({
          type: "OFFER",
          peer: { ...sender.info, id: senderId },
          sessionId: message.sessionId,
          sdp: message.sdp,
        }));
        console.log(`Forwarded OFFER from ${senderId} to ${message.target}`);
      } else {
        console.warn(`Target ${message.target} not found or not ready`);
      }
      break;

    case "ANSWER":
      // Forward ANSWER to target peer
      const answerTarget = clients.get(message.target);
      if (answerTarget && answerTarget.socket.readyState === WebSocket.OPEN) {
        answerTarget.socket.send(JSON.stringify({
          type: "ANSWER",
          peer: { ...sender.info, id: senderId },
          sessionId: message.sessionId,
          sdp: message.sdp,
        }));
        console.log(`Forwarded ANSWER from ${senderId} to ${message.target}`);
      } else {
        console.warn(`Target ${message.target} not found or not ready`);
      }
      break;

    case "QR_ANSWER":
      // Forward QR_ANSWER to target peer (for QR-Connect one-way handshake)
      const qrTarget = clients.get(message.targetId);
      if (qrTarget && qrTarget.socket.readyState === WebSocket.OPEN) {
        qrTarget.socket.send(JSON.stringify({
          type: "QR_ANSWER",
          answer: message.answer,
          senderId: senderId,
        }));
        console.log(`Forwarded QR_ANSWER from ${senderId} to ${message.targetId}`);
      } else {
        console.warn(`QR_ANSWER target ${message.targetId} not found or not ready`);
      }
      break;

    case "ICE_CANDIDATE":
      // Forward ICE candidate to target peer (for Trickle ICE)
      const iceTarget = clients.get(message.targetId);
      if (iceTarget && iceTarget.socket.readyState === WebSocket.OPEN) {
        iceTarget.socket.send(JSON.stringify({
          type: "ICE_CANDIDATE",
          candidate: message.candidate,
          senderId: senderId,
        }));
        console.log(`Forwarded ICE_CANDIDATE from ${senderId} to ${message.targetId}`);
      } else {
        console.warn(`ICE_CANDIDATE target ${message.targetId} not found or not ready`);
      }
      break;

    default:
      console.warn(`Unknown message type: ${message.type}`);
  }
}

function broadcast(message: any, excludeId?: string) {
  const data = JSON.stringify(message);
  let sent = 0;

  for (const [id, client] of clients) {
    if (id !== excludeId && client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(data);
      sent++;
    }
  }

  console.log(`Broadcasted ${message.type} to ${sent} clients`);
}

console.log(`ClevrSend Signaling Server v${SERVER_VERSION} started on port 8080`);
console.log("WebSocket endpoint: ws://localhost:8080");
console.log("Health check: http://localhost:8080/health");
