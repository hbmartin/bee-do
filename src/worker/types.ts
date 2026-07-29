export interface Env {
  SLACK_BOT_TOKEN: string;
  CAPTURE_INGEST_SECRET: string;
  SLACK_REVIEWER_IDS?: string;
}

export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type DeliveryWarning =
  | "INVITE_FAILED"
  | "INVALID_REVIEWER_ID"
  | "DIAGNOSTICS_POST_FAILED";
