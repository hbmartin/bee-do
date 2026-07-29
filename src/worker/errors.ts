import type { DeliveredChannel } from "../shared/capture";

export type ErrorStage =
  | "routing"
  | "authentication"
  | "request"
  | "validation"
  | "configuration"
  | "internal"
  | "channel_create"
  | "root_message"
  | "image_upload"
  | "permalink";

export type RequiredDeliveryStage = Extract<
  ErrorStage,
  "channel_create" | "root_message" | "image_upload" | "permalink"
>;

export class WorkerError extends Error {
  readonly code: string;
  readonly stage: ErrorStage;
  readonly status: number;
  readonly retryable: boolean;
  /** Set when the failure left a Request Channel behind that the caller needs to know about. */
  readonly slack?: DeliveredChannel;

  constructor(options: {
    code: string;
    stage: ErrorStage;
    status: number;
    message: string;
    retryable: boolean;
    slack?: DeliveredChannel;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "WorkerError";
    this.code = options.code;
    this.stage = options.stage;
    this.status = options.status;
    this.retryable = options.retryable;
    if (options.slack !== undefined) this.slack = options.slack;
  }
}

export function requiredDeliveryError(
  stage: RequiredDeliveryStage,
  cause: unknown,
  slack?: DeliveredChannel,
): WorkerError {
  const descriptions = {
    channel_create: "Slack request channel could not be created",
    root_message: "Slack request summary could not be posted",
    image_upload: "Capture image could not be uploaded to Slack",
    permalink: "Slack request link could not be resolved",
  } as const;

  return new WorkerError({
    code: `${stage.toUpperCase()}_FAILED`,
    stage,
    status: 502,
    message: descriptions[stage],
    retryable: true,
    ...(slack !== undefined ? { slack } : {}),
    cause,
  });
}
