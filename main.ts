/**
 * ClevrSend Signaling Server
 * Compatible with LocalSend protocol
 */

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
}

const clients = new Map<string, Client>();

// Auto-cleanup inactive clients every 5 minutes
setInterval(() => {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes

  for (const [id, client] of clients.entries()) {
    if (now - client.lastPing > timeout) {
      console.log(`Cleaning up inactive client: ${id}`);
      try {
        client.socket.close();
      } catch (e) {
        console.error(`Error closing socket for ${id}:`, e);
      }
      clients.delete(id);
    }
  }
}, 60 * 1000); // Run every minute

console.log("ClevrSend Signaling Server starting...");

Deno.serve((req) => {
  const url = new URL(req.url);

  // Health check endpoint
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({
      status: "ok",
      clients: clients.size,
      uptime: performance.now(),
    }), {
      headers: { "content-type": "application/json" },
    });
  }

  // WebSocket endpoint (compatible with LocalSend)
  if (req.headers.get("upgrade") === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const clientId = crypto.randomUUID();
    let initialInfo: ClientInfo | null = null;

    const client: Client = {
      id: clientId,
      socket,
      info: null,
      lastPing: Date.now(),
    };

    clients.set(clientId, client);

    socket.addEventListener("open", () => {
      console.log(`Client connected: ${clientId}`);

      // Send HELLO with peers list
      const peers = Array.from(clients.values())
        .filter(c => c.id !== clientId && c.info)
        .map(c => ({ ...c.info!, id: c.id }));

      const helloMessage = {
        type: "HELLO",
        client: { ...initialInfo, id: clientId },
        peers,
      };

      socket.send(JSON.stringify(helloMessage));

      // Broadcast JOIN to other clients
      if (initialInfo) {
        broadcast({
          type: "JOIN",
          peer: { ...initialInfo, id: clientId },
        }, clientId);
      }
    });

    socket.addEventListener("message", (event) => {
      client.lastPing = Date.now();

      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case "HELLO": {
            // Client sending its info
            initialInfo = data.info;
            client.info = data.info;
            console.log(`Client ${clientId} introduced as ${data.info.alias}`);
            break;
          }

          case "UPDATE": {
            // Client updating its info
            client.info = data.info;
            broadcast({
              type: "UPDATE",
              peer: { ...data.info, id: clientId },
            }, clientId);
            break;
          }

          case "OFFER": {
            // Forward OFFER to target client
            const targetClient = clients.get(data.targetId);
            if (targetClient) {
              targetClient.socket.send(JSON.stringify({
                type: "OFFER",
                sourceId: clientId,
                offer: data.offer,
              }));
            }
            break;
          }

          case "ANSWER": {
            // Forward ANSWER to target client
            const targetClient = clients.get(data.targetId);
            if (targetClient) {
              targetClient.socket.send(JSON.stringify({
                type: "ANSWER",
                sourceId: clientId,
                answer: data.answer,
              }));
            }
            break;
          }

          case "PING": {
            // Respond to ping
            socket.send(JSON.stringify({ type: "PONG" }));
            break;
          }

          default:
            console.log(`Unknown message type from ${clientId}:`, data.type);
        }
      } catch (error) {
        console.error(`Error processing message from ${clientId}:`, error);
      }
    });

    socket.addEventListener("close", () => {
      console.log(`Client disconnected: ${clientId}`);
      clients.delete(clientId);

      // Broadcast LEFT to other clients
      broadcast({
        type: "LEFT",
        peerId: clientId,
      }, clientId);
    });

    socket.addEventListener("error", (error) => {
      console.error(`WebSocket error for ${clientId}:`, error);
      clients.delete(clientId);
    });

    return response;
  }

  // Default response
  return new Response("ClevrSend Signaling Server - Use WebSocket connection", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
});

// Broadcast message to all clients except sender
function broadcast(message: unknown, excludeId?: string) {
  const messageStr = JSON.stringify(message);
  for (const [id, client] of clients.entries()) {
    if (id !== excludeId && client.socket.readyState === WebSocket.OPEN) {
      try {
        client.socket.send(messageStr);
      } catch (error) {
        console.error(`Error broadcasting to ${id}:`, error);
      }
    }
  }
}

console.log("ClevrSend Signaling Server ready");
console.log("WebSocket and HTTP endpoints available");
