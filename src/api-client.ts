/**
 * ConnectWise Manage API Client
 *
 * Fetch-based HTTP client that handles authentication, pagination,
 * and self-signed certificate support for both cloud and self-hosted instances.
 *
 * Environment variables:
 *   CW_MANAGE_URL              - API base URL (e.g. https://api-na.myconnectwise.net)
 *   CW_MANAGE_COMPANY_ID       - Company identifier
 *   CW_MANAGE_PUBLIC_KEY        - API member public key
 *   CW_MANAGE_PRIVATE_KEY       - API member private key
 *   CW_MANAGE_CLIENT_ID         - Client ID from ConnectWise Developer Portal
 *   CW_MANAGE_REJECT_UNAUTHORIZED - Set to "false" to allow self-signed certs (default: "true")
 *
 * Self-signed certificate support is scoped to this client instance's own
 * requests via an undici Agent passed as fetch's `dispatcher` option -- NOT
 * via the process-global NODE_TLS_REJECT_UNAUTHORIZED env var, which would
 * affect every concurrent request in the process (including unrelated
 * tenants' cloud-hosted, fully-verified connections).
 */
import { Agent } from "undici";

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
const MAX_RETRY_AFTER_MS = 60_000;
const RETRY_AFTER_JITTER_MS = 250;
const TRANSIENT_GET_STATUSES = new Set([408, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function jitteredBackoff(retryIndex: number): number {
  const ceiling = Math.min(
    MAX_BACKOFF_MS,
    BASE_BACKOFF_MS * 2 ** retryIndex,
  );
  return Math.floor(Math.random() * (ceiling + 1));
}

function retryDelay(retryIndex: number, retryAfterMs?: number): number {
  if (retryAfterMs === undefined) return jitteredBackoff(retryIndex);
  return Math.min(
    MAX_RETRY_AFTER_MS,
    retryAfterMs + Math.floor(Math.random() * (RETRY_AFTER_JITTER_MS + 1)),
  );
}

export class CwManageApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly attempts: number;
  readonly retryAfterMs?: number;

  constructor(args: {
    status: number;
    method: string;
    path: string;
    attempts: number;
    responseBody: string;
    retryAfterMs?: number;
  }) {
    super(
      `ConnectWise API ${args.method} ${args.path} returned ${args.status}: ${args.responseBody}`,
    );
    this.name = "CwManageApiError";
    this.status = args.status;
    this.method = args.method;
    this.path = args.path;
    this.attempts = args.attempts;
    this.retryAfterMs = args.retryAfterMs;
  }
}

export interface CwManageConfig {
  baseUrl: string;
  companyId: string;
  publicKey: string;
  privateKey: string;
  clientId: string;
}

export function getConfig(): CwManageConfig | null {
  const companyId = process.env.CW_MANAGE_COMPANY_ID;
  const publicKey = process.env.CW_MANAGE_PUBLIC_KEY;
  const privateKey = process.env.CW_MANAGE_PRIVATE_KEY;
  const clientId = process.env.CW_MANAGE_CLIENT_ID;

  if (!companyId || !publicKey || !privateKey || !clientId) {
    return null;
  }

  // Default to North America cloud. Override for EU, AU, or self-hosted.
  const baseUrl = (
    process.env.CW_MANAGE_URL || "https://api-na.myconnectwise.net"
  ).replace(/\/+$/, "");

  return { baseUrl, companyId, publicKey, privateKey, clientId };
}

/**
 * Low-level API client for ConnectWise Manage REST API.
 */
export class CwManageClient {
  private readonly authHeader: string;
  private readonly clientId: string;
  private readonly apiBase: string;
  private readonly dispatcher: Agent;

  constructor(config: CwManageConfig) {
    // Auth: Basic base64("{companyId}+{publicKey}:{privateKey}")
    const credentials = `${config.companyId}+${config.publicKey}:${config.privateKey}`;
    this.authHeader = `Basic ${Buffer.from(credentials).toString("base64")}`;
    this.clientId = config.clientId;
    // Append the standard API path if the URL doesn't already contain it
    this.apiBase = config.baseUrl.includes("/v4_6_release/")
      ? config.baseUrl.replace(/\/+$/, "")
      : `${config.baseUrl}/v4_6_release/apis/3.0`;
    const rejectUnauthorized =
      process.env.CW_MANAGE_REJECT_UNAUTHORIZED !== "false";
    // Scoped to this client instance's own connections only -- never touches
    // process.env, so a self-hosted (self-signed) instance's relaxed TLS
    // verification can never bleed into a concurrent request against a
    // different (cloud, fully-verified) tenant's connection.
    this.dispatcher = new Agent({ connect: { rejectUnauthorized } });
  }

  private defaultHeaders(): Record<string, string> {
    return {
      Authorization: this.authHeader,
      clientId: this.clientId,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  /**
   * Make a request to the ConnectWise Manage API.
   */
  async request<T = unknown>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      params?: Record<string, string | number | undefined>;
    },
  ): Promise<T> {
    const url = new URL(`${this.apiBase}${path}`);

    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const fetchOptions: RequestInit = {
      method,
      headers: this.defaultHeaders(),
    };

    // Self-hosted instances with self-signed certificates: the dispatcher
    // built in the constructor scopes rejectUnauthorized to THIS client's
    // connections only, with no process-global state involved.
    //
    // Assigned via a cast rather than a typed `dispatcher` field on
    // fetchOptions: Node's global fetch/RequestInit types (from the
    // `undici-types` package bundled with @types/node) declare their own
    // `Dispatcher` interface, structurally incompatible with the standalone
    // `undici` package's `Dispatcher` -- a well-known dual-package hazard.
    // The value is fully compatible at runtime (Node's fetch is undici under
    // the hood); only the type-checker sees two different declarations.
    (fetchOptions as { dispatcher?: unknown }).dispatcher = this.dispatcher;

    if (options?.body !== undefined) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    let attempts = 0;

    while (true) {
      attempts += 1;

      let response: Response;
      try {
        response = await fetch(url.toString(), fetchOptions);
      } catch (error: unknown) {
        const retriesUsed = attempts - 1;
        if (method === "GET" && retriesUsed < MAX_RETRIES) {
          await sleep(retryDelay(retriesUsed));
          continue;
        }
        throw error;
      }

      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
        const retriesUsed = attempts - 1;
        const retryable =
          response.status === 429 ||
          (method === "GET" && TRANSIENT_GET_STATUSES.has(response.status));
        const retryAfterIsBounded =
          retryAfterMs === undefined || retryAfterMs <= MAX_RETRY_AFTER_MS;

        if (
          retryable &&
          retriesUsed < MAX_RETRIES &&
          retryAfterIsBounded
        ) {
          // Consume the body so the connection can be reused before retrying.
          await response.text();
          await sleep(retryDelay(retriesUsed, retryAfterMs));
          continue;
        }

        const errorBody = await response.text();
        throw new CwManageApiError({
          status: response.status,
          method,
          path,
          attempts,
          responseBody: errorBody,
          retryAfterMs,
        });
      }

      // Some endpoints return 204 No Content
      if (response.status === 204) {
        return undefined as T;
      }

      return (await response.json()) as T;
    }
  }

  /** GET helper */
  async get<T = unknown>(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T> {
    return this.request<T>("GET", path, { params });
  }

  /** POST helper */
  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  /** PATCH helper */
  async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }
}
