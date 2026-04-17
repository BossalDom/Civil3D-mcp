import { createServer, IncomingMessage, ServerResponse } from "node:http";
import {
  hasToolHandler,
  executeRegisteredTool,
  listRegisteredToolNames,
} from "./tools/toolHandlerRegistry.js";
import { executeToolCallViaOrchestrator } from "./tools/civil3d_orchestrate.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("HttpBridge");

export interface HttpBridgeOptions {
  host?: string;
  port?: number;
  authToken?: string | undefined;
  maxBodyBytes?: number;
}

interface ResolvedHttpBridgeConfig {
  host: string;
  port: number;
  authToken: string | undefined;
  maxBodyBytes: number;
}

function resolveConfig(options: HttpBridgeOptions = {}): ResolvedHttpBridgeConfig {
  const envPort = process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT, 10) : 3000;
  const envMaxBody = process.env.MCP_HTTP_MAX_BODY_BYTES
    ? parseInt(process.env.MCP_HTTP_MAX_BODY_BYTES, 10)
    : 1048576;

  return {
    host: options.host ?? process.env.MCP_HTTP_HOST ?? "127.0.0.1",
    port: options.port ?? envPort,
    authToken:
      options.authToken !== undefined
        ? options.authToken || undefined
        : process.env.MCP_HTTP_TOKEN?.trim() || undefined,
    maxBodyBytes: options.maxBodyBytes ?? envMaxBody,
  };
}

class HttpBridgeError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

type ExecuteRequest = {
  tool?: string;
  parameters?: Record<string, unknown>;
};

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<ExecuteRequest> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBodyBytes) {
      throw new HttpBridgeError(
        413,
        `Request body exceeds ${maxBodyBytes} bytes.`,
      );
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as ExecuteRequest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpBridgeError(400, `Invalid JSON body: ${message}`);
  }
}

function isAuthorized(request: IncomingMessage, authToken: string | undefined): boolean {
  if (!authToken) {
    return true; // auth disabled when MCP_HTTP_TOKEN is unset
  }

  const header = request.headers["authorization"];
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim() === authToken;
  }

  const altHeader = request.headers["x-mcp-token"];
  if (typeof altHeader === "string") {
    return altHeader.trim() === authToken;
  }

  return false;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.end(JSON.stringify(payload));
}

/**
 * Legacy convenience endpoints used by the Copilot's McpClient.cs for
 * drawing-context queries. These tool names do NOT correspond to registered
 * MCP tools — they are synthetic shortcuts that map directly to C# plugin commands.
 */
const LEGACY_TOOL_NAMES = new Set([
  "civil3d_list_alignments",
  "civil3d_list_surfaces",
  "civil3d_list_profiles",
  "civil3d_list_assemblies",
  "civil3d_list_corridors",
  "civil3d_alignment_report",
  "civil3d_surface_report",
]);

async function executeLegacyTool(toolName: string, parameters: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case "civil3d_list_alignments":
      return await executeToolCallViaOrchestrator("civil3d_alignment", { action: "list" });
    case "civil3d_list_surfaces":
      return await executeToolCallViaOrchestrator("civil3d_surface", { action: "list" });
    case "civil3d_list_profiles":
      return await executeToolCallViaOrchestrator("civil3d_profile", {
        action: "list",
        alignmentName: parameters.alignmentName,
      });
    case "civil3d_list_assemblies":
      return await executeToolCallViaOrchestrator("civil3d_assembly", { action: "list" });
    case "civil3d_list_corridors":
      return await executeToolCallViaOrchestrator("civil3d_corridor", { action: "list" });
    case "civil3d_alignment_report":
      return await executeToolCallViaOrchestrator("civil3d_alignment_report", {
        alignmentName: parameters.alignmentName,
      });
    case "civil3d_surface_report":
      return await executeToolCallViaOrchestrator("civil3d_surface", {
        action: "get",
        name: parameters.surfaceName,
      });
    default:
      throw new Error(`Unknown legacy tool '${toolName}'.`);
  }
}

/**
 * Execute a tool by name. Resolution order:
 *   1. Registered MCP tool handlers (all 180+ tools)
 *   2. Legacy synthetic endpoints (drawing-context convenience queries)
 *   3. Error
 */
async function executeBridgeTool(toolName: string, parameters: Record<string, unknown>): Promise<unknown> {
  // 1. Check the global tool handler registry (populated during registerTools)
  if (hasToolHandler(toolName)) {
    if (toolName === "civil3d_orchestrate") {
      return await executeRegisteredTool(toolName, parameters);
    }

    return await executeToolCallViaOrchestrator(toolName, parameters);
  }

  // 2. Legacy convenience endpoints for Copilot drawing-context queries
  if (LEGACY_TOOL_NAMES.has(toolName)) {
    return await executeLegacyTool(toolName, parameters);
  }

  // 3. Not found
  const registeredCount = listRegisteredToolNames().length;
  throw new Error(
    `Tool '${toolName}' is not registered (${registeredCount} tools available) ` +
    `and is not a legacy bridge endpoint. Check the tool name.`
  );
}

async function handleHealth(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // Cheap liveness by default — only probe the plugin when ?deep=1 is set.
  const url = new URL(request.url ?? "/health", "http://localhost");
  const deep = url.searchParams.get("deep") === "1";

  if (!deep) {
    writeJson(response, 200, {
      bridge: "ok",
      registeredTools: listRegisteredToolNames().length,
    });
    return;
  }

  try {
    // civil3d_health is a registered MCP tool — route through the main dispatcher
    const result = await executeBridgeTool("civil3d_health", {});
    writeJson(response, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJson(response, 503, {
      connected: false,
      error: message,
    });
  }
}

async function handleExecute(
  request: IncomingMessage,
  response: ServerResponse,
  maxBodyBytes: number,
): Promise<void> {
  try {
    const body = await readJsonBody(request, maxBodyBytes);
    if (!body.tool || typeof body.tool !== "string") {
      writeJson(response, 400, { error: "Request body must include a string 'tool' property." });
      return;
    }

    const parameters = body.parameters && typeof body.parameters === "object"
      ? body.parameters
      : {};

    const result = await executeBridgeTool(body.tool, parameters);
    writeJson(response, 200, result);
  } catch (error) {
    if (error instanceof HttpBridgeError) {
      writeJson(response, error.statusCode, { error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    writeJson(response, 500, { error: message });
  }
}

function writePreflight(response: ServerResponse): void {
  response.statusCode = 204;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-MCP-Token");
  response.end();
}

export function startHttpBridge(options: HttpBridgeOptions = {}) {
  const config = resolveConfig(options);

  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const rawUrl = request.url ?? "/";
      const path = rawUrl.split("?", 1)[0];

      if (method === "OPTIONS") {
        writePreflight(response);
        return;
      }

      // Auth applies to every non-preflight route when MCP_HTTP_TOKEN is set.
      if (!isAuthorized(request, config.authToken)) {
        writeJson(response, 401, { error: "Unauthorized" });
        return;
      }

      if (method === "GET" && path === "/health") {
        await handleHealth(request, response);
        return;
      }

      if (method === "GET" && path === "/tools") {
        const tools = listRegisteredToolNames();
        writeJson(response, 200, { count: tools.length, tools });
        return;
      }

      if (method === "POST" && path === "/execute") {
        await handleExecute(request, response, config.maxBodyBytes);
        return;
      }

      writeJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof HttpBridgeError) {
        writeJson(response, error.statusCode, { error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, 500, { error: message });
    }
  });

  server.listen(config.port, config.host, () => {
    log.info("HTTP MCP bridge started", {
      host: config.host,
      port: config.port,
      authEnabled: Boolean(config.authToken),
      maxBodyBytes: config.maxBodyBytes,
    });
  });

  server.on("error", (error) => {
    log.error("HTTP MCP bridge failed", { error: String(error) });
  });

  return server;
}
