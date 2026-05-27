import * as Sentry from "@sentry/cloudflare";

type CaptureLevel = "fatal" | "error" | "warning" | "info";

type CaptureOptions = {
  context?: Record<string, unknown>;
  fingerprint?: string[];
  level?: CaptureLevel;
  operation: string;
  tags?: Record<string, string | number | boolean | null | undefined>;
};

function redactValue(key: string, value: unknown): unknown {
  if (value == null) return value;
  if (/password|secret|token|authorization|cookie|api[_-]?key/i.test(key)) return "[Redacted]";
  if (/email/i.test(key) && typeof value === "string") {
    const [local, domain] = value.split("@");
    return local && domain ? `${local.slice(0, 2)}***@${domain}` : "[RedactedEmail]";
  }
  if (/phone/i.test(key) && typeof value === "string") return "[RedactedPhone]";
  if (/name/i.test(key) && typeof value === "string") return "[RedactedName]";
  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function sanitizeContext(context?: Record<string, unknown>): Record<string, unknown> {
  if (!context) return {};
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [key, redactValue(key, value)]),
  );
}

function withOperationalScope(options: CaptureOptions, callback: () => void): void {
  Sentry.withScope((scope) => {
    scope.setLevel(options.level ?? "error");
    scope.setTag("app", "int-center-luggage-prd");
    scope.setTag("service", "luggage");
    scope.setTag("operation", options.operation);
    for (const [key, value] of Object.entries(options.tags ?? {})) {
      if (value != null) scope.setTag(key, String(value));
    }
    if (options.fingerprint) {
      scope.setFingerprint(["int-center-luggage-prd", ...options.fingerprint]);
    }
    scope.setContext("operation", {
      operation: options.operation,
      ...sanitizeContext(options.context),
    });
    callback();
  });
}

export function captureOperationalError(error: unknown, options: CaptureOptions): void {
  withOperationalScope(options, () => {
    if (error instanceof Error) {
      Sentry.captureException(error);
      return;
    }
    Sentry.captureException(new Error(typeof error === "string" ? error : "Operational error"), {
      extra: { payload: redactValue("payload", error) },
    });
  });
}

export function captureOperationalMessage(message: string, options: CaptureOptions): void {
  withOperationalScope(options, () => {
    Sentry.captureMessage(message, options.level ?? "warning");
  });
}
