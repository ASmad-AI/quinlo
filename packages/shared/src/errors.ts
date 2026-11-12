export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "validation"
  | "tenant_mismatch"
  | "profile_denied"
  | "upstream_error"
  | "internal";

/** Application error with a stable machine-readable code and HTTP status. */
export class ForgeError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status?: number, details?: unknown) {
    super(message);
    this.name = "ForgeError";
    this.code = code;
    this.status = status ?? ForgeError.defaultStatus(code);
    this.details = details;
  }

  static defaultStatus(code: ErrorCode): number {
    switch (code) {
      case "bad_request":
      case "validation":
        return 400;
      case "unauthorized":
        return 401;
      case "forbidden":
      case "profile_denied":
      case "tenant_mismatch":
        return 403;
      case "not_found":
        return 404;
      case "conflict":
        return 409;
      case "rate_limited":
        return 429;
      case "upstream_error":
        return 502;
      default:
        return 500;
    }
  }

  toJSON(): { code: ErrorCode; message: string; details?: unknown } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function badRequest(message: string, details?: unknown): ForgeError {
  return new ForgeError("bad_request", message, 400, details);
}

export function forbidden(message: string, details?: unknown): ForgeError {
  return new ForgeError("forbidden", message, 403, details);
}

export function notFound(what: string): ForgeError {
  return new ForgeError("not_found", `${what} not found`, 404);
}

export function profileDenied(reason: string): ForgeError {
  return new ForgeError("profile_denied", `Denied by security profile: ${reason}`, 403);
}

export function tenantMismatch(): ForgeError {
  return new ForgeError(
    "tenant_mismatch",
    "Resource belongs to a different organization",
    403,
  );
}
