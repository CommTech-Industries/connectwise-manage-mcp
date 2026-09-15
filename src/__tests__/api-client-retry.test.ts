import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CwManageApiError,
  CwManageClient,
  type CwManageConfig,
} from "../api-client.js";

const config: CwManageConfig = {
  baseUrl: "https://api-na.myconnectwise.net",
  companyId: "acme",
  publicKey: "public-key",
  privateKey: "private-key",
  clientId: "client-id",
};

function errorResponse(
  status: number,
  retryAfter?: string,
): Response {
  return new Response(JSON.stringify({ message: "request rejected" }), {
    status,
    headers: retryAfter ? { "Retry-After": retryAfter } : undefined,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CwManageClient retry behavior", () => {
  it("honors a numeric Retry-After on 429", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, "2"))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const request = new CwManageClient(config).get("/system/info");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(request).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors an HTTP-date Retry-After on 429", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0);
    const retryDate = new Date("2026-09-15T12:00:05.000Z").toUTCString();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, retryDate))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const request = new CwManageClient(config).get("/system/info");
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(request).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses full-jitter exponential backoff when Retry-After is absent", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const request = new CwManageClient(config).get("/system/info");
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(request).resolves.toEqual({ ok: true });
  });

  it("retries an explicit 429 for PATCH with the unchanged request body", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, "0"))
      .mockResolvedValueOnce(Response.json({ id: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const operations = [
      { op: "replace", path: "/status/id", value: 863 },
    ];

    const request = new CwManageClient(config).patch(
      "/service/tickets/1",
      operations,
    );
    await vi.runAllTimersAsync();

    await expect(request).resolves.toEqual({ id: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const options = call[1] as RequestInit;
      expect(options.method).toBe("PATCH");
      expect(JSON.parse(String(options.body))).toEqual(operations);
    }
  });

  it("stops after three retries and reports four total attempts", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi.fn().mockImplementation(async () => errorResponse(429));
    vi.stubGlobal("fetch", fetchMock);

    const request = new CwManageClient(config).get("/system/info");
    const rejection = expect(request).rejects.toMatchObject({
      status: 429,
      attempts: 4,
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not retry early when Retry-After exceeds the 60-second bound", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(429, "61"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new CwManageClient(config).get("/system/info")).rejects.toMatchObject({
      status: 429,
      attempts: 1,
      retryAfterMs: 61_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 422])("does not retry nontransient HTTP %s", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(status));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new CwManageClient(config).get("/system/info")).rejects.toBeInstanceOf(
      CwManageApiError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient GET responses and network errors", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("temporary network failure"))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const request = new CwManageClient(config).get("/system/info");
    await vi.runAllTimersAsync();

    await expect(request).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry ambiguous POST or PATCH failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(503))
      .mockRejectedValueOnce(new TypeError("connection reset"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CwManageClient(config);

    await expect(client.post("/service/tickets/1/notes", { text: "x" })).rejects.toMatchObject({
      status: 503,
      attempts: 1,
    });
    await expect(client.patch("/service/tickets/1", [])).rejects.toThrow(
      "connection reset",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not include authorization headers in structured error metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(401)));

    try {
      await new CwManageClient(config).get("/system/info");
      throw new Error("expected request to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CwManageApiError);
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain("Authorization");
      expect(serialized).not.toContain("private-key");
      expect(serialized).not.toContain("client-id");
    }
  });
});
