import { createParser } from "eventsource-parser";

export type SseDataHandler<T> = (value: T) => void;

export interface SseConsumeResult {
  eventCount: number;
  sawDone: boolean;
}

function errorMessage(value: Error | null): string {
  return value ? value.message : "unknown error";
}

/**
 * Consume a JSON-over-SSE response. The parser handles arbitrary network
 * chunk boundaries, CR/LF variants, comments, multi-line data fields and
 * bounded buffering for malformed upstream streams.
 */
export async function consumeSseJson<T>(
  response: Response,
  onData: SseDataHandler<T>
): Promise<SseConsumeResult> {
  if (!response.body) throw new Error("上游响应没有可读取的 body");

  let parserError: Error | null = null;
  let dataError: Error | null = null;
  let eventCount = 0;
  let sawDone = false;
  const parser = createParser({
    maxBufferSize: 8 * 1024 * 1024,
    onError: (error) => {
      parserError = error;
    },
    onEvent: (event) => {
      const payload = event.data.trim();
      if (!payload) return;
      if (payload === "[DONE]") {
        sawDone = true;
        return;
      }
      eventCount += 1;

      try {
        onData(JSON.parse(payload) as T);
      } catch (error) {
        dataError = error instanceof Error
          ? error
          : new Error(String(error));
      }
    }
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (result.value) parser.feed(decoder.decode(result.value, { stream: true }));
    if (dataError) throw new Error("上游 SSE JSON 无效: " + errorMessage(dataError));
    if (parserError) throw new Error("上游 SSE 格式无效: " + errorMessage(parserError));
  }

  const tail = decoder.decode();
  if (tail) parser.feed(tail);
  parser.reset({ consume: true });

  if (dataError) throw new Error("上游 SSE JSON 无效: " + errorMessage(dataError));
  if (parserError) throw new Error("上游 SSE 格式无效: " + errorMessage(parserError));

  return { eventCount, sawDone };
}
