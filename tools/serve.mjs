#!/usr/bin/env node
// Tiny local web server for testing the site (no dependencies).
//   npm start                       start on port 8765 (or the next free port)
//   node tools/serve.mjs --open     same, and open the browser
import http from 'node:http';
import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const PORT = Number(process.env.PORT) || 8765; // not 8080: Unity MCP uses that on this PC
const OPEN = process.argv.includes('--open');
const MAX_TRIES = 20;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.resolve(ROOT, '.' + p);
    if (!file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

// If the port is taken by another app, try the next one.
function listen(port, triesLeft) {
  const onListening = () => {
    server.off('error', onError);
    const url = `http://127.0.0.1:${port}`;
    console.log(`IT Support Toolkit running at  ${url}`);
    console.log('Press Ctrl+C to stop.');
    if (OPEN) openBrowser(url);
  };
  const onError = (err) => {
    server.off('listening', onListening); // don't announce this failed port later
    if (err.code === 'EADDRINUSE' && triesLeft > 1) listen(port + 1, triesLeft - 1);
    else {
      console.error(`Could not start the server: ${err.message}`);
      process.exit(1);
    }
  };
  server.once('listening', onListening);
  server.once('error', onError);
  server.listen(port, '127.0.0.1');
}

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, (err) => err && console.log(`Open ${url} in your browser.`));
}

listen(PORT, MAX_TRIES);
