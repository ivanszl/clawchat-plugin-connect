export const name = 'clawnest-browser-assistant-stream';
export const inject = ['agents'];
export const notification = 'clawnest.browser-assistant-stream';

// The SDK server exposes durable session events. Relay the native live hook
// over the same JSON-RPC pipe, so deltas precede the SDK's idle notification.
export function apply(ctx) {
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    let data;
    if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
      data = { text: frame.chunk.text };
    } else if (frame.type === 'end') {
      data = { discarded: frame.outcome.kind !== 'committed' || frame.outcome.eventType !== 'assistant/message' };
    } else {
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: notification,
      params: { sessionId: String(agent.session.id), ...data } }) + '\n');
  });
}
