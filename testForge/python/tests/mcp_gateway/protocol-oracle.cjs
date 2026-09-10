// Test-only HTTP oracle: loads the original, unmodified gateway TypeScript.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const root = path.resolve(__dirname, '../../..');
const compiler = createRequire(path.join(root, 'package.json'))('typescript');
const cache = new Map();
function load(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = {exports: {}};
  cache.set(filename, module);
  const localRequire = createRequire(filename);
  const scopedRequire = specifier => {
    if (specifier === '@testforge/application') return {AGENT_REQUEST_CONTEXT: {actor: 'agent', source: 'mcp'}};
    if (specifier.startsWith('@testforge/contracts/')) return load(path.join(root, 'packages/contracts/src', specifier.split('/').at(-1) + '.ts'));
    if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier.replace(/\.js$/, '.ts')));
    return localRequire(specifier);
  };
  const code = compiler.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: compiler.ModuleKind.CommonJS, target: compiler.ScriptTarget.ES2022}}).outputText;
  new Function('require', 'module', 'exports', code)(scopedRequire, module, module.exports);
  return module.exports;
}
async function main() {
  const facade = new Proxy({}, {get: (_, name) => name === 'listTools' ? () => [] : () => ({value: 3})});
  const app = {authorizer: {isAllowed: () => true, authorize: () => {}}, devices: facade, wiring: facade, occupancy: facade, orchestration: facade};
  const {LocalMcpGateway} = load(path.join(root, 'packages/mcp-gateway/src/gateway.ts'));
  const gateway = new LocalMcpGateway(app, {ensureToken: async () => 'secret', set: async () => {}}, 0);
  await gateway.start();
  const initialize = {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'oracle', version: '1'}}};
  const headers = {authorization: 'Bearer secret', 'content-type': 'application/json', accept: 'application/json, text/event-stream'};
  const cases = [
    {name: 'accept', headers: {accept: 'application/json'}, body: initialize},
    {name: 'contentType', headers: {'content-type': 'text/plain'}, body: initialize},
    {name: 'invalidJsonrpc', body: {...initialize, jsonrpc: '1.0'}},
    {name: 'invalidId', body: {...initialize, id: null}},
    {name: 'extraEnvelopeField', body: {...initialize, extra: true}},
    {name: 'batch', body: [initialize]},
    {name: 'toolsList', session: true, body: {jsonrpc: '2.0', id: 2, method: 'tools/list'}},
    {name: 'ping', session: true, body: {jsonrpc: '2.0', id: 2, method: 'ping'}},
    {name: 'unknownMethod', session: true, body: {jsonrpc: '2.0', id: 2, method: 'unknown'}},
    {name: 'repeatInitialize', session: true, body: initialize},
    {name: 'protocolVersion', session: true, headers: {'mcp-protocol-version': 'wrong'}, body: {jsonrpc: '2.0', id: 2, method: 'ping'}},
    {name: 'getAccept', session: true, method: 'GET', headers: {accept: 'application/json'}},
    {name: 'batchRequests', session: true, body: [{jsonrpc: '2.0', id: 2, method: 'ping'}, {jsonrpc: '2.0', id: 3, method: 'unknown'}]},
    {name: 'batchNotifications', session: true, body: [{jsonrpc: '2.0', method: 'notifications/initialized'}]},
    {name: 'emptyBatch', session: true, body: []},
    {name: 'delete', session: true, method: 'DELETE'},
    {name: 'oldVersion', session: true, headers: {'mcp-protocol-version': '2024-10-07'}, body: {jsonrpc: '2.0', id: 2, method: 'ping'}},
  ];
  async function request(item, sessionId) {
    const response = await fetch(gateway.status().endpoint, {method: item.method ?? 'POST', headers: {...headers, ...(sessionId ? {'mcp-session-id': sessionId} : {}), ...item.headers}, ...(item.body === undefined ? {} : {body: JSON.stringify(item.body)})});
    const raw = await response.text();
    let body;
    if ((response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
      const messages = raw.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      body = messages.length > 1 ? messages : messages[0];
    }
    else body = raw ? JSON.parse(raw) : null;
    return {status: response.status, body, sessionId: response.headers.get('mcp-session-id')};
  }
  try {
    const results = [];
    for (const item of cases) {
      const opened = item.session ? await request({body: initialize}) : null;
      const response = await request(item, opened?.sessionId);
      if (item.name === 'toolsList') response.body.result.tools = response.body.result.tools.map(tool => tool.name);
      delete response.sessionId;
      results.push({...item, expected: response});
      if (opened) await request({method: 'DELETE'}, opened.sessionId);
    }
    fs.writeFileSync(path.join(__dirname, 'protocol-golden.json'), JSON.stringify(results, null, 2) + '\n');
  } finally { await gateway.stop(); }
}
main().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
