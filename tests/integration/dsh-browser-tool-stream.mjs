import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBrowserChat } from '../../platform/deepseek-harness/browser-chat.mjs';

// Run in the pinned DSH v0.1.11 image with --network none and this checkout mounted read-only.
test('DSH rc.5 streams text before and after a native tool call and replays the complete reply', { timeout: 30000 }, async t => {
  const dsh = '/opt/dsh/node_modules/@deepseek-ai';
  const sdkPackage = JSON.parse(await readFile(join(dsh, 'dsh-sdk-client/package.json'), 'utf8'));
  assert.equal(sdkPackage.version, '0.2.2-rc.5');
  const { DeepSeekHarness } = await import(dsh + '/dsh-sdk-client/lib/index.js');
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-tool-stream-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const agentsHome = join(scratch, '.agents');
  const skill = join(agentsHome, 'skills', 'stream-fixture');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: stream-fixture\ndescription: Stream fixture\n---\nNATIVE_TOOL_RESULT_72e5\n');

  const firstText = Promise.withResolvers();
  const modelDeadline = AbortSignal.timeout(20000);
  const modelCalls = [];
  const model = createServer(async (req, res) => {
    try {
      const body = JSON.parse(await new Response(req).text());
      assert.equal(body.stream, true);
      const result = body.messages.find(message => message.role === 'tool');
      modelCalls.push(result ? 'tool-result' : 'prompt');
      const frame = (delta, reason = null) => 'data: ' + JSON.stringify({
        id: 'test', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta, finish_reason: reason }],
      }) + '\n\n';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (result) {
        assert.match(JSON.stringify(result), /NATIVE_TOOL_RESULT_72e5/);
        res.write(frame({ role: 'assistant', content: 'Final answer.' }));
        res.end(frame({}, 'stop') + 'data: [DONE]\n\n');
        return;
      }
      const tool = body.tools.find(row => ['skill', 'load_skill'].includes(row.function.name)).function;
      const arg = 'name' in tool.parameters.properties ? 'name' : 'skill_name';
      res.write(frame({ role: 'assistant', content: 'Before tool. ' }));
      // Wait until the worker delivers the text before allowing the native tool call.
      await Promise.race([firstText.promise, once(modelDeadline, 'abort').then(() => modelDeadline.throwIfAborted())]);
      res.write(frame({ tool_calls: [{ index: 0, id: 'call_stream_fixture', type: 'function',
        function: { name: tool.name, arguments: JSON.stringify({ [arg]: 'stream-fixture' }) } }] }));
      res.end(frame({}, 'tool_calls') + 'data: [DONE]\n\n');
    } catch (error) {
      res.destroy(error);
    }
  }).listen(0, '127.0.0.1');
  t.after(() => { model.closeAllConnections(); model.close(); });
  await once(model, 'listening');

  const modelPatch = join(scratch, 'model.patch.yml');
  await writeFile(modelPatch, JSON.stringify([
    { id: 'llm-pi-ai', config: { providers: { fixture: { apiKeyEnv: 'FIXTURE_KEY', api: 'openai-completions',
      baseURL: 'http://127.0.0.1:' + model.address().port + '/v1',
      models: [{ id: 'fixture', name: 'Fixture', contextWindow: 32768, maxTokens: 4096, input: ['text'] }],
    } } } },
    { id: 'agent-default-model', config: { provider: 'fixture', model: 'fixture' } },
    { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: scratch } },
    { id: 'approval', config: { policy: 'never' } },
  ]));
  const streamPatch = join(scratch, 'stream.patch.yml');
  const nativeStream = fileURLToPath(new URL('../../platform/deepseek-harness/browser-assistant-stream.mjs', import.meta.url));
  await writeFile(streamPatch, JSON.stringify([{ insert: [{ id: 'clawnest-browser-assistant-stream', name: nativeStream }] }]));
  const worker = createBrowserChat({
    receiptFile: join(scratch, 'receipt.json'), scratch,
    identity: () => ({ userId: 'agent', ownerId: 'owner' }), draining: () => false,
    open: (home, stream) => new DeepSeekHarness({
      dshBin: join(dsh, 'dsh/lib/bin.js'), profile: 'sdk', dshHome: home, cwd: scratch, processCwd: scratch,
      patches: stream ? [modelPatch, streamPatch] : [modelPatch], provider: 'fixture', model: 'fixture',
      env: { ...process.env, FIXTURE_KEY: 'fixture', DSH_AGENTS_HOME: agentsHome, DSH_PERMISSION_MODE: 'danger-full-access' },
      initializeTimeoutMs: 12000, shutdownTimeoutMs: 500, disposeEofGraceMs: 500, disposeGraceMs: 2000,
    }),
  });
  const server = createServer(worker.invoke).listen(0, '127.0.0.1');
  t.after(() => { worker.abort(); server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const send = stream => fetch('http://127.0.0.1:' + server.address().port + '/integration/browser-' + (stream ? 'stream' : 'invoke'), {
    method: 'POST', signal: modelDeadline, body: JSON.stringify({
      method: 'chat.send', context: { instance_id: 'fixture' }, deadline_unix_ms: Date.now() + 19000,
      params: { session_id: 'tool-turn', client_message_id: 'fixture', messages: [{ role: 'user', content: 'Use the fixture skill' }], stream },
    }),
  });
  const response = await send(true);
  assert.equal(response.status, 200);
  let raw = '';
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    raw += chunk;
    if (raw.includes('"text":"Before tool. "')) firstText.resolve();
  }
  const events = [...raw.matchAll(/^event: (.+)$/gm)].map(row => row[1]);
  const payloads = [...raw.matchAll(/^data: (.+)$/gm)].map(row => JSON.parse(row[1]));
  assert.deepEqual(modelCalls, ['prompt', 'tool-result']);
  assert.deepEqual(events, ['start', 'delta', 'delta', 'done']);
  assert.equal(payloads.at(-1).finish_reason, 'completed');
  const complete = 'Before tool. Final answer.';
  assert.equal(payloads.map(payload => payload.text ?? '').join(''), complete);
  const replay = await (await send(false)).json();
  assert.equal(replay.result.message.content, complete);
  assert.deepEqual(modelCalls, ['prompt', 'tool-result']);
  t.diagnostic(JSON.stringify({ sdk: sdkPackage.version, events, modelCalls, replay: replay.result.message.content }));
});
