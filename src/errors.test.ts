import { describe, expect, test } from "vitest";

import { asError, errorMessage } from "./errors.js";

describe("error normalization", () => {
  test("preserves Error messages and serializes non-Error objects", () => {
    const error = new Error("network unavailable");

    expect(errorMessage(error)).toBe("network unavailable");
    expect(asError(error)).toBe(error);
    expect(errorMessage({ code: "EFAIL" })).toBe('{"code":"EFAIL"}');
    expect(asError({ code: "EFAIL" })).toEqual(new Error('{"code":"EFAIL"}'));
  });

  test("uses a stable message for non-serializable objects", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(errorMessage(circular)).toBe("non-Error object");
    expect(asError(circular)).toEqual(new Error("non-Error object"));
  });
});
