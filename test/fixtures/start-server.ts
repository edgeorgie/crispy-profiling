// Starts a dev server through crispy, then waits to be interrupted (used by unit tests).
import { startWebServer } from '../../src/profiler/webserver.js';

const port = Number(process.argv[2]);
const command = `node -e "require('http').createServer((q,r)=>r.end('ok')).listen(${port})"`;
await startWebServer(
  { command, timeoutMs: 10_000, reuseExisting: false },
  `http://127.0.0.1:${port}`,
);
console.log('ready');
setInterval(() => {}, 1000);
