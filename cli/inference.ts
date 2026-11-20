import { CliError } from "./output.ts";

const DEFAULT_API_URL = "https://relay.inference.net/api/rest";

/** A webhook as the inference.net API returns it. `identifier` is what deliveries send in `X-Inference-Webhook-ID`. */
export interface Webhook {
  id: string;
  name: string | null;
  identifier: string;
  url: string;
  isDisabled: boolean;
}

export interface TestDelivery {
  success: boolean;
  statusCode: number;
  error?: string;
}

const KEY_FIX =
  "Use an inference.net API key with write access, created by a team owner or admin, in INFERENCE_API_KEY. Or unset INFERENCE_API_KEY to use the dashboard instead.";

/** The inference.net webhook API, with the API key from INFERENCE_API_KEY. */
export class InferenceApi {
  private readonly fetch: typeof fetch;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(fetchFn: typeof fetch, apiKey: string, baseUrl: string | undefined) {
    this.fetch = fetchFn;
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || DEFAULT_API_URL).replace(/\/+$/, "");
  }

  /**
   * False when this inference.net deployment has no webhook API yet (404, or no answer).
   * Throws on a rejected key, so the user fixes it instead of silently falling back.
   */
  async available(): Promise<boolean> {
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/webhooks?limit=1`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    } catch {
      return false;
    }
    if (response.status === 404) return false;
    await this.check(response);
    return true;
  }

  async create(url: string, name: string): Promise<Webhook> {
    return (await this.request<{ webhook: Webhook }>("POST", "/webhooks", { url, name })).webhook;
  }

  /** Null when the webhook no longer exists. */
  async get(id: string): Promise<Webhook | null> {
    const response = await this.send("GET", `/webhooks/${encodeURIComponent(id)}`);
    if (response.status === 404) return null;
    return ((await this.check(response)) as { webhook: Webhook }).webhook;
  }

  async update(id: string, changes: { url?: string; isDisabled?: boolean }): Promise<Webhook> {
    return (await this.request<{ webhook: Webhook }>("PATCH", `/webhooks/${encodeURIComponent(id)}`, changes)).webhook;
  }

  /** "deleted", or "missing" when it was already gone. */
  async delete(id: string): Promise<"deleted" | "missing"> {
    const response = await this.send("DELETE", `/webhooks/${encodeURIComponent(id)}`);
    if (response.status === 404) return "missing";
    await this.check(response);
    return "deleted";
  }

  /** Has inference.net send a real `webhook.test` delivery to the webhook URL, and reports how the URL answered. */
  async test(id: string): Promise<TestDelivery> {
    return this.request<TestDelivery>("POST", `/webhooks/${encodeURIComponent(id)}/test`, { eventType: "webhook.test" });
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new CliError(`Could not reach the inference.net API at ${this.baseUrl}: ${String(error)}`, "Check your network, then run the command again.");
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.check(await this.send(method, path, body))) as T;
  }

  /** The parsed body of a 2xx response; otherwise a CliError with the API's message and a fix. */
  private async check(response: Response): Promise<unknown> {
    const text = await response.text();
    let body: { message?: string } = {};
    try {
      body = JSON.parse(text) as { message?: string };
    } catch {
      // Not JSON, for example a proxy error page; the status code still says enough.
    }
    if (response.ok) return body;
    const message = `inference.net API answered HTTP ${response.status}: ${body.message ?? text.slice(0, 200)}`;
    if (response.status === 401) throw new CliError(message, `The API key is not valid. ${KEY_FIX}`);
    if (response.status === 403) throw new CliError(message, `The API key cannot manage webhooks. ${KEY_FIX}`);
    throw new CliError(message, "Check the message above. If it persists, use the inference.net dashboard (Settings → Integrations).");
  }
}
