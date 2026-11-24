import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBrowserChat } from '../platform/deepseek-harness/browser-chat.mjs';

test('DSH sends root text before SDK completion and replays the settled reply', { timeout: 5000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-browser-test-'));
  const finish = Promise.withResolvers();
  let runs = 0;
  const sessionId = 'native-root';
  const worker = createBrowserChat({
    receiptFile: join(scratch, 'receipts.json'), scratch,
    identity: () => ({ userId: 'agent', ownerId: 'owner' }),
    draining: () => false,
    open: (_home, stream) => {
      assert.equal(stream, true);
      return {
        session: () => ({
          id: sessionId,
          async run(prompt, { onNotification }) {
            runs++;
            assert.equal(prompt, 'Conversation transcript (roles are context):\n[{"role":"user","content":"Hello"}]');
            const notify = params => onNotification({ method: 'clawnest.browser-assistant-stream', params });
            notify({ sessionId: 'child', text: 'excluded' });
            notify({ sessionId, text: 'one' });
            notify({ sessionId, text: ' two' });
            notify({ sessionId, discarded: false });
            await finish.promise;
            return { finishReason: 'stop', finalResponse: 'one two' };
          },
        }),
        async close() { finish.resolve(); },
      };
    },
  });
  const server = createServer(worker.invoke).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const send = async (method, params, stream = false) => fetch(
    'http://127.0.0.1:' + server.address().port + '/integration/browser-' + (stream ? 'stream' : 'invoke'),
    { method: 'POST', signal: AbortSignal.timeout(2500), body: JSON.stringify({
      method, params, context: { instance_id: 'fixture' }, deadline_unix_ms: Date.now() + 3000,
    }) },
  );
  const params = { session_id: 's', client_message_id: 'm', messages: [{ role: 'user', content: 'Hello' }] };
  try {
    const response = await send('chat.send', { ...params, stream: true }, true);
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let frames = '';
    while ((frames.match(/^event: delta$/gm) ?? []).length < 2) {
      const next = await reader.read();
      assert.equal(next.done, false);
      frames += Buffer.from(next.value).toString();
    }
    assert.doesNotMatch(frames, /event: done|excluded/);
    assert.match(frames, /"text":"one"[\s\S]*"text":" two"/);
    const status = await (await send('chat.status', params)).json();
    assert.equal(status.result.state, 'running');
    assert.equal(status.result.last_seq, 3);
    finish.resolve();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      frames += Buffer.from(next.value).toString();
    }
    assert.match(frames, /event: done[\s\S]*"finish_reason":"completed"/);
    const replay = await (await send('chat.send', { ...params, stream: false })).json();
    assert.equal(replay.result.message.content, 'one two');
    assert.equal(replay.result.turn_id, status.result.turn_id);
    assert.equal(runs, 1);
  } finally {
    finish.resolve();
    worker.abort();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
});
