import type { Fetcher } from "./types";

const SLACK_API_URL = "https://slack.com/api";

type SlackEnvelope = {
  ok?: boolean;
  error?: string;
};

export class SlackApiError extends Error {
  readonly method: string;
  readonly slackCode?: string;
  readonly httpStatus: number;

  constructor(options: {
    method: string;
    message: string;
    httpStatus: number;
    slackCode?: string;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "SlackApiError";
    this.method = options.method;
    this.httpStatus = options.httpStatus;
    if (options.slackCode !== undefined) this.slackCode = options.slackCode;
  }
}

export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async api<T extends SlackEnvelope>(
    method: string,
    body: Record<string, unknown>,
    httpMethod: "GET" | "POST" = "POST",
  ): Promise<T> {
    const url = new URL(`${SLACK_API_URL}/${method}`);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
    };
    let encodedBody: string | undefined;
    if (httpMethod === "GET") {
      for (const [key, value] of Object.entries(body)) {
        if (
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean"
        ) {
          throw new TypeError(`Slack GET parameter ${key} must be scalar`);
        }
        url.searchParams.set(key, String(value));
      }
    } else {
      headers["content-type"] = "application/json; charset=utf-8";
      encodedBody = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: httpMethod,
        headers,
        ...(encodedBody !== undefined ? { body: encodedBody } : {}),
      });
    } catch (error) {
      throw new SlackApiError({
        method,
        message: `Slack ${method} request failed`,
        httpStatus: 0,
        cause: error,
      });
    }

    let envelope: SlackEnvelope;
    try {
      envelope = (await response.json()) as SlackEnvelope;
    } catch (error) {
      throw new SlackApiError({
        method,
        message: `Slack ${method} returned an invalid response`,
        httpStatus: response.status,
        cause: error,
      });
    }

    if (!response.ok || envelope.ok !== true) {
      throw new SlackApiError({
        method,
        message: `Slack ${method} was rejected`,
        httpStatus: response.status,
        ...(typeof envelope.error === "string"
          ? { slackCode: envelope.error }
          : {}),
      });
    }

    return envelope as T;
  }

  async upload(uploadUrl: string, bytes: ArrayBuffer, mimeType: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher(uploadUrl, {
        method: "POST",
        headers: { "content-type": mimeType },
        body: bytes,
      });
    } catch (error) {
      throw new SlackApiError({
        method: "external_upload",
        message: "Slack external upload request failed",
        httpStatus: 0,
        cause: error,
      });
    }

    if (!response.ok) {
      throw new SlackApiError({
        method: "external_upload",
        message: "Slack external upload was rejected",
        httpStatus: response.status,
      });
    }
  }
}
