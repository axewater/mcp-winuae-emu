import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {WinUAEConnection, parseGdbPort, DEFAULT_ATTACH_PORT} from '../dist/winuae-connection.js';

assert.equal(parseGdbPort(undefined), 'auto');
assert.equal(parseGdbPort(''), 'auto');
assert.equal(parseGdbPort('auto'), 'auto');
assert.equal(parseGdbPort('2345'), 2345);
assert(Number.isNaN(parseGdbPort('23x')));

const listen = () => new Promise(resolve => {
  const server = net.createServer(socket => socket.on('error', () => {}));
  server.listen({host:'127.0.0.1',port:0}, () => resolve(server));
});
const closedPort = async () => {
  const server = await listen();
  const {port} = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
};

const attach = new WinUAEConnection({winuaePath:'/nonexistent',configFile:'',gdbPort:'auto'});
await assert.rejects(attach.connectExisting(await closedPort()), /No GDB server is listening/);
await assert.rejects(attach.connectExisting(0), /Invalid GDB port/);

if (process.platform === 'win32') {
  console.log('Port parsing and attach errors passed; launch tests need a POSIX fake emulator');
  process.exit(0);
}

// A fake emulator that reports its GDB listener the way WinUAE does and
// answers the attach handshake, or reports that it could not listen.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winuae-ports-'));
const fake = (name, body) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n` +
    "const port = Number(process.argv.find(arg => arg.startsWith('gdb_port=')).slice(9));\n" +
    `require('fs').appendFileSync(${JSON.stringify(path.join(dir, name + '.ports'))}, port + '\\n');\n` + body);
  fs.chmodSync(file, 0o755);
  return file;
};
const stub = fake('stub', `
const sum = s => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) & 255;
require('net').createServer(socket => socket.on('data', data => {
  for (const [, packet] of data.toString().matchAll(/\\$([^#]*)#../g)) {
    const reply = packet.startsWith('qSupported') ? 'PacketSize=4000' : packet === '?' ? 'S05' : 'OK';
    socket.write('+$' + reply + '#' + sum(reply).toString(16).padStart(2, '0'));
  }
})).listen(port, '127.0.0.1', () => console.log('WinUAE GDB: listening on 127.0.0.1:' + port));
`);
const taken = fake('taken', "console.log('WinUAE GDB: cannot listen on 127.0.0.1:' + port); setInterval(() => {}, 1000);");
const configFile = path.join(dir, 'test.uae');
fs.writeFileSync(configFile, '');
const ports = name => fs.readFileSync(path.join(dir, name + '.ports'), 'utf8').trim().split('\n').map(Number);

let detachedPid = null;
try {
  // Concurrent sessions launch private emulators on distinct free ports.
  const first = new WinUAEConnection({winuaePath:stub,configFile,gdbPort:'auto'});
  const second = new WinUAEConnection({winuaePath:stub,configFile,gdbPort:'auto'});
  assert.match(await first.connectSmart(), /^Launched/);
  assert.match(await second.connectSmart(), /^Launched/);
  const [a, b] = [(await first.status()).port, (await second.status()).port];
  assert.notEqual(a, b);
  assert(a !== DEFAULT_ATTACH_PORT && b !== DEFAULT_ATTACH_PORT);
  assert.deepEqual(ports('stub'), [a, b]);

  // A fixed port in use is reported before spawning.
  const third = new WinUAEConnection({winuaePath:stub,configFile,gdbPort:a});
  await assert.rejects(third.connect(), /GDB port \d+ is already in use.*WINUAE_GDB_PORT/);
  await assert.rejects(third.connect(b), /GDB port \d+ is already in use.*Launch without a port/);
  assert.equal(ports('stub').length, 2);

  // Attach reaches an explicitly named emulator only.
  detachedPid = (await first.status()).pid;
  await first.detach();
  const attached = new WinUAEConnection({winuaePath:stub,configFile,gdbPort:'auto'});
  await attached.connectExisting(a);
  assert.equal((await attached.status()).owned, false);
  await attached.disconnect();
  await second.shutdown();

  // A port taken before the emulator binds it is retried with another port.
  const raced = new WinUAEConnection({winuaePath:taken,configFile,gdbPort:'auto'});
  await assert.rejects(raced.connect(), /was taken before WinUAE could listen/);
  assert.equal(new Set(ports('taken')).size, 3);
  const fixed = await closedPort();
  await assert.rejects(new WinUAEConnection({winuaePath:taken,configFile,gdbPort:fixed}).connect(), /was taken/);
  assert.equal(ports('taken').length, 4);
} finally {
  if (detachedPid) try { process.kill(detachedPid); } catch {}
  fs.rmSync(dir, {recursive:true,force:true});
}
console.log('GDB port selection, attach and launch races passed');
