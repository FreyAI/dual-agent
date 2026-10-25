/**
 * The proxies' own process (see registry.ts): starts proxies on request and
 * reports their log rows, usage and Remote Control responses to the extension,
 * which also decides cost-limit refusals. Exits when the extension goes away.
 */
import { startProxy } from './server';
import { ProxyHooks, ProxyKind, diagnoseCaches, proxyOptions, routeDeepSeekHelpers } from './registry';
import { onDiag } from '../diag/log';
import { errorMessage } from '../text';

type FromExtension =
  | { op: 'start'; id: number; upstream: string; kind: ProxyKind; intercept?: { key: string; cert: string } }
  | { op: 'config'; route: Parameters<typeof routeDeepSeekHelpers>[0]; cacheDiagnostics: boolean }
  | { op: 'refused'; id: number; why?: string };

const send = (m: object) => process.connected && process.send?.(m);
let seq = 0;
const refusals = new Map<number, (why: string | undefined) => void>();

const hooks: ProxyHooks = {
  usage: (u, intercept) => send({ op: 'usage', u, intercept }),
  response: (pathname, status) => send({ op: 'response', pathname, status }),
  refuse: (meta) =>
    new Promise((resolve) => {
      const id = ++seq;
      refusals.set(id, resolve);
      send({ op: 'refuse', id, meta });
    }),
};

onDiag(({ at: _at, machine: _machine, ...row }) => send({ op: 'diag', row }));

process.on('message', (m: FromExtension) => {
  switch (m.op) {
    case 'start':
      startProxy(proxyOptions(m.upstream, m.kind, m.intercept, hooks)).then(
        (h) => send({ op: 'started', id: m.id, url: h.url }),
        (err) => send({ op: 'started', id: m.id, error: errorMessage(err) }),
      );
      break;
    case 'config':
      routeDeepSeekHelpers(m.route);
      diagnoseCaches(m.cacheDiagnostics);
      break;
    case 'refused':
      refusals.get(m.id)?.(m.why);
      refusals.delete(m.id);
      break;
  }
});

process.on('disconnect', () => process.exit(0));
