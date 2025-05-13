// run-supabase-mcp-sse-server.js
import express from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { parseArgs } from 'node:util';
import { createSupabaseMcpServer } from './packages/mcp-server-supabase/dist/index.js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const {
    values: {
      ['access-token']: cliAccessToken,
      ['project-ref']: cliProjectId,
      ['read-only']: cliReadOnly = false,
      ['api-url']: cliApiUrl,
      port: serverPort = 3002,
      ['sse-path']: serverSsePath = '/sse',
      ['messages-path']: serverMessagesPath = '/mcp-messages',
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

  const accessToken = process.env.SUPABASE_ACCESS_TOKEN ?? cliAccessToken;
  const projectRef = process.env.SUPABASE_PROJECT_REF ?? cliProjectId;
  const readOnly = process.env.SUPABASE_READ_ONLY === 'true' ? true : cliReadOnly; // Corrected boolean coercion
  const apiUrl = process.env.SUPABASE_API_URL ?? cliApiUrl;


  if (!accessToken) {
    console.error(
      'ERROR: Supabase Access Token is required. Provide it with --access-token flag or SUPABASE_ACCESS_TOKEN environment variable.'
    );
    process.exit(1);
  }

  const app = express();
  app.use(express.json()); // Middleware to parse JSON bodies for POST requests

  // Store active SSE transports, mapping sessionId to transport instance
  const activeSseTransports = new Map();

  // Create the MCP Server instance (this does not start it yet)
  // It's configured once and used for all connections.
  const mcpServer = createSupabaseMcpServer({
    platform: {
      accessToken,
      apiUrl,
    },
    projectId: projectRef,
    readOnly,
  });

  console.log('Configuring Supabase MCP Express Server...');
  console.log(`  Server Port: ${serverPort}`);
  console.log(`  SSE Connection Path: ${serverSsePath}`);
  console.log(`  Client Messages POST Path: ${serverMessagesPath}`);
  if (projectRef) console.log(`  Project Ref: ${projectRef}`);
  if (apiUrl) console.log(`  API URL: ${apiUrl}`);
  if (readOnly) console.log(`  Read-only: true`);


  // SSE connection endpoint
  app.get(serverSsePath, async (req, res) => {
    console.log(`GET ${serverSsePath}: Incoming SSE connection request from ${req.ip}`);
    try {
      // The first argument to SSEServerTransport is the endpoint where clients should POST messages.
      // The second argument is the Node.js response object for this specific SSE connection.
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
        // Optionally, you might want to tell the mcpServer or transport to clean up
        // if mcpServer.disconnect(transport) or transport.close() is needed for individual clients.
        // For now, the SDK's mcpServer.close() on graceful shutdown handles general cleanup.
        transport.close().catch(err => console.error(`Error closing transport for ${sessionId}:`, err));

      });

      // Connect the MCP server logic to this specific transport.
      // This will internally call transport.start(), which now has a valid `res` object.
      await mcpServer.connect(transport);
      console.log(`GET ${serverSsePath}: McpServer connected to transport for sessionId: ${sessionId}. SSE stream established.`);

    } catch (error) {
      console.error(`GET ${serverSsePath}: Error during SSE setup for ${req.ip}:`, error);
      if (!res.headersSent) {
        res.status(500).send('Error setting up SSE connection.');
      }
    }
  });

  // Endpoint for clients to POST messages to
  app.post(serverMessagesPath, async (req, res) => {
    const sessionId = req.query.sessionId; // Client includes sessionId in query params
    console.log(`POST ${serverMessagesPath}: Incoming message for sessionId: ${sessionId}. Body:`, req.body);

    if (!sessionId || typeof sessionId !== 'string') {
      console.log(`POST ${serverMessagesPath}: Missing or invalid sessionId in query.`);
      res.status(400).send("Missing or invalid sessionId query parameter.");
      return;
    }

    const transport = activeSseTransports.get(sessionId);

    if (transport) {
      console.log(`POST ${serverMessagesPath}: Found active transport for sessionId: ${sessionId}.`);
      try {
        // The SSEServerTransport's handlePostMessage expects the raw req, res, and the parsed body.
        await transport.handlePostMessage(req, res, req.body);
        console.log(`POST ${serverMessagesPath}: Message handled by transport for sessionId: ${sessionId}.`);
        // transport.handlePostMessage is expected to send the HTTP response.
      } catch (error) {
        console.error(`POST ${serverMessagesPath}: Error in transport.handlePostMessage for sessionId: ${sessionId}:`, error);
        if (!res.headersSent) {
          // If transport didn't send a response on error, send one.
          res.status(500).send("Error processing message.");
        }
      }
    } else {
      console.log(`POST ${serverMessagesPath}: No active transport found for sessionId: ${sessionId}.`);
      res.status(404).send("No active transport found for the given session ID, or session has expired.");
    }
  });

  // Global error handler for Express
  app.use((err, req, res, next) => {
    console.error("Global Express error handler:", err);
    if (!res.headersSent) {
      res.status(500).send("Internal Server Error");
    }
  });
  
  const httpServer = app.listen(Number(serverPort), () => {
    console.log(`Supabase MCP Express Server is live and listening on http://localhost:${serverPort}`);
    console.log(`SSE connections should be made to: GET http://localhost:${serverPort}${serverSsePath}`);
    console.log(`Client messages should be POSTed to: http://localhost:${serverPort}${serverMessagesPath}?sessionId=<your_session_id>`);
  });

  const gracefulShutdown = async () => {
    console.log('\nShutting down Supabase MCP Express server...');
    activeSseTransports.forEach(async (transport, sessionId) => {
        console.log(`Closing transport for session ${sessionId}...`);
        try {
            await transport.close();
        } catch (e) {
            console.error(`Error closing transport for session ${sessionId}`, e);
        }
    });
    activeSseTransports.clear();
    console.log('All active SSE transports closed.');

    if (mcpServer.close) {
      try {
        await mcpServer.close();
        console.log('MCP server logic closed.');
      } catch (e) {
        console.error('Error closing MCP server logic:', e);
      }
    }
    
    httpServer.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });

    // Force close after a timeout if graceful shutdown hangs
    setTimeout(() => {
        console.error("Graceful shutdown timed out. Forcing exit.");
        process.exit(1);
    }, 10000); // 10 seconds timeout
  };

  process.on('SIGINT', gracefulShutdown); // Ctrl+C
  process.on('SIGTERM', gracefulShutdown); // kill

}

main().catch(error => {
  console.error("Unhandled error in main execution:", error);
  process.exit(1);
});