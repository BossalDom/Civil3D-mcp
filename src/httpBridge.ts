import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  hasToolHandler,
  executeRegisteredTool,
  listRegisteredToolNames,
} from "./tools/toolHandlerRegistry.js";
import { executeToolCallViaOrchestrator } from "./tools/civil3d_orchestrate.js";
import { createLogger } from "./utils/logger.js";
import { Civil3DRpcError } from "./utils/SocketClient.js";

const log = createLogger("HttpBridge");

export interface HttpBridgeOptions {
  host?: string;
  port?: number;
  authToken?: string | undefined;
  maxBodyBytes?: number;
  allowedOrigins?: string[];
  allowedHosts?: string[];
}

interface ResolvedHttpBridgeConfig {
  host: string;
  port: number;
  authToken: string | undefined;
  maxBodyBytes: number;
  allowedOrigins: string[];
  allowedHosts: string[];
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "[::1]";
}

function parseAllowedOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((host) => normalizeHost(host))
    .filter((host): host is string => Boolean(host));
}

function normalizeHost(authority: string | undefined): string | undefined {
  if (!authority?.trim()) return undefined;
  try {
    return new URL(`http://${authority.trim()}`).hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
  } catch {
    return undefined;
  }
}

function resolveConfig(options: HttpBridgeOptions = {}): ResolvedHttpBridgeConfig {
  const envPort = process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT, 10) : 3000;
  const envMaxBody = process.env.MCP_HTTP_MAX_BODY_BYTES
    ? parseInt(process.env.MCP_HTTP_MAX_BODY_BYTES, 10)
    : 1048576;

  const config: ResolvedHttpBridgeConfig = {
    host: options.host ?? process.env.MCP_HTTP_HOST ?? "127.0.0.1",
    port: options.port ?? envPort,
    authToken:
      options.authToken !== undefined
        ? options.authToken || undefined
        : process.env.MCP_HTTP_TOKEN?.trim() || undefined,
    maxBodyBytes: options.maxBodyBytes ?? envMaxBody,
    allowedOrigins: options.allowedOrigins
      ?? parseAllowedOrigins(process.env.MCP_HTTP_ALLOWED_ORIGINS),
    allowedHosts: options.allowedHosts
      ? options.allowedHosts
        .map((host) => normalizeHost(host))
        .filter((host): host is string => Boolean(host))
      : parseAllowedHosts(process.env.MCP_HTTP_ALLOWED_HOSTS),
  };

  if (!isLoopbackHost(config.host) && !config.authToken) {
    throw new Error(
      `MCP_HTTP_TOKEN is required when the HTTP bridge binds to non-loopback host '${config.host}'.`,
    );
  }

  if (config.allowedHosts.length === 0) {
    if (!isLoopbackHost(config.host)) {
      throw new Error(
        `MCP_HTTP_ALLOWED_HOSTS is required when the HTTP bridge binds to non-loopback host '${config.host}'.`,
      );
    }
    config.allowedHosts = ["localhost", "127.0.0.1", "::1"];
  }

  if (config.allowedOrigins.includes("*") || config.allowedHosts.includes("*")) {
    throw new Error("Wildcard HTTP origins and hosts are not permitted.");
  }

  return config;
}

class HttpBridgeError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
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
        "CIVIL3D.REQUEST_TOO_LARGE",
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
    throw new HttpBridgeError(400, "CIVIL3D.INVALID_JSON", `Invalid JSON body: ${message}`);
  }
}

function isAuthorized(request: IncomingMessage, authToken: string | undefined): boolean {
  if (!authToken) {
    return true; // auth disabled when MCP_HTTP_TOKEN is unset
  }

  const header = request.headers["authorization"];
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return tokensEqual(header.slice("Bearer ".length).trim(), authToken);
  }

  const altHeader = request.headers["x-mcp-token"];
  if (typeof altHeader === "string") {
    return tokensEqual(altHeader.trim(), authToken);
  }

  return false;
}

function tokensEqual(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return candidateBytes.length === expectedBytes.length
    && timingSafeEqual(candidateBytes, expectedBytes);
}

function isOriginAllowed(request: IncomingMessage, allowedOrigins: string[]): boolean {
  const origin = request.headers.origin;
  return typeof origin !== "string" || allowedOrigins.includes(origin);
}

function isHostAllowed(request: IncomingMessage, allowedHosts: string[]): boolean {
  const host = normalizeHost(request.headers.host);
  return typeof host === "string" && allowedHosts.includes(host);
}

function applyCorsHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: string[],
): void {
  const origin = request.headers.origin;
  if (typeof origin === "string" && allowedOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.end(JSON.stringify(payload));
}

function writeError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  writeJson(response, statusCode, { error: { code, message } });
}

function statusForDomainCode(code: string): number {
  if (code === "CIVIL3D.INVALID_JSON" || code === "CIVIL3D.INVALID_REQUEST" || code === "CIVIL3D.INVALID_INPUT") return 400;
  if (code === "CIVIL3D.AUTH_REQUIRED") return 401;
  if (code === "CIVIL3D.FORBIDDEN" || code === "CIVIL3D.PATH_NOT_ALLOWED" || code === "CIVIL3D.FILE_TYPE_NOT_ALLOWED") return 403;
  if (code === "CIVIL3D.OBJECT_NOT_FOUND" || code === "CIVIL3D.METHOD_NOT_FOUND") return 404;
  if (code === "CIVIL3D.CONFLICT") return 409;
  if (code === "CIVIL3D.REQUEST_TOO_LARGE") return 413;
  if (code === "CIVIL3D.TIMEOUT") return 504;
  if (code === "CIVIL3D.NO_DRAWING" || code === "CIVIL3D.UNAVAILABLE" || code === "CIVIL3D.HOST_BUSY") return 503;
  return 500;
}

function mapHttpError(error: unknown): HttpBridgeError {
  if (error instanceof HttpBridgeError) return error;
  if (error instanceof Civil3DRpcError) {
    return new HttpBridgeError(statusForDomainCode(error.code), error.code, error.message);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/i.test(message)) {
    return new HttpBridgeError(504, "CIVIL3D.TIMEOUT", message);
  }
  if (/failed to connect|connection (?:failed|closed)|plugin not running/i.test(message)) {
    return new HttpBridgeError(503, "CIVIL3D.UNAVAILABLE", message);
  }
  if (/approval required|already exists|conflict/i.test(message)) {
    return new HttpBridgeError(409, "CIVIL3D.CONFLICT", message);
  }
  if (/not found|not registered|does not exist/i.test(message)) {
    return new HttpBridgeError(404, "CIVIL3D.OBJECT_NOT_FOUND", message);
  }
  if (/missing required|required fields?|invalid (?:input|parameter)|validation/i.test(message)) {
    return new HttpBridgeError(400, "CIVIL3D.INVALID_INPUT", message);
  }
  if (error instanceof Error && error.name === "ZodError") {
    return new HttpBridgeError(400, "CIVIL3D.INVALID_INPUT", message);
  }
  return new HttpBridgeError(500, "CIVIL3D.INTERNAL_ERROR", message);
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
  throw new HttpBridgeError(
    404,
    "CIVIL3D.METHOD_NOT_FOUND",
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
    const mapped = mapHttpError(error);
    writeJson(response, 503, {
      connected: false,
      error: { code: "CIVIL3D.UNAVAILABLE", message: mapped.message },
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
      writeError(response, 400, "CIVIL3D.INVALID_INPUT", "Request body must include a string 'tool' property.");
      return;
    }

    const parameters = body.parameters && typeof body.parameters === "object"
      ? body.parameters
      : {};

    const result = await executeBridgeTool(body.tool, parameters);
    writeJson(response, 200, result);
  } catch (error) {
    const mapped = mapHttpError(error);
    writeError(response, mapped.statusCode, mapped.code, mapped.message);
  }
}

function writePreflight(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: string[],
): void {
  response.statusCode = 204;
  applyCorsHeaders(request, response, allowedOrigins);
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

      if (!isHostAllowed(request, config.allowedHosts)) {
        writeError(response, 403, "CIVIL3D.FORBIDDEN", "Host is not allowed");
        return;
      }

      if (!isOriginAllowed(request, config.allowedOrigins)) {
        writeError(response, 403, "CIVIL3D.FORBIDDEN", "Origin is not allowed");
        return;
      }

      applyCorsHeaders(request, response, config.allowedOrigins);

      if (method === "OPTIONS") {
        writePreflight(request, response, config.allowedOrigins);
        return;
      }

      // Auth applies to every non-preflight route when MCP_HTTP_TOKEN is set.
      if (!isAuthorized(request, config.authToken)) {
        writeError(response, 401, "CIVIL3D.AUTH_REQUIRED", "Unauthorized");
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

      writeError(response, 404, "CIVIL3D.OBJECT_NOT_FOUND", "Not found");
    } catch (error) {
      const mapped = mapHttpError(error);
      writeError(response, mapped.statusCode, mapped.code, mapped.message);
    }
  });

  server.listen(config.port, config.host, () => {
    log.info("HTTP MCP bridge started", {
      host: config.host,
      port: config.port,
      authEnabled: Boolean(config.authToken),
      allowedOrigins: config.allowedOrigins,
      allowedHosts: config.allowedHosts,
      maxBodyBytes: config.maxBodyBytes,
    });
  });

  server.on("error", (error) => {
    log.error("HTTP MCP bridge failed", { error: String(error) });
  });

  return server;
}
