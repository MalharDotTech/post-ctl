import { describe, expect, test } from "bun:test";
import { parseArgs, stringFlag } from "./args.ts";

describe("parseArgs", () => {
  test("positional and value flags", () => {
    const a = parseArgs(["post", "hello world", "--account", "isha", "--privacy", "private"]);
    expect(a.positional).toEqual(["post", "hello world"]);
    expect(a.flags["account"]).toBe("isha");
    expect(a.flags["privacy"]).toBe("private");
  });

  test("boolean flags don't consume next token", () => {
    const a = parseArgs(["post", "--dry-run", "title", "--debug"]);
    expect(a.flags["dry-run"]).toBe(true);
    expect(a.flags["debug"]).toBe(true);
    expect(a.positional).toEqual(["post", "title"]);
  });

  test("--flag=value form", () => {
    const a = parseArgs(["--output=json"]);
    expect(a.flags["output"]).toBe("json");
  });

  test("--media is repeatable and collected separately", () => {
    const a = parseArgs(["--media", "a.mp4", "--media", "b.mp4"]);
    expect(a.media).toEqual(["a.mp4", "b.mp4"]);
  });

  test("value flag at end of argv becomes boolean", () => {
    const a = parseArgs(["--account"]);
    expect(a.flags["account"]).toBe(true);
    expect(stringFlag(a.flags, "account")).toBeUndefined();
  });
});
