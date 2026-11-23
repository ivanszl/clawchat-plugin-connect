import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readJSON, writeJSON } from './lib.mjs';

const methods = new Set(['chat.send', 'chat.stop', 'chat.status', 'usage.query']);
const terminal = new Set(['completed', 'cancelled', 'failed', 'interrupted']);
const receiptTtl = 24 * 60 * 60 * 1000;
const answerLimit = 512 * 1024;
const digest = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');

class ChatError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const invalid = message => new ChatError(400, 'INVALID_ARGUMENT', message);
const conflict = message => new ChatError(409, 'CONFLICT', message);
const id = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw invalid('Invalid browser chat identifier');
  }
  return value;
};

function transcript(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 100) {
    throw invalid('A browser transcript is required');
  }
  const normalized = messages.map(item => {
    if (!item || !['system', 'user', 'assistant'].includes(item.role)) {
      throw invalid('Unsupported browser chat role');
    }
    let content = item.content;
    if (Array.isArray(content) && content.every(part => part?.type === 'text' && typeof part.text === 'string')) {
      content = content.map(part => part.text).join('\n');
    }
    if (typeof content !== 'string') throw invalid('Only text browser messages are supported');
    return { role: item.role, content };
  });
  const final = normalized.at(-1);
  if (final.role !== 'user' || !final.content.trim() || Buffer.byteLength(JSON.stringify(normalized)) > 192 * 1024) {
    throw invalid('A bounded browser transcript ending in a text user message is required');
  }
  return normalized;
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function createBrowserChat({ receiptFile, identity, open, draining, usageEvidence, scratch = '/dev/shm' }) {
  const receipts = new Map(Object.entries(readJSON(receiptFile)));
  const active = new Map();
  const answers = new Map();
  function save() {
    writeJSON(receiptFile, Object.fromEntries(receipts));
  }
  for (const record of receipts.values()) {
    if (!terminal.has(record.state)) record.state = 'interrupted';
  }
  if (receipts.size) save();

  const metadata = ({ session_id, turn_id, state, last_seq }) => ({ session_id, turn_id, state, last_seq });
  const sameScope = (record, scope, session) => record.scope === scope && record.session_id === session;
  function lookup(params, scope) {
    const session = id(params.session_id);
    const turnId = params.turn_id == null ? null : id(params.turn_id);
    const clientId = params.client_message_id == null ? null : id(params.client_message_id);
    if (!turnId && !clientId) throw invalid('A browser turn identifier is required');
    const record = clientId
      ? receipts.get(digest([scope, session, clientId]))
      : [...receipts.values()].find(row => row.turn_id === turnId);
    if (!record || !sameScope(record, scope, session) || (turnId && turnId !== record.turn_id)) {
      throw new ChatError(404, 'NOT_FOUND', 'Browser chat turn was not found');
    }
    return record;
  }

  async function invoke(req, res) {
    let inv;
    let error;
    let frame;
    let turn;
    let tracked = false;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 224 * 1024) throw invalid('Browser request is too large');
        chunks.push(chunk);
      }
      try { inv = JSON.parse(Buffer.concat(chunks)); } catch { throw invalid('Invalid browser request'); }
      if (!inv || !methods.has(inv.method) || !Number.isSafeInteger(inv.deadline_unix_ms) ||
          !inv.context?.instance_id || !inv.params || typeof inv.params !== 'object' || Array.isArray(inv.params)) {
        throw invalid('Invalid browser request');
      }
      if (inv.deadline_unix_ms <= Date.now()) throw new ChatError(504, 'DEADLINE_EXCEEDED', 'Browser turn expired');
      const account = identity();
      if (!account?.userId || !account?.ownerId) throw new ChatError(503, 'NOT_READY', 'Browser chat needs a bound owner');
      const ownerScope = inv.context.owner_scope ?? '';
      if (typeof ownerScope !== 'string' || ownerScope.length > 256) throw invalid('Invalid browser chat owner scope');
      const scope = digest([inv.context.instance_id, account.userId, account.ownerId, ownerScope]);
      const params = inv.params;
      if (inv.method === 'usage.query') {
        const parse = value => typeof value === 'string' &&
          /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
        const start = parse(params.start);
        const end = parse(params.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 31 * 86400000) {
          throw invalid('Invalid usage window');
        }
        const observed = [...receipts.values()].some(row =>
          row.scope === scope && row.accepted_at >= start && row.accepted_at < end);
        const source = observed ? 'browser_chat' : usageEvidence?.(start, end, account, inv.context.instance_id);
        if (!source) throw new ChatError(503, 'NOT_READY', 'No full runtime usage observation is available');
        return json(res, 200, { result: { has_usage: true, source } });
      }
      if (inv.method !== 'chat.send') {
        if (inv.method === 'chat.stop' && params.turn_id == null) throw invalid('A browser turn ID is required');
        const record = lookup(params, scope);
        if (inv.method === 'chat.status') return json(res, 200, { result: metadata(record) });
        const running = active.get(record.turn_id);
        if (!running) {
          return json(res, 200, { result: { state: record.state === 'cancelled' ? 'cancelled' : 'already_finished' } });
        }
        record.state = 'cancel_requested';
        running.abort();
        save();
        return json(res, 200, { result: { state: 'cancel_requested' } });
      }
      const streaming = req.url === '/integration/browser-stream';
      if (params.stream != null && (typeof params.stream !== 'boolean' || params.stream !== streaming)) {
        throw invalid('Invalid browser stream mode');
      }
      if (params.selection_id != null) {
        throw new ChatError(501, 'UNSUPPORTED_CAPABILITY', 'DSH browser chat uses the configured model');
      }
      const messages = transcript(params.messages);
      const client = id(params.client_message_id ?? inv.idempotency_key ?? inv.id);
      const session = params.session_id == null ? 'browser-' + digest([scope, client]).slice(0, 32) : id(params.session_id);
      const key = digest([scope, session, client]);
      const now = Date.now();
      for (const [name, record] of receipts) {
        if (terminal.has(record.state) && now - record.updated > receiptTtl) receipts.delete(name);
      }
      for (const [name, entry] of answers) if (entry.expires <= now) answers.delete(name);
      turn = receipts.get(key);
      const hash = digest(messages);
      let result;
      let controller;
      if (turn) {
        if (turn.hash !== hash) throw conflict('Browser message ID was used for a different transcript');
        if (active.has(turn.turn_id)) throw conflict('Browser turn is still running');
        result = answers.get(key)?.result;
        if (!result) throw new ChatError(503, 'UNKNOWN_OUTCOME', 'Browser turn already ran; query its status');
      } else {
        if (draining()) throw new ChatError(503, 'DRAINING', 'DSH is draining');
        if (active.size >= 2 || [...active.values()].some(item => sameScope(item.turn, scope, session))) {
          throw conflict('Browser chat session or runtime is busy');
        }
        if (receipts.size >= 4096) throw conflict('Browser chat receipt limit reached');
        turn = { scope, session_id: session, turn_id: randomUUID(), state: 'accepted',
          last_seq: 0, hash, updated: now, accepted_at: now };
        receipts.set(key, turn);
        try { save(); } catch (cause) { receipts.delete(key); throw cause; }
        controller = new AbortController();
        active.set(turn.turn_id, { turn, abort: () => controller.abort() });
        tracked = true;
      }

      let seq = 0;
      if (streaming) res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no',
      });
      frame = (event, fields) => {
        seq++;
        if (tracked) turn.last_seq = seq;
        if (!streaming || res.destroyed) return;
        if (res.writableLength > answerLimit) {
          controller?.abort();
          res.destroy();
          return;
        }
        const data = { session_id: session, turn_id: turn.turn_id, seq, ...fields };
        res.write(`event: ${event}\nid: ${seq}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const deltas = text => {
        for (let offset = 0; offset < text.length;) {
          let end = Math.min(offset + 8192, text.length);
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end++;
          frame('delta', { text: text.slice(offset, end) });
          offset = end;
        }
      };
      if (result) {
        frame('start', { state: turn.state });
        deltas(result.message.content);
      } else {
        turn.state = 'running';
        let text = '';
        let outputBytes = 0;
        let overflow = false;
        let expired = false;
        let temp;
        let harness;
        let closePromise;
        const close = () => { if (harness) closePromise ??= harness.close(); return closePromise; };
        const cancel = () => { controller.abort(); };
        const deadline = setTimeout(() => { expired = true; cancel(); },
          Math.max(1, Math.min(900000, inv.deadline_unix_ms - Date.now())));
        const heartbeat = streaming ? setInterval(() => {
          if (res.writableLength <= answerLimit) res.write(': keepalive\n\n');
        }, 15000) : null;
        controller.signal.addEventListener('abort', () => { void close()?.catch(() => {}); }, { once: true });
        res.once('close', cancel);
        if (res.destroyed) cancel();
        const append = delta => {
          outputBytes += Buffer.byteLength(delta);
          if (outputBytes > answerLimit) { overflow = true; cancel(); return; }
          text += delta;
          deltas(delta);
        };
        try {
          frame('start', { state: turn.state });
          temp = await mkdtemp(join(scratch, 'clawnest-dsh-browser-'));
          if (!controller.signal.aborted) {
            harness = open(temp);
            const sessionHandle = harness.session();
            // Fixed prefix keeps native slash-command routing out of the browser transcript.
            const prompt = 'Conversation transcript (roles are context):\n' + JSON.stringify(messages);
            const answer = await sessionHandle.run(prompt, { onNotification(notification) {
              const event = notification.params?.event;
              if (!controller.signal.aborted && notification.method === 'session.event' &&
                  notification.params.sessionId === sessionHandle.id && event?.type === 'assistant/chunk' &&
                  event.data?.chunk?.type === 'text-delta' && typeof event.data.chunk.text === 'string') {
                append(event.data.chunk.text);
              }
            } });
            if (!controller.signal.aborted) {
              if (answer.finishReason === 'error' || answer.finishReason == null) throw new Error('Incomplete native turn');
              if (!text && typeof answer.finalResponse === 'string') append(answer.finalResponse);
            }
          }
        } catch (cause) {
          if (!controller.signal.aborted) throw cause;
        } finally {
          try { await close(); } finally {
            clearTimeout(deadline);
            clearInterval(heartbeat);
            res.off('close', cancel);
            if (temp) await rm(temp, { recursive: true, force: true });
          }
        }
        if (expired) throw new ChatError(504, 'DEADLINE_EXCEEDED', 'DSH browser turn expired');
        if (overflow) throw new ChatError(502, 'UPSTREAM_FAILURE', 'DSH browser response exceeded its output limit');
        const current = identity();
        if (current?.userId !== account.userId || current?.ownerId !== account.ownerId) {
          throw new ChatError(503, 'NOT_READY', 'DSH browser binding changed during the turn');
        }
        turn.state = controller.signal.aborted ? 'cancelled' : 'completed';
        result = { session_id: session, turn_id: turn.turn_id, message: { id: turn.turn_id, role: 'assistant', content: text },
          finish_reason: turn.state };
        turn.updated = Date.now();
        turn.last_seq = seq + 1;
        save();
        answers.set(key, { result, expires: Date.now() + 900000 });
        while (answers.size > 8) answers.delete(answers.keys().next().value);
      }
      if (streaming) {
        frame('done', { finish_reason: result.finish_reason });
        res.end();
      } else {
        json(res, 200, { result });
      }
    } catch (cause) {
      error = cause instanceof ChatError ? cause : new ChatError(502, 'UPSTREAM_FAILURE', 'DSH browser turn did not complete');
      if (tracked) {
        turn.state = 'failed';
        turn.updated = Date.now();
        turn.last_seq++;
        try { save(); } catch {
          error = new ChatError(503, 'UNKNOWN_OUTCOME', 'DSH browser chat receipt unavailable');
        }
      }
      const data = { code: error.code, message: error.message, retryable: error.code === 'NOT_READY' };
      if (res.destroyed) return;
      if (res.headersSent && frame) {
        frame('error', { error: data });
        res.end();
      } else {
        json(res, error.status, { error: data });
      }
    } finally {
      if (tracked) active.delete(turn.turn_id);
    }
  }

  return {
    invoke,
    get active() { return active.size; },
    abort() { for (const item of active.values()) item.abort(); },
  };
}
