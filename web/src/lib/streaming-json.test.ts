import { describe, expect, it } from "vitest";
import { parseStreamingJson } from "./streaming-json.ts";

describe("parseStreamingJson", () => {
  it("reads text that is already complete JSON", () => {
    expect(parseStreamingJson('{"command":"npm test","description":"run tests"}')).toEqual({
      command: "npm test",
      description: "run tests",
    });
  });

  it("reads a value that is still being written", () => {
    // The buffer for most of a call looks like this: the closing quote has not
    // arrived yet.
    expect(parseStreamingJson('{"command":"npm te')).toEqual({ command: "npm te" });
    expect(parseStreamingJson('{"command":"npm test"')).toEqual({ command: "npm test" });
  });

  it("closes nested objects and arrays", () => {
    expect(parseStreamingJson('{"a":{"b":"c')).toEqual({ a: { b: "c" } });
    expect(parseStreamingJson('{"queries":["one","two')).toEqual({ queries: ["one", "two"] });
    expect(parseStreamingJson('{"a":[{"b":1')).toEqual({ a: [{ b: 1 }] });
  });

  it("makes a dangling separator or colon valid", () => {
    // A key with nothing after the colon yet: the value is not knowable, so it
    // reads as null rather than as a broken parse.
    expect(parseStreamingJson('{"a":1,"b":')).toEqual({ a: 1, b: null });
    expect(parseStreamingJson('{"a":1,')).toEqual({ a: 1 });
    expect(parseStreamingJson('{"a":1, ')).toEqual({ a: 1 });
  });

  it("drops a dangling escape instead of eating the quote it adds", () => {
    expect(parseStreamingJson('{"a":"x\\')).toEqual({ a: "x" });
    expect(parseStreamingJson('{"a":"say \\"hi\\')).toEqual({ a: 'say "hi' });
  });

  it("keeps multi-byte characters intact", () => {
    expect(parseStreamingJson('{"path":"~/文档/报')).toEqual({ path: "~/文档/报" });
    expect(parseStreamingJson('{"command":"echo 🎉')).toEqual({ command: "echo 🎉" });
  });

  it("returns nothing while there is nothing to read", () => {
    expect(parseStreamingJson("")).toBeUndefined();
    expect(parseStreamingJson("   ")).toBeUndefined();
  });

  it("returns nothing for a prefix it cannot salvage", () => {
    // Half a literal, and a bracket that closes the wrong thing.
    expect(parseStreamingJson('{"a":tru')).toBeUndefined();
    expect(parseStreamingJson('{"a":[1}')).toBeUndefined();
    expect(parseStreamingJson("not json at all")).toBeUndefined();
  });

  it("returns nothing for JSON that is not an object", () => {
    expect(parseStreamingJson("[1,2]")).toBeUndefined();
    expect(parseStreamingJson('"just a string"')).toBeUndefined();
    expect(parseStreamingJson("42")).toBeUndefined();
  });
});
