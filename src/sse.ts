export type SseDataHandler<T> = (value: T) => void;

/**
 * Consume a JSON-over-SSE response without assuming that network chunks line up
 * with SSE frames. It also accepts standard multi-line data fields.
 */
export async function consumeSseJson<T>(
  response: Response,
  onData: SseDataHandler<T>
): Promise<void> {
  if (!response.body) throw new Error("上游响应没有可读取的 body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const dispatch = (): void => {
    if (dataLines.length === 0) return;

    const payload = dataLines.join("\n").trim();
    dataLines = [];
    if (!payload || payload === "[DONE]") return;

    try {
      onData(JSON.parse(payload) as T);
    } catch {
      // Ignore malformed/non-JSON SSE frames and continue the stream.
    }
  };

  const consumeLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r")
      ? rawLine.slice(0, rawLine.length - 1)
      : rawLine;

    if (line === "") {
      dispatch();
      return;
    }

    if (line.startsWith(":")) return;
    if (!line.startsWith("data:")) return;

    let value = line.slice(5);
    if (value.startsWith(" ")) value = value.slice(1);
    dataLines.push(value);
  };

  const consumeText = (text: string): void => {
    buffer += text;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      consumeLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  };

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (result.value) {
      consumeText(decoder.decode(result.value, { stream: true }));
    }
  }

  consumeText(decoder.decode());
  if (buffer) consumeLine(buffer);
  dispatch();
}
