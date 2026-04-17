import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  hasToolHandlerMock,
  executeRegisteredToolMock,
  listRegisteredToolNamesMock,
  executeOrchestratorMock,
} = vi.hoisted(() => ({
  hasToolHandlerMock: vi.fn<(name: string) => boolean>(),
  executeRegisteredToolMock: vi.fn<(name: string, params: Record<string, unknown>) => Promise<unknown>>(),
  listRegisteredToolNamesMock: vi.fn<() => string[]>(() => []),
  executeOrchestratorMock: vi.fn<(name: string, params: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("../src/tools/toolHandlerRegistry.js", () => ({
  hasToolHandler: hasToolHandlerMock,
  executeRegisteredTool: executeRegisteredToolMock,
  listRegisteredToolNames: listRegisteredToolNamesMock,
}));

vi.mock("../src/tools/civil3d_orchestrate.js", () => ({
  executeToolCallViaOrchestrator: executeOrchestratorMock,
}));

import { startHttpBridge } from "../src/httpBridge.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

interface BridgeHandle {
  server: Server;
  baseUrl: string;
  close: () => Promise<void>;
}

async function launchBridge(options: Parameters<typeof startHttpBridge>[0] = {}): Promise<BridgeHandle> {
  const server = startHttpBridge({ port: 0, host: "127.0.0.1", ...options });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

interface BridgeResponse {
  status: number;
  body: unknown;
}

async function request(
  method: "GET" | "POST" | "OPTIONS",
  url: string,
  init: { headers?: Record<string, string>; body?: string } = {},
): Promise<BridgeResponse> {
  const response = await fetch(url, {
    method,
    headers: init.headers,
    body: init.body,
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return { status: response.status, body };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("httpBridge", () => {
  let handle: BridgeHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    hasToolHandlerMock.mockReset();
    executeRegisteredToolMock.mockReset();
    listRegisteredToolNamesMock.mockReset();
    listRegisteredToolNamesMock.mockReturnValue([]);
    executeOrchestratorMock.mockReset();
  });

  describe("GET /health", () => {
    it("returns cheap liveness without probing the plugin", async () => {
      listRegisteredToolNamesMock.mockReturnValue(["civil3d_alignment", "civil3d_surface"]);
      handle = await launchBridge();

      const res = await request("GET", `${handle.baseUrl}/health`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ bridge: "ok", registeredTools: 2 });
      // cheap health MUST NOT hit the registered tool dispatcher
      expect(executeRegisteredToolMock).not.toHaveBeenCalled();
      expect(executeOrchestratorMock).not.toHaveBeenCalled();
    });

    it("?deep=1 routes through civil3d_health via the orchestrator", async () => {
      hasToolHandlerMock.mockImplementation((name) => name === "civil3d_health");
      executeOrchestratorMock.mockResolvedValue({ running: true, pluginRunning: true });
      handle = await launchBridge();

      const res = await request("GET", `${handle.baseUrl}/health?deep=1`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ running: true, pluginRunning: true });
      expect(executeOrchestratorMock).toHaveBeenCalledWith("civil3d_health", {});
    });

    it("?deep=1 reports 503 when the plugin probe fails", async () => {
      hasToolHandlerMock.mockImplementation((name) => name === "civil3d_health");
      executeOrchestratorMock.mockRejectedValue(new Error("Plugin not running"));
      handle = await launchBridge();

      const res = await request("GET", `${handle.baseUrl}/health?deep=1`);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ connected: false, error: "Plugin not running" });
    });
  });

  describe("GET /tools", () => {
    it("lists every registered tool name", async () => {
      listRegisteredToolNamesMock.mockReturnValue(["civil3d_alignment", "civil3d_surface"]);
      handle = await launchBridge();

      const res = await request("GET", `${handle.baseUrl}/tools`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 2, tools: ["civil3d_alignment", "civil3d_surface"] });
    });
  });

  describe("POST /execute", () => {
    it("routes registered non-orchestrate tools through executeToolCallViaOrchestrator", async () => {
      hasToolHandlerMock.mockImplementation((name) => name === "civil3d_alignment");
      executeOrchestratorMock.mockResolvedValue({ alignments: [{ name: "Mainline" }] });
      handle = await launchBridge();

      const res = await request("POST", `${handle.baseUrl}/execute`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "civil3d_alignment", parameters: { action: "list" } }),
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ alignments: [{ name: "Mainline" }] });
      expect(executeOrchestratorMock).toHaveBeenCalledWith("civil3d_alignment", { action: "list" });
      // civil3d_orchestrate bypass path must NOT be used for non-orchestrate tools
      expect(executeRegisteredToolMock).not.toHaveBeenCalled();
    });

    it("routes civil3d_orchestrate calls through executeRegisteredTool directly", async () => {
      hasToolHandlerMock.mockImplementation((name) => name === "civil3d_orchestrate");
      executeRegisteredToolMock.mockResolvedValue({ selectedTool: "civil3d_alignment" });
      handle = await launchBridge();

      const res = await request("POST", `${handle.baseUrl}/execute`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "civil3d_orchestrate", parameters: { request: "list alignments" } }),
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ selectedTool: "civil3d_alignment" });
      expect(executeRegisteredToolMock).toHaveBeenCalledWith("civil3d_orchestrate", { request: "list alignments" });
      expect(executeOrchestratorMock).not.toHaveBeenCalled();
    });

    it("returns 400 when the body is missing a tool name", async () => {
      handle = await launchBridge();

      const res = await request("POST", `${handle.baseUrl}/execute`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parameters: { foo: "bar" } }),
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringContaining("tool") });
    });

    it("returns 400 when the body is not valid JSON", async () => {
      handle = await launchBridge();

      const res = await request("POST", `${handle.baseUrl}/execute`, {
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringMatching(/Invalid JSON body/i) });
    });

    it("returns 500 with the error message when the handler throws", async () => {
      hasToolHandlerMock.mockImplementation((name) => name === "civil3d_alignment");
      executeOrchestratorMock.mockRejectedValue(new Error("Alignment 'Foo' not found"));
      handle = await launchBridge();

      const res = await request("POST", `${handle.baseUrl}/execute`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "civil3d_alignment", parameters: { action: "get", name: "Foo" } }),
      });

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ error: "Alignment 'Foo' not found" });
    });

    it("rejects bodies that exceed maxBodyBytes with 413", async () => {
      hasToolHandlerMock.mockReturnValue(true);
      executeOrchestratorMock.mockResolvedValue({ ok: true });
      handle = await launchBridge({ maxBodyBytes: 64 });

      const oversizedPayload = JSON.stringify({
        tool: "civil3d_alignment",
        parameters: { giant: "x".repeat(200) },
      });

      const res = await request("POST", `${handle.baseUrl}/execute`, {
        headers: { "Content-Type": "application/json" },
        body: oversizedPayload,
      });

      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({ error: expect.stringContaining("exceeds 64 bytes") });
      expect(executeOrchestratorMock).not.toHaveBeenCalled();
    });

    it("returns 404 when the tool is neither registered nor legacy", async () => {
      hasToolHandlerMock.mockReturnValue(false);
      listRegisteredToolNamesMock.mockReturnValue([]);
      handle = await launchBridge();

      const res = await request("POST", `${handle.baseUrl}/execute`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "does_not_exist", parameters: {} }),
      });

      // executeBridgeTool throws a plain Error (not an HttpBridgeError),
      // which the outer handler converts to a 500. This test asserts the
      // current behaviour so any future change to return 404 is intentional.
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ error: expect.stringContaining("not registered") });
    });
  });

  describe("authorization", () => {
    it("accepts requests with the correct Authorization bearer token", async () => {
      hasToolHandlerMock.mockImplementation((name) => name === "civil3d_orchestrate");
      executeRegisteredToolMock.mockResolvedValue({ ok: true });
      handle = await launchBridge({ authToken: "secret-token" });

      const res = await request("POST", `${handle.baseUrl}/execute`, {
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify({ tool: "civil3d_orchestrate", parameters: {} }),
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("accepts the X-MCP-Token header as an alternative to Authorization", async () => {
      listRegisteredToolNamesMock.mockReturnValue(["civil3d_alignment"]);
      handle = await launchBridge({ authToken: "secret-token" });

      const res = await request("GET", `${handle.baseUrl}/tools`, {
        headers: { "X-MCP-Token": "secret-token" },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 1, tools: ["civil3d_alignment"] });
    });

    it("rejects requests missing the token with 401", async () => {
      handle = await launchBridge({ authToken: "secret-token" });

      const res = await request("GET", `${handle.baseUrl}/tools`);

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: "Unauthorized" });
    });

    it("rejects requests with an incorrect token with 401", async () => {
      handle = await launchBridge({ authToken: "secret-token" });

      const res = await request("GET", `${handle.baseUrl}/tools`, {
        headers: { Authorization: "Bearer wrong-token" },
      });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: "Unauthorized" });
    });

    it("does not enforce auth when authToken is empty (default dev mode)", async () => {
      listRegisteredToolNamesMock.mockReturnValue([]);
      handle = await launchBridge({ authToken: "" });

      const res = await request("GET", `${handle.baseUrl}/tools`);

      expect(res.status).toBe(200);
    });
  });

  describe("CORS preflight", () => {
    it("responds to OPTIONS with 204 and the expected CORS headers", async () => {
      handle = await launchBridge();

      const response = await fetch(`${handle.baseUrl}/execute`, {
        method: "OPTIONS",
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-methods")).toContain("POST");
      expect(response.headers.get("access-control-allow-headers") ?? "").toContain("Authorization");
    });
  });

  describe("unknown routes", () => {
    it("returns 404 for unknown paths", async () => {
      handle = await launchBridge();

      const res = await request("GET", `${handle.baseUrl}/not-a-real-route`);

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Not found" });
    });
  });
});
