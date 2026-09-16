export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly type: string,
    message: string,
    public readonly model?: string
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function asGatewayError(
  error: unknown,
  fallbackStatus: number,
  fallbackType: string,
  fallbackMessage?: string
): GatewayError {
  if (error instanceof GatewayError) return error;
  const message = fallbackMessage ?? (
    error instanceof Error ? error.message : String(error)
  );
  return new GatewayError(fallbackStatus, fallbackType, message);
}
