export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  switch (typeof error) {
    case "string":
      return error;
    case "bigint":
    case "boolean":
    case "number":
    case "symbol":
      return String(error);
    case "undefined":
      return "undefined";
    case "function":
      return "non-Error function";
    case "object":
      try {
        return JSON.stringify(error) ?? "non-Error object";
      } catch {
        return "non-Error object";
      }
  }
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}
