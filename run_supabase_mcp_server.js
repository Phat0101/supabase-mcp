// run-supabase-mcp-sse-server.js
import express from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { parseArgs } from 'node:util';
import { createSupabaseMcpServer } from './packages/mcp-server-supabase/dist/index.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config(); // Load .env for local dev; Vercel uses its own env system

const app = express();
app.use(express.json());

// --- Shared Configuration (primarily from environment variables) ---
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.SUPABASE_PROJECT_REF;
const readOnly = process.env.SUPABASE_READ_ONLY === 'true';
const apiUrl = process.env.SUPABASE_API_URL;
// Vercel provides the PORT environment variable for the server to listen on.
// For paths, we can use environment variables or keep defaults.
const serverSsePath = process.env.SERVER_SSE_PATH || '/sse';
const serverMessagesPath = process.env.SERVER_MESSAGES_PATH || '/mcp-messages';

if (!accessToken) {
  console.error('CRITICAL ERROR: SUPABASE_ACCESS_TOKEN environment variable is not set. The server may not function correctly.');
  // For Vercel, if critical envs are missing, the deployment might fail or the function won't start healthy.
}

const activeSseTransports = new Map();

// MCP Server Instance (shared by all connections)
// Ensure this initialization doesn't fail silently if critical env vars are missing.
const mcpServer = accessToken ? createSupabaseMcpServer({
  platform: {
    accessToken,
    apiUrl, // createSupabaseMcpServer will use default if this is undefined
  },
  projectId: projectRef,
  readOnly,
}) : null;

if (!mcpServer && accessToken) {
  console.error("CRITICAL ERROR: Failed to create SupabaseMcpServer instance, though accessToken was present.");
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

// --- Export the Express app for Vercel ---
export default app;

// --- Local Development Startup Logic ---
// This function will be called only when running the script directly (e.g., `npm start`)
async function startLocalDevelopmentServer() {
  const {
    values: {
      cliAccessToken,
      cliProjectId,
      cliReadOnlyFromArgs = false,
      cliApiUrl,
      cliPort,
    },
  } = parseArgs({
    options: {
      'access-token': { type: 'string' },
      'project-ref': { type: 'string' },
      'read-only': { type: 'boolean' },
      'api-url': { type: 'string' },
      port: { type: 'string', short: 'p' },
      'sse-path': { type: 'string' },
      'messages-path': { type: 'string' },
    },
    allowPositionals: true,
  });

  const localPort = cliPort || process.env.PORT || '3002';

  if (!mcpServer) {
    console.error("Local Server Aborted: McpServer could not be initialized. Is SUPABASE_ACCESS_TOKEN missing in your .env file?");
    process.exit(1);
  }
  
  console.log('Configuring Supabase MCP Express Server for LOCAL DEVELOPMENT...');
  console.log(`  Server Port (local): ${localPort}`);
  console.log(`  SSE Connection Path: ${serverSsePath}`);
  console.log(`  Client Messages POST Path: ${serverMessagesPath}`);
  if (projectRef) console.log(`  Project Ref (effective): ${projectRef}`);
  if (apiUrl) console.log(`  API URL (effective): ${apiUrl}`);
  if (readOnly) console.log(`  Read-only (effective): true`);

  const httpServer = app.listen(Number(localPort), () => {
    console.log(`Supabase MCP Express Server is live locally on http://localhost:${localPort}`);
    console.log(`SSE connections: GET http://localhost:${localPort}${serverSsePath}`);
    console.log(`Client messages: POST http://localhost:${localPort}${serverMessagesPath}?sessionId=<your_session_id>`);
  });

  const gracefulShutdown = async () => {
    console.log('\nShutting down Supabase MCP Express server (local)...');
    activeSseTransports.forEach(async (transport, sessionId) => {
      console.log(`Closing transport for session ${sessionId}...`);
      try { await transport.close(); } catch (e) { console.error(`Error closing transport for session ${sessionId}`, e); }
    });
    activeSseTransports.clear();
    console.log('All active SSE transports closed (local).');

    if (mcpServer && mcpServer.close) {
      try { await mcpServer.close(); console.log('MCP server logic closed (local).'); }
      catch (e) { console.error('Error closing MCP server logic (local):', e); }
    }
    
    httpServer.close(() => {
      console.log('HTTP server closed (local).');
      process.exit(0);
    });
    setTimeout(() => { console.error("Graceful shutdown timed out (local). Forcing exit."); process.exit(1); }, 10000);
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

const __filename = fileURLToPath(import.meta.url);
let isRunDirectly = false;
if (process.argv[1]) {
    try {
        // Attempt to resolve process.argv[1] relative to CWD if it's not absolute
        const scriptPath = process.argv[1].startsWith('/') || process.argv[1].includes('://') ? process.argv[1] : `${process.cwd()}/${process.argv[1]}`;
        isRunDirectly = fileURLToPath(new URL(scriptPath.startsWith('file://') ? scriptPath : 'file://' + scriptPath).href) === __filename;
    } catch (e) {
        // Fallback: simple check if the script name matches (less reliable)
        if (process.argv[1].endsWith('run_supabase_mcp_server.js')) {
            isRunDirectly = true;
        }
        console.warn(`Could not reliably determine if script was run directly. Fallback used. Error: ${e.message}`);
    }
}


if (isRunDirectly || process.env.RUN_LOCAL_SERVER === 'true') {
  console.log("Script identified as run directly or RUN_LOCAL_SERVER is true. Starting local server...");
  startLocalDevelopmentServer().catch(error => {
    console.error("Unhandled error in local server main execution:", error);
    process.exit(1);
  });
} else {
   console.log("Script imported as a module (e.g., by Vercel). Not starting local server. Exporting Express app.");
}