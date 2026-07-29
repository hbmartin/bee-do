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

export class WorkerError extends Error {
  readonly code: string;
  readonly stage: ErrorStage;
  readonly status: number;
  readonly retryable: boolean;

  constructor(options: {
    code: string;
    stage: ErrorStage;
    status: number;
    message: string;
    retryable: boolean;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "WorkerError";
    this.code = options.code;
    this.stage = options.stage;
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

export function requiredDeliveryError(
  stage: Extract<
    ErrorStage,
    "channel_create" | "root_message" | "image_upload" | "permalink"
  >,
  cause: unknown,
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
    cause,
  });
}
