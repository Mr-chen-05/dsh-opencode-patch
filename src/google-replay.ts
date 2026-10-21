import { isRecord } from "./utils/guards.ts";

/** Translate only adapter-owned Google replay identity across a route redirect. */
export const googleReplayFor = (
  state: unknown,
  from: string,
  to: string
): unknown => {
  if (
    !isRecord(state) ||
    !isRecord(state.response) ||
    state.response.kind !== "pi-ai" ||
    state.response.api !== "google-generative-ai" ||
    state.response.provider !== from
  )
    return state;
  return { ...state, response: { ...state.response, provider: to } };
};

/** The agent stores the public provider; the native adapter needs its internal identity. */
export const googleHistoryFor = (
  messages: unknown,
  from: string,
  to: string
): unknown => {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message: unknown) => {
    if (
      !isRecord(message) ||
      message.role !== "assistant" ||
      !isRecord(message.source) ||
      message.source.provider !== from
    )
      return message;
    const replay = googleReplayFor(message.source.replayState, from, to);
    if (replay === message.source.replayState) return message;
    return {
      ...message,
      source: { ...message.source, provider: to, replayState: replay },
    };
  });
};

/**
 * Keep persisted replay consistent with the public provider recorded by the agent.
 * @yields {unknown} Stream chunks with public replay identity and no undefined fields added.
 */
export async function* googleReplayStream(
  stream: AsyncIterable<unknown>,
  from: string,
  to: string
): AsyncIterable<unknown> {
  for await (const chunk of stream) {
    if (isRecord(chunk) && chunk.type === "finish") {
      const replay = googleReplayFor(chunk.replayState, from, to);
      yield replay === chunk.replayState
        ? chunk
        : { ...chunk, replayState: replay };
    } else yield chunk;
  }
}
