import { describe, expect, it } from "bun:test";
import { sseParser, type SseEvent } from "../src/lib/live/sse";

/** N1.4 (#331): the live-update stream, read as the browser receives it, in pieces. */
function parse(...chunks: string[]): SseEvent[] {
  const events: SseEvent[] = [];
  const feed = sseParser((event) => events.push(event));
  for (const chunk of chunks) feed(chunk);
  return events;
}

describe("the live-update stream's events", () => {
  it("reads each event once its blank line arrives", () => {
    expect(parse('event: ready\ndata: {}\n\nevent: errand\ndata: {"orderId":"a"}\n\n')).toEqual([
      { event: "ready", data: "{}" },
      { event: "errand", data: '{"orderId":"a"}' },
    ]);
    expect(parse("event: board\ndata: {}\n")).toEqual([]);
  });

  it("reads an event split across chunks anywhere, even one character at a time", () => {
    const text = 'event: errand\ndata: {"orderId":"a","version":7}\n\n';
    expect(parse(...text.split(""))).toEqual([{ event: "errand", data: '{"orderId":"a","version":7}' }]);
  });

  it("joins the lines of a multi-line data field with newlines", () => {
    expect(parse("data: one\ndata: two\n\n")).toEqual([{ event: "message", data: "one\ntwo" }]);
  });

  it("skips comments, such as the keep-alive", () => {
    expect(parse(": keep-alive\n\nevent: board\n: in between\ndata: {}\n\n")).toEqual([
      { event: "board", data: "{}" },
    ]);
  });

  it("reads CRLF and CR line ends, even a CRLF split between two chunks", () => {
    expect(parse("event: ready\r\ndata: {}\r\n\r\n", "event: board\rdata: {}\r\r")).toEqual([
      { event: "ready", data: "{}" },
      { event: "board", data: "{}" },
    ]);
    expect(parse("data: a\r", "\ndata: b\r", "\n\r", "\n")).toEqual([{ event: "message", data: "a\nb" }]);
  });

  it("takes the value after the colon, less one space, and ignores fields it does not know", () => {
    expect(parse("event:board\ndata:  two spaces\nid: 9\nretry: 10\n\n")).toEqual([
      { event: "board", data: " two spaces" },
    ]);
  });
});
