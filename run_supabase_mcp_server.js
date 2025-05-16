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

const mcpServer = accessToken ? createSupabaseMcpServer({
  platform: {
    accessToken,
    apiUrl,
  },
  projectId: projectRef,
  readOnly,
}) : null;

if (!mcpServer && accessToken) {
  console.error("CRITICAL ERROR: Failed to create SupabaseMcpServer instance, though accessToken was present. Server will likely exit.");
}

// --- Express Routes (ensure mcpServer is checked before use) ---
app.get(serverSsePath, async (req, res) => {
  if (!mcpServer) {
    console.error(`GET ${serverSsePath}: McpServer not initialized. Critical env var (SUPABASE_ACCESS_TOKEN) likely missing.`);
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

    await mcpServer.connect(transport);
    console.log(`GET ${serverSsePath}: McpServer connected to transport for sessionId: ${sessionId}. SSE stream established.`);

  } catch (error) {
    console.error(`GET ${serverSsePath}: Error during SSE setup for ${req.ip}:`, error);
    if (!res.headersSent) {
      res.status(500).send('Error setting up SSE connection.');
    }
  }
});

app.post(serverMessagesPath, async (req, res) => {
  if (!mcpServer) {
    console.error(`POST ${serverMessagesPath}: McpServer not initialized. Critical env var (SUPABASE_ACCESS_TOKEN) likely missing.`);
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
  console.error("Global Express error handler:", err);
  if (!res.headersSent) {
    res.status(500).send("Internal Server Error");
  }
});

async function startServer() {
  const port = process.env.PORT || '3002';

  if (!mcpServer) {
    console.error("Server Aborted: McpServer could not be initialized. Is SUPABASE_ACCESS_TOKEN missing in your environment variables?");
    process.exit(1); // Important to exit if server cannot start
  }

  console.log('Configuring Supabase MCP Express Server...');
  console.log(`  Listening on host: 0.0.0.0`);
  console.log(`  Server Port: ${port} (from process.env.PORT or default 3002)`);
  console.log(`  SSE Connection Path: ${serverSsePath}`);
  console.log(`  Client Messages POST Path: ${serverMessagesPath}`);
  if (projectRef) console.log(`  Project Ref: ${projectRef}`);
  if (apiUrl) console.log(`  API URL: ${apiUrl}`);
  if (readOnly) console.log(`  Read-only: true`);

  const httpServer = app.listen(Number(port), '0.0.0.0', () => { // Listen on 0.0.0.0
    console.log(`Supabase MCP Express Server is live and listening on http://0.0.0.0:${port}`);
  });

  const gracefulShutdown = async () => {
    console.log('\nShutting down Supabase MCP Express server...');
    activeSseTransports.forEach(async (transport, sessionId) => {
      console.log(`Closing transport for session ${sessionId}...`);
      try { await transport.close(); } catch (e) { console.error(`Error closing transport for session ${sessionId}`, e); }
    });
    activeSseTransports.clear();
    console.log('All active SSE transports closed.');

    if (mcpServer && mcpServer.close) {
      try { await mcpServer.close(); console.log('MCP server logic closed.'); }
      catch (e) { console.error('Error closing MCP server logic:', e); }
    }
    
    httpServer.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => { console.error("Graceful shutdown timed out. Forcing exit."); process.exit(1); }, 10000);
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

// --- Main Execution ---
startServer().catch(error => {
  console.error("Unhandled error in server main execution:", error);
  process.exit(1);
});