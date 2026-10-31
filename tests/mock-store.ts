import { createServer, type Server } from 'node:http';

type Secrets = Record<string, string>;

/** A fake Infisical that answers Universal Auth and the raw secrets call. */
export function mockStore(secrets: Secrets | (() => Secrets), refuse = false) {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(req.url!);
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (refuse) return reply(403, { message: 'refused' });
    if (req.url!.startsWith('/api/v1/auth/universal-auth/login')) return reply(200, { accessToken: 'synthetic-token', expiresIn: 3600, accessTokenMaxTTL: 3600, tokenType: 'Bearer' });
    if (req.headers.authorization !== 'Bearer synthetic-token') return reply(401, { message: 'unauthorized' });
    if (req.url!.startsWith('/api/v3/secrets/raw')) return reply(200, { secrets: Object.entries(typeof secrets === 'function' ? secrets() : secrets).map(([secretKey, secretValue]) => ({ secretKey, secretValue })), imports: [] });
    reply(404, { message: 'unexpected' });
  });
  const url = new Promise<string>(ready => server.listen(0, '127.0.0.1', () => ready(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
  return { calls, url, close: () => new Promise(done => (server as Server).close(done)) };
}
