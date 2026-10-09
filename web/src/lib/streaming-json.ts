/**
 * Partial-JSON reading for streamed tool arguments.
 *
 * Tool arguments arrive as JSON text, one fragment at a time, so for most of a
 * call the buffer is not valid JSON yet. Closing whatever is still open turns
 * `{"command": "npm te` into something readable — which is what lets a tool row
 * and a live group header show the argument *while* it is being written, the
 * way dsh's `ArgsView.textPrefix` does on the other side of the wall.
 *
 * Anything that cannot be salvaged returns `undefined` rather than `{}`, so a
 * caller keeps its last good value instead of blanking a row mid-word.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParse(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Close the string and brackets left open at the end of a JSON prefix.
 *
 * Iterating by code point matters only for the escaped-character state: the
 * bytes inside a string are never inspected, so a multi-byte character cannot
 * be mistaken for a `"` or a `\`.
 *
 * @param raw - a possibly truncated JSON text.
 * @returns valid JSON text, or `undefined` when the prefix is not salvageable.
 */
function closeOpenJson(raw: string): string | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const character of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      const open = stack.pop();
      const expected = character === "}" ? "{" : "[";
      if (open !== expected) return undefined;
    }
  }

  // A dangling escape would eat the quote we are about to add, so drop it.
  let closed = escaped ? raw.slice(0, -1) : raw;
  if (inString) closed += '"';
  closed = closed.replace(/\s+$/, "");
  const last = closed[closed.length - 1];
  if (last === ",") closed = closed.slice(0, -1);
  else if (last === ":") closed += "null";
  while (stack.length > 0) closed += stack.pop() === "{" ? "}" : "]";
  return closed;
}

/**
 * Read a tool call's arguments from as much of its JSON text as has arrived.
 * @param raw - the fragments accumulated so far.
 * @returns the parsed object, or `undefined` when nothing could be read yet.
 */
export function parseStreamingJson(raw: string): Record<string, unknown> | undefined {
  const direct = tryParse(raw);
  if (direct !== undefined) return direct;
  if (raw.trim().length === 0) return undefined;
  const repaired = closeOpenJson(raw);
  return repaired === undefined ? undefined : tryParse(repaired);
}
