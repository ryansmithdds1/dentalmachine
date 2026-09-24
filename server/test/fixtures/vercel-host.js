// Serves api/index.js the way Vercel does: one Node function handed every /api request, booted lazily on
// the first one. Used by prodboot.test.js to start the real serverless entry with a Vercel-like environment.
// Prints "listening <port>" once the HTTP server is up (the app itself boots on the first request).
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = join(dirname(fileURLToPath(import.meta.url)), '../../../api/index.js');
const { default: handler } = await import(pathToFileURL(entry).href);

const server = createServer((req, res) => {
  handler(req, res).catch((err) => {
    // Vercel answers an unhandled error with a 500; so do we, and say why on stderr for the test.
    console.error('Function crashed:', err);
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  });
});
server.listen(0, '127.0.0.1', () => console.log(`listening ${server.address().port}`));
