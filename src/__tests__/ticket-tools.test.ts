import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker.js";

const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "X-CW-Company-Id": "acme",
  "X-CW-Public-Key": "pub",
  "X-CW-Private-Key": "priv",
  "X-CW-Client-Id": "client-guid",
};

async function mcp(body: unknown): Promise<Record<string, unknown>> {
  const response = await worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(body),
    }),
    { AUTH_MODE: "gateway" },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

interface ToolEntry {
  name: string;
  description?: string;
  inputSchema: {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  outputSchema?: Record<string, unknown>;
}

async function tools(): Promise<ToolEntry[]> {
  const body = (await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  })) as { result?: { tools?: ToolEntry[] } };
  return body.result?.tools ?? [];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ticket workflow MCP tools", () => {
  it("publishes scalar-only inputs for the dedicated status tool", async () => {
    const tool = (await tools()).find((entry) => entry.name === "cw_set_ticket_status");

    expect(tool).toBeDefined();
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
      "ticketId",
      "statusName",
    ]);
    expect(tool?.inputSchema.required).toEqual(["ticketId", "statusName"]);
    expect(tool?.inputSchema.properties?.ticketId?.type).toBe("integer");
    expect(tool?.inputSchema.properties?.statusName?.type).toBe("string");
    expect(JSON.stringify(tool?.inputSchema)).not.toMatch(
      /operations|"op"|"path"|"value"/,
    );
    expect(tool?.outputSchema).toBeDefined();
  });

  it("publishes scalar-only inputs for unattended finalization", async () => {
    const tool = (await tools()).find(
      (entry) => entry.name === "cw_add_internal_note_and_set_status",
    );

    expect(tool).toBeDefined();
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
      "ticketId",
      "internalNote",
      "statusName",
    ]);
    expect(tool?.inputSchema.required).toEqual([
      "ticketId",
      "internalNote",
      "statusName",
    ]);
    expect(tool?.inputSchema.properties?.internalNote?.type).toBe("string");
    expect(JSON.stringify(tool?.inputSchema)).not.toMatch(
      /operations|"op"|"path"|"value"/,
    );
  });

  it("returns matching structured and text output after verified status update", async () => {
    let ticketReadCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, options?: RequestInit) => {
        const href = String(url);
        if (href.includes("/boards/12/statuses")) {
          return Response.json([{ id: 863, name: "SOW Needs Review" }]);
        }
        if (options?.method === "PATCH") {
          expect(JSON.parse(String(options.body))).toEqual([
            { op: "replace", path: "/status/id", value: 863 },
          ]);
          return Response.json({ status: { id: 863, name: "SOW Needs Review" } });
        }
        ticketReadCount += 1;
        return Response.json({
          id: 543754,
          board: { id: 12, name: "Presales" },
          status:
            ticketReadCount === 1
              ? { id: 100, name: "Copilot" }
              : { id: 863, name: "SOW Needs Review" },
        });
      }),
    );

    const body = (await mcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "cw_set_ticket_status",
        arguments: { ticketId: 543754, statusName: "SOW Needs Review" },
      },
    })) as {
      result?: {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content?: Array<{ text?: string }>;
      };
    };

    expect(body.result?.isError).toBe(false);
    expect(body.result?.structuredContent).toMatchObject({
      success: true,
      outcome: "updated",
      verifiedStatus: { id: 863, name: "SOW Needs Review" },
    });
    expect(JSON.parse(body.result?.content?.[0]?.text ?? "{}")).toEqual(
      body.result?.structuredContent,
    );
  });

  it("keeps cw_update_ticket schema and arbitrary patch forwarding compatible", async () => {
    const updateTool = (await tools()).find(
      (entry) => entry.name === "cw_update_ticket",
    );
    const operationSchema = updateTool?.inputSchema.properties?.operations as {
      items?: { properties?: { op?: { enum?: string[] } } };
    };
    expect(operationSchema.items?.properties?.op?.enum).toEqual([
      "replace",
      "add",
      "remove",
    ]);
    expect(updateTool?.description).toContain("cw_set_ticket_status");

    const operations = [{ op: "replace", path: "/summary", value: "Updated" }];
    const fetchMock = vi.fn(async (_url: string | URL, options?: RequestInit) => {
      expect(options?.method).toBe("PATCH");
      expect(JSON.parse(String(options?.body))).toEqual(operations);
      return Response.json({ id: 99, summary: "Updated" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const body = (await mcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "cw_update_ticket",
        arguments: { id: 99, operations },
      },
    })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };

    expect(body.result?.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(body.result?.content?.[0]?.text ?? "{}")).toEqual({
      id: 99,
      summary: "Updated",
    });
  });
});
