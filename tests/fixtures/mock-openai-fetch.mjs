// Mock SSE fetch helper for AI provider tests.
//
// Returns a fetch impl that responds to POST /chat/completions with OpenAI-
// compatible SSE frames. The mock observes the fetch AbortSignal (init.signal)
// and closes/errors the stream on abort so cancel + per-call timeout tests
// finish promptly — an open-ended stream that ignores the signal would hang.
// Supports scripted delays, HTTP error responses, and an onRequest hook.

/** Build an OpenAI-compatible SSE frame for a content delta. */
function deltaFrame(content) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  }
}

function stopFrame() {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }
}

/**
 * @param {object} options
 * @param {string[]} [options.deltas] Content deltas to stream.
 * @param {number} [options.delayMs] Delay between frames (0 = immediate).
 * @param {number} [options.status] HTTP status; non-2xx returns an error body.
 * @param {string} [options.errorBody] Body for error responses.
 * @param {(url: string, body: any) => void} [options.onRequest]
 * @param {boolean} [options.neverEnd] Stream stays open until aborted (for
 *   abort/timeout tests). The fetch AbortSignal still closes it.
 */
export function mockFetch(options = {}) {
  const {
    deltas = ['Hello', ' world'],
    delayMs = 0,
    status = 200,
    errorBody = 'upstream error',
    onRequest,
    neverEnd = false,
  } = options
  return async (url, init) => {
    if (typeof onRequest === 'function') {
      try { onRequest(String(url), JSON.parse(init?.body ?? '{}')) } catch { /* ignore */ }
    }
    if (status < 200 || status >= 300) {
      return new Response(errorBody, { status, headers: { 'content-type': 'application/json' } })
    }
    const encoder = new TextEncoder()
    const signal = init?.signal
    const stream = new ReadableStream({
      async start(controller) {
        // If the fetch was already aborted before streaming started, error out
        // immediately so the consumer sees an abort, not a hang.
        if (signal?.aborted) {
          controller.error(signal.reason ?? new Error('aborted'))
          return
        }
        let closed = false
        const safeClose = () => {
          if (closed) return
          closed = true
          try { controller.close() } catch { /* already closed */ }
        }
        const safeError = (reason) => {
          if (closed) return
          closed = true
          try { controller.error(reason ?? new Error('aborted')) } catch { /* already closed */ }
        }
        // The listener MUST stay attached until the stream actually closes or
        // errors — for neverEnd, start() returns while the stream is still
        // open, so removing the listener in a finally would leave an abort
        // with no way to unblock the consumer (hang).
        const onAbort = () => safeError(signal.reason ?? new Error('aborted'))
        if (signal) signal.addEventListener('abort', onAbort, { once: true })
        try {
          for (const d of deltas) {
            if (signal?.aborted || closed) return
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(deltaFrame(d))}\n\n`))
            if (delayMs > 0) {
              await new Promise((r) => {
                const t = setTimeout(r, delayMs)
                if (signal) {
                  signal.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true })
                }
              })
            }
            if (signal?.aborted || closed) return
          }
          if (!neverEnd) {
            if (closed) return
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(stopFrame())}\n\n`))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            safeClose()
          }
          // For neverEnd without abort, the controller stays open. The onAbort
          // listener (still attached) errors the stream when the fetch
          // AbortSignal fires — that is the only exit path.
        } finally {
          // Only release the listener once the stream is done; if neverEnd
          // left it open, the listener must remain so abort can fire.
          if (closed && signal) signal.removeEventListener('abort', onAbort)
        }
      },
      cancel() {
        // Consumer cancelled the stream directly; let onAbort/closed handle it.
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
}

/** A profile usable by the provider registry in tests. */
export const TEST_PROFILE = {
  id: 'prof_test',
  providerId: 'openai-compatible',
  displayName: 'Test',
  model: 'gpt-4o-mini',
  baseUrl: 'http://mock/v1',
  credentialKey: 'cred_test',
  capabilities: { vision: false, toolCalling: false, jsonSchema: false, reasoning: false },
  createdAt: 0,
  updatedAt: 0,
}
