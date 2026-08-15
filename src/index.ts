#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import express, { type Express, type Response } from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { GradescopeAPI } from "./gradescope-api.js";
import { createServer } from "./mcp-server.js";
import type { GradescopeClient } from "./types.js";

export interface GradescopeCredentials {
  email: string;
  password: string;
}

export function loadGradescopeCredentials(
  environment: NodeJS.ProcessEnv = process.env
): GradescopeCredentials {
  const email = environment.GRADESCOPE_EMAIL;
  const password = environment.GRADESCOPE_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "GRADESCOPE_EMAIL and GRADESCOPE_PASSWORD environment variables are required"
    );
  }

  return { email, password };
}

export function createGradescopeClient(
  environment: NodeJS.ProcessEnv = process.env
): GradescopeClient {
  const { email, password } = loadGradescopeCredentials(environment);
  return new GradescopeAPI(email, password);
}

function methodNotAllowed(res: Response): void {
  res
    .status(405)
    .set("Allow", "POST")
    .type("text")
    .send("Method Not Allowed");
}

export function createHttpApp(api: GradescopeClient): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.post("/mcp", async (request, response) => {
    const server = createServer(api);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    response.on("close", () => {
      void transport.close().catch((error: unknown) => {
        console.error("Failed to close MCP transport:", error);
      });
      void server.close().catch((error: unknown) => {
        console.error("Failed to close MCP server:", error);
      });
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_request, response) => {
    methodNotAllowed(response);
  });

  app.delete("/mcp", (_request, response) => {
    methodNotAllowed(response);
  });

  return app;
}

export async function start(): Promise<void> {
  const api = createGradescopeClient();
  const transport = process.env.MCP_TRANSPORT ?? "stdio";

  if (transport === "http") {
    const port = Number.parseInt(process.env.MCP_PORT ?? "3100", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("MCP_PORT must be a valid TCP port");
    }

    const app = createHttpApp(api);
    app.listen(port, "0.0.0.0", () => {
      console.log(
        `MCP server listening on http://0.0.0.0:${port}/mcp (health: /healthz)`
      );
    });
    return;
  }

  if (transport !== "stdio") {
    throw new Error(`Unsupported MCP_TRANSPORT: ${transport}`);
  }

  const server = createServer(api);
  await server.connect(new StdioServerTransport());
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  try {
    await start();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
