import { join } from 'node:path';
import { readJSON, state, writeJSON } from './lib.mjs';

export const name = 'clawnest-dsh-web-activity';
export const inject = ['connection', 'webServer'];
const retention = 31 * 86400000;

export function webActivityPath(scope) {
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error('Invalid WebUI activity scope');
  return join(state, 'web-activity', scope + '.json');
}

export function hasWebActivity(scope, start, end) {
  return readJSON(webActivityPath(scope), []).some(([opened, observed]) =>
    Number.isSafeInteger(opened) && Number.isSafeInteger(observed) &&
    opened <= observed && opened < end && observed >= start);
}

// The native connection plugin runs this hook after Host, Origin and browser
// credential checks. The WebSocket gateway admits and releases its peer
// through the native connection service.
export function apply(ctx) {
  const scope = process.env.CLAWNEST_DSH_WEB_ACTIVITY_SCOPE;
  if (!scope) return;
  const path = webActivityPath(scope);
  let current;
  let active = 0;
  let heartbeat;
  const flush = () => {
    try {
      const now = Date.now();
      if (current === undefined || now < current) return;
      const history = readJSON(path, []).filter(([, end]) => end >= now - retention);
      const last = history.at(-1);
      if (last && last[1] >= current) last[1] = Math.max(last[1], now);
      else history.push([current, now]);
      writeJSON(path, history.slice(-16384));
    } catch {
      // Telemetry cannot interrupt authenticated WebUI traffic.
    }
  };
  const begin = () => {
    if (active++ === 0) {
      current = Date.now();
      flush();
      heartbeat = setInterval(flush, 5000);
      heartbeat.unref();
    }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (--active === 0) {
        clearInterval(heartbeat);
        flush();
        current = undefined;
      }
    };
  };
  ctx.on('connection/request', async (_request, _response, next) => {
    const end = begin();
    try {
      await next();
    } finally {
      end();
    }
  });

  ctx.effect(() => {
    const connection = ctx.connection;
    const admit = connection.admitConnection;
    const observedAdmit = function (request) {
      const admission = admit.call(this, request);
      if ('rejection' in admission || request.url?.split('?')[0] !== '/api/remote.mux') return admission;
      const end = begin();
      return {
        ...admission,
        release: () => {
          end();
          return admission.release();
        },
      };
    };
    connection.admitConnection = observedAdmit;
    return () => {
      if (connection.admitConnection === observedAdmit) connection.admitConnection = admit;
      clearInterval(heartbeat);
      flush();
    };
  }, 'Clawnest native WebUI activity observation');
}
