import express from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createSupabaseMcpServer } from './packages/mcp-server-supabase/dist/index.js';
import dotenv from 'dotenv';

dotenv.config(); 

const app = express();
app.use(express.json());

// --- Shared Configuration (primarily from environment variables) ---
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.SUPABASE_PROJECT_REF;
const readOnly = process.env.SUPABASE_READ_ONLY === 'true';
const apiUrl = process.env.SUPABASE_API_URL;
const serverSsePath = process.env.SERVER_SSE_PATH || '/sse';
const serverMessagesPath = process.env.SERVER_MESSAGES_PATH || '/mcp-messages';

if (!accessToken) {
  console.error('CRITICAL ERROR: SUPABASE_ACCESS_TOKEN environment variable is not set. The server may not function correctly and may exit.');
}

const activeSseTransports = new Map();

console.log("[MCP Server] Attempting to initialize mcpServer instance...");
let mcpServerInstance; // Using a distinct variable name for clarity
try {
  mcpServerInstance = accessToken ? createSupabaseMcpServer({
    platform: {
      accessToken,
      apiUrl,
    },
    projectId: projectRef,
    readOnly,
  }) : null;

  if (accessToken && !mcpServerInstance) {
    console.error("[MCP Server] CRITICAL ERROR: createSupabaseMcpServer returned null/falsy even though accessToken was present. This is unexpected and will cause server to abort.");
  } else if (!accessToken) {
    console.log("[MCP Server] mcpServer not initialized because SUPABASE_ACCESS_TOKEN is missing.");
  } else {
    console.log("[MCP Server] mcpServer instance seems to be created (or is null if no accessToken).");
  }
} catch (e) {
  console.error("[MCP Server] CRITICAL EXCEPTION during createSupabaseMcpServer call:", e);
  mcpServerInstance = null; // Ensure it's null on error
}

// --- Express Routes (ensure mcpServerInstance is checked before use) ---
app.get(serverSsePath, async (req, res) => {
  if (!mcpServerInstance) {
    console.error(`GET ${serverSsePath}: McpServer (mcpServerInstance) not initialized. Critical env var likely missing or createSupabaseMcpServer failed.`);
    return res.status(503).send("Service temporarily unavailable: server core component not initialized.");
  }
  console.log(`GET ${serverSsePath}: Incoming SSE connection request from ${req.ip}`);
  try {
    const transport = new SSEServerTransport(serverMessagesPath, res);
    const sessionId = transport.sessionId;

    if (!sessionId) {
      console.error(`GET ${serverSsePath}: Critical error - SSEServerTransport.sessionId is undefined.`);
      if (!res.headersSent) {
        res.status(500).send("Failed to initialize SSE transport: no session ID.");
      }
      return;
    }

    activeSseTransports.set(sessionId, transport);
    console.log(`GET ${serverSsePath}: SSE transport created and stored for sessionId: ${sessionId}.`);

    req.on('close', () => {
      console.log(`GET ${serverSsePath}: Client disconnected for sessionId: ${sessionId}. Removing transport.`);
      activeSseTransports.delete(sessionId);
      transport.close().catch(err => console.error(`Error closing transport for ${sessionId}:`, err));
    });

    await mcpServerInstance.connect(transport);
    console.log(`GET ${serverSsePath}: McpServer connected to transport for sessionId: ${sessionId}. SSE stream established.`);

  } catch (error) {
    console.error(`GET ${serverSsePath}: Error during SSE setup for ${req.ip}:`, error);
    if (!res.headersSent) {
      res.status(500).send('Error setting up SSE connection.');
    }
  }
});

app.post(serverMessagesPath, async (req, res) => {
  if (!mcpServerInstance) {
    console.error(`POST ${serverMessagesPath}: McpServer (mcpServerInstance) not initialized. Critical env var likely missing or createSupabaseMcpServer failed.`);
    return res.status(503).send("Service temporarily unavailable: server core component not initialized.");
  }
  const sessionId = req.query.sessionId;
  console.log(`POST ${serverMessagesPath}: Incoming message for sessionId: ${sessionId}.`);

  if (!sessionId || typeof sessionId !== 'string') {
    console.log(`POST ${serverMessagesPath}: Missing or invalid sessionId in query.`);
    res.status(400).send("Missing or invalid sessionId query parameter.");
    return;
  }

  const transport = activeSseTransports.get(sessionId);

  if (transport) {
    console.log(`POST ${serverMessagesPath}: Found active transport for sessionId: ${sessionId}.`);
    try {
      await transport.handlePostMessage(req, res, req.body);
      console.log(`POST ${serverMessagesPath}: Message handled by transport for sessionId: ${sessionId}.`);
    } catch (error) {
      console.error(`POST ${serverMessagesPath}: Error in transport.handlePostMessage for sessionId: ${sessionId}:`, error);
      if (!res.headersSent) {
        res.status(500).send("Error processing message.");
      }
    }
  } else {
    console.log(`POST ${serverMessagesPath}: No active transport found for sessionId: ${sessionId}.`);
    res.status(404).send("No active transport found for the given session ID, or session has expired.");
  }
});

app.use((err, req, res, next) => {
  console.error("[MCP Server] Global Express error handler:", err);
  if (!res.headersSent) {
    res.status(500).send("Internal Server Error");
  }
});

async function startServer() {
  console.log("[MCP Server] startServer() function called.");
  const port = process.env.PORT || '3002';

  if (!mcpServerInstance) {
    console.error("[MCP Server] Server Aborted: mcpServerInstance is not initialized. Check previous logs for errors (e.g., SUPABASE_ACCESS_TOKEN missing or createSupabaseMcpServer failure).");
    process.exit(1);
  }

  console.log('[MCP Server] Configuring Supabase MCP Express Server for listening...');
  console.log(`  Target Host: 0.0.0.0`);
  console.log(`  Target Port: ${port} (from process.env.PORT or default 3002)`);
  console.log(`  SSE Connection Path: ${serverSsePath}`);
  console.log(`  Client Messages POST Path: ${serverMessagesPath}`);
  if (projectRef) console.log(`  Project Ref: ${projectRef}`);
  if (apiUrl) console.log(`  API URL: ${apiUrl}`);
  if (readOnly) console.log(`  Read-only: true`);

  console.log("[MCP Server] Attempting to call app.listen()...");
  const httpServer = app.listen(Number(port), '0.0.0.0', () => {
    console.log(`[MCP Server] Supabase MCP Express Server is live and listening on http://0.0.0.0:${port}`);
  });

  httpServer.on('error', (err) => {
    console.error('[MCP Server] HTTP Server Error (e.g., EADDRINUSE):', err);
    process.exit(1);
  });

  const gracefulShutdown = async () => {
    console.log('\n[MCP Server] Shutting down Supabase MCP Express server...');
    activeSseTransports.forEach(async (transport, sessionId) => {
      console.log(`[MCP Server] Closing transport for session ${sessionId}...`);
      try { await transport.close(); } catch (e) { console.error(`[MCP Server] Error closing transport for session ${sessionId}`, e); }
    });
    activeSseTransports.clear();
    console.log('[MCP Server] All active SSE transports closed.');

    if (mcpServerInstance && mcpServerInstance.close) {
      try { await mcpServerInstance.close(); console.log('[MCP Server] MCP server logic closed.'); }
      catch (e) { console.error('[MCP Server] Error closing MCP server logic:', e); }
    }
    
    httpServer.close(() => {
      console.log('[MCP Server] HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => { console.error("[MCP Server] Graceful shutdown timed out. Forcing exit."); process.exit(1); }, 10000);
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

// --- Main Execution ---
console.log("[MCP Server] Preparing to call startServer() at the end of the script.");
startServer().catch(error => {
  console.error("[MCP Server] Unhandled error in server main execution (startServer promise rejection):", error);
  process.exit(1);
});