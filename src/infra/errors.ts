// Normalizes error objects for codes, names, messages, and redacted logs.
import { redactSensitiveText } from "../logging/redact.js";

function readAccessor(value: object, key: PropertyKey): unknown {
  return Reflect.get(Object.getOwnPropertyDescriptor(value, key) ?? {}, "get");
}

function createNativeErrorAccessors(): Map<PropertyKey, Set<unknown>> {
  const accessors = new Map<PropertyKey, Set<unknown>>();
  const add = (key: PropertyKey, getter: unknown): void => {
    if (typeof getter !== "function") {
      return;
    }
    const getters = accessors.get(key) ?? new Set<unknown>();
    getters.add(getter);
    accessors.set(key, getters);
  };

  add("stack", readAccessor(new Error(), "stack"));
  for (const key of ["name", "message", "code", "stack"] as const) {
    add(key, readAccessor(DOMException.prototype, key));
  }
  return accessors;
}

// Native Error and DOMException accessors carry platform-owned diagnostics.
// Unknown accessors remain unread so normalization cannot execute user code.
const nativeErrorAccessors = createNativeErrorAccessors();

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function readDataProperty(value: unknown, key: PropertyKey): unknown {
  if (!isObjectLike(value)) {
    return undefined;
  }

  const seen = new Set<object>();
  let current: object | null = value;
  while (current && !seen.has(current)) {
    seen.add(current);
    try {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        if ("value" in descriptor) {
          return descriptor.value;
        }
        const getter = Reflect.get(descriptor, "get");
        const isInheritedErrorAccessor = current !== value && isError(value);
        if (
          (nativeErrorAccessors.get(key)?.has(getter) || isInheritedErrorAccessor) &&
          isError(value)
        ) {
          try {
            return typeof getter === "function" ? Reflect.apply(getter, value, []) : undefined;
          } catch {
            return undefined;
          }
        }
        return undefined;
      }
      current = Object.getPrototypeOf(current);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function stringifyUnknownValue(value: unknown): string {
  if (
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string") {
      return serialized;
    }
  } catch {
    // Fall through to a stable object tag when JSON serialization is unavailable.
  }
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return `[${typeof value}]`;
  }
}

function describeUnknownValueWithoutAccessors(value: unknown): string {
  if (!isObjectLike(value)) {
    return stringifyUnknownValue(value);
  }
  return typeof value === "function" ? "[function]" : "[object Object]";
}

export function extractErrorCode(err: unknown): string | undefined {
  const code = readDataProperty(err, "code");
  if (typeof code === "string") {
    return code;
  }
  if (typeof code === "number") {
    return String(code);
  }
  return undefined;
}

export function readErrorName(err: unknown): string {
  const name = readDataProperty(err, "name");
  return typeof name === "string" ? name : "";
}

export function collectErrorGraphCandidates(
  err: unknown,
  resolveNested?: (current: Record<string, unknown>) => Iterable<unknown>,
): unknown[] {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  const candidates: unknown[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    candidates.push(current);

    if (!current || typeof current !== "object" || !resolveNested) {
      continue;
    }
    for (const nested of resolveNested(current as Record<string, unknown>)) {
      if (nested != null && !seen.has(nested)) {
        queue.push(nested);
      }
    }
  }

  return candidates;
}

/**
 * Type guard for NodeJS.ErrnoException (any error with a `code` property).
 */
export function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err && typeof err === "object" && "code" in err);
}

/**
 * Check if an error has a specific errno code.
 */
export function hasErrnoCode(err: unknown, code: string): boolean {
  return isErrno(err) && err.code === code;
}

export function formatErrorMessage(err: unknown): string {
  let formatted: string;
  if (isError(err)) {
    const message = readDataProperty(err, "message");
    if (typeof message === "string" && message) {
      formatted = message;
    } else {
      const name = readDataProperty(err, "name");
      formatted = typeof name === "string" && name ? name : "Error";
    }
    // Traverse .cause chain to include nested error messages (e.g. grammY HttpError wraps network errors in .cause)
    let cause: unknown = readDataProperty(err, "cause");
    const seen = new Set<unknown>([err]);
    // Skip causes that repeat a message already emitted (e.g. coerceToFailoverError).
    const seenMessages = new Set<string>([formatted]);
    const appendCauseMessage = (causeMessage: string): void => {
      if (!causeMessage || seenMessages.has(causeMessage)) {
        return;
      }
      formatted += ` | ${causeMessage}`;
      seenMessages.add(causeMessage);
    };
    while (cause && !seen.has(cause)) {
      seen.add(cause);
      if (isError(cause)) {
        const causeMessage = readDataProperty(cause, "message");
        if (typeof causeMessage === "string") {
          appendCauseMessage(causeMessage);
        }
        const code = extractErrorCode(cause);
        if (code) {
          appendCauseMessage(code);
        }
        cause = readDataProperty(cause, "cause");
      } else if (typeof cause === "string") {
        appendCauseMessage(cause);
        break;
      } else {
        break;
      }
    }
  } else {
    formatted = stringifyUnknownValue(err);
  }
  // Security: best-effort token redaction before returning/logging.
  return redactSensitiveText(formatted);
}

/**
 * Render a non-Error `cause` value (string, number, plain object, etc.) for inclusion in
 * a flattened error chain. Returns `[object Object]`-free text without throwing.
 */
export function stringifyNonErrorCause(value: unknown): string {
  return stringifyUnknownValue(value);
}

function copyErrorDataProperties(source: object, target: Error): void {
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(source);
  } catch {
    return;
  }

  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, key);
    } catch {
      continue;
    }
    if (!descriptor || !("value" in descriptor)) {
      continue;
    }
    if (
      (key === "message" || key === "name" || key === "stack") &&
      typeof descriptor.value !== "string"
    ) {
      continue;
    }
    try {
      Object.defineProperty(target, key, { ...descriptor, configurable: true });
    } catch {
      // Preserve the normalized Error even when a source property cannot be copied.
    }
  }
}

export function toErrorObject(value: unknown, fallbackMessage: string): Error {
  if (isError(value)) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if (isObjectLike(value)) {
    copyErrorDataProperties(value, error);
  }
  return error;
}

export type SerializableError = {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: SerializableError;
};

function serializeErrorValue(
  value: unknown,
  fallbackMessage: string,
  seen: Set<object>,
): SerializableError {
  const normalized = toErrorObject(value, fallbackMessage);
  if (isObjectLike(value)) {
    seen.add(value);
  }
  seen.add(normalized);

  const name = readDataProperty(normalized, "name");
  const message = readDataProperty(normalized, "message");
  const stack = readDataProperty(isError(value) ? normalized : value, "stack");
  const code = extractErrorCode(normalized);
  const cause = isError(value)
    ? readDataProperty(normalized, "cause")
    : isObjectLike(value)
      ? readDataProperty(value, "cause")
      : undefined;
  const serializedCause =
    cause !== undefined && (!isObjectLike(cause) || !seen.has(cause))
      ? serializeErrorValue(cause, describeUnknownValueWithoutAccessors(cause), seen)
      : undefined;

  return {
    name: typeof name === "string" && name ? name : "Error",
    message: typeof message === "string" && message ? message : fallbackMessage,
    ...(typeof stack === "string" ? { stack } : {}),
    ...(code ? { code } : {}),
    ...(serializedCause ? { cause: serializedCause } : {}),
  };
}

export function serializeError(
  value: unknown,
  fallbackMessage = "Unknown error",
): SerializableError {
  return serializeErrorValue(value, fallbackMessage, new Set());
}

export function formatUncaughtError(err: unknown): string {
  if (extractErrorCode(err) === "INVALID_CONFIG") {
    return formatErrorMessage(err);
  }
  if (isError(err)) {
    const stack = readDataProperty(err, "stack");
    if (typeof stack === "string" && stack) {
      return redactSensitiveText(stack);
    }
    const message = readDataProperty(err, "message");
    if (typeof message === "string" && message) {
      return redactSensitiveText(message);
    }
    const name = readDataProperty(err, "name");
    return redactSensitiveText(typeof name === "string" && name ? name : "Error");
  }
  return formatErrorMessage(err);
}

export type ErrorKind = "refusal" | "timeout" | "rate_limit" | "context_length" | "unknown";

export function detectErrorKind(err: unknown): ErrorKind | undefined {
  if (err === undefined) {
    return undefined;
  }
  const message = formatErrorMessage(err).toLowerCase();
  const code = extractErrorCode(err)?.toLowerCase();

  if (
    message.includes("refusal") ||
    message.includes("content_filter") ||
    message.includes("sensitive") ||
    message.includes("unhandled stop reason: refusal_policy")
  ) {
    return "refusal";
  }
  if (message.includes("timeout") || code === "etimedout" || code === "timeout") {
    return "timeout";
  }
  if (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("429") ||
    code === "429"
  ) {
    return "rate_limit";
  }
  if (
    message.includes("context length") ||
    message.includes("too many tokens") ||
    message.includes("token limit") ||
    message.includes("context_window")
  ) {
    return "context_length";
  }
  return undefined;
}
