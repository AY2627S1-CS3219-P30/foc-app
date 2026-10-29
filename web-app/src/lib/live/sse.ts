/** One Server-Sent Event: its name (`message` when the stream gave none) and its data. */
export type SseEvent = { event: string; data: string };

/**
 * Splits a `text/event-stream` into events as its chunks arrive, wherever a chunk ends (the WHATWG
 * format): a line ends in CRLF, LF or CR; a blank line ends an event; `event:` names it and each
 * `data:` line adds a line to its data; a line starting with `:` is a comment, such as a keep-alive.
 * Returns the function to feed each decoded chunk to.
 */
export function sseParser(onEvent: (event: SseEvent) => void): (chunk: string) => void {
  let pending = "";
  let endedOnCR = false;
  let name = "";
  let data: string[] = [];

  const line = (text: string) => {
    if (text === "") {
      if (data.length > 0) onEvent({ event: name || "message", data: data.join("\n") });
      name = "";
      data = [];
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? "" : text.slice(colon + 1).replace(/^ /, "");
    if (field === "event") name = value;
    else if (field === "data") data.push(value);
  };

  return (chunk) => {
    // A CR that ended the last chunk already ended its line: the LF of a split CRLF is not another.
    const text = endedOnCR && chunk.startsWith("\n") ? chunk.slice(1) : chunk;
    endedOnCR = text.endsWith("\r");
    const lines = (pending + text).split(/\r\n|\r|\n/);
    pending = lines.pop() ?? "";
    for (const each of lines) line(each);
  };
}
