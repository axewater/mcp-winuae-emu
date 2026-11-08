/** WinUAE process ownership and cross-platform GDB connection management. */

import { spawn, ChildProcess } from 'child_process';
import { GdbProtocol } from './gdb-protocol.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'node:net';

export interface WinUAEConfig {
  winuaePath: string;
  configFile: string;
  /** 'auto' launches each emulator on a free port; a number names one shared port. */
  gdbPort: number | 'auto';
}

/** Port attach uses when no fixed port is configured; launches never pick it. */
export const DEFAULT_ATTACH_PORT = 2345;

/** Parse WINUAE_GDB_PORT; invalid values are reported when a port is used. */
export function parseGdbPort(value: string | undefined): number | 'auto' {
  if (!value || value === 'auto') return 'auto';
  return /^\d+$/.test(value) ? Number(value) : NaN;
}

function checkPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid GDB port ${port}; use 1-65535`);
  return port;
}

/** Check without connecting: a connection would interrupt another emulator's GDB session. */
function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({host:'127.0.0.1',port,exclusive:true}, () => probe.close(() => resolve(true)));
  });
}

/** Ask the OS for an unused loopback port. Ephemeral ports never include the default attach port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({host:'127.0.0.1',port:0,exclusive:true}, () => {
      const {port} = server.address() as net.AddressInfo;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

/** WinUAE could not listen because another process bound the port first. */
class PortTakenError extends Error {}

export class WinUAEConnection {
  private config: WinUAEConfig;
  private process: ChildProcess | null = null;
  private protocol: GdbProtocol | null = null;
  private isConnected = false;
  private logFilePath: string | null = null;
  private port: number | null = null;
  private requestedPort: number | undefined;
  private floppies: Map<number, string> = new Map();

  constructor(config: WinUAEConfig) {
    this.config = config;
  }

  /**
   * Launch WinUAE without modifying the user configuration. Without a fixed
   * port, each launch gets a free port so concurrent MCP sessions never share
   * an emulator.
   */
  async connect(requestedPort?: number): Promise<void> {
    if (this.connected || this.process) {
      throw new Error('Launch requires no connection or owned emulator');
    }

    this.dropConnection();

    // WINUAE_PATH accepts an executable, an application bundle, or a directory.
    const configuredPath = path.resolve(this.config.winuaePath);
    const candidates = [configuredPath,
      path.join(configuredPath, process.platform === 'win32' ? 'winuae.exe' : 'winuae'),
      path.join(configuredPath, 'winuae64.exe'),
      path.join(configuredPath, 'Contents', 'MacOS', 'WinUAE'),
      path.join(configuredPath, 'WinUAE.app', 'Contents', 'MacOS', 'WinUAE')];
    const exePath = candidates.find(candidate => {
      try { return fs.statSync(candidate).isFile(); } catch { return false; }
    });
    if (!exePath) throw new Error(`WinUAE executable not found at ${configuredPath}`);
    if (!this.config.configFile || !fs.existsSync(this.config.configFile)) {
      throw new Error('Set WINUAE_CONFIG to an existing .uae configuration');
    }

    const fixedPort = requestedPort ?? (this.config.gdbPort === 'auto' ? undefined : this.config.gdbPort);
    if (fixedPort !== undefined) {
      checkPort(fixedPort);
      // A bind failure must not launch a second child.
      if (!await portFree(fixedPort)) {
        throw new Error(`GDB port ${fixedPort} is already in use, possibly by another MCP session's emulator. ` +
          (requestedPort === undefined ? 'Unset WINUAE_GDB_PORT (or set it to auto) so each launch uses a free port. '
            : 'Launch without a port to use a free one. ') +
          'Use winuae_attach only when the user asks to inspect an emulator that is already running.');
      }
    }

    // Another process can bind a free port before WinUAE does; pick again.
    for (let attempt = 0; ; attempt++) {
      const port = fixedPort ?? await freePort();
      try {
        await this.launch(exePath, port);
        this.port = port;
        this.requestedPort = requestedPort;
        return;
      } catch (error) {
        if (!(error instanceof PortTakenError) || fixedPort !== undefined || attempt >= 2) throw error;
        console.error(`[WinUAE] ${error.message}; retrying with another port`);
      }
    }
  }

  private async launch(exePath: string, port: number): Promise<void> {
    // Create log file
    const logDir = path.join(os.tmpdir(), 'winuae-mcp');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    pruneLogs(logDir);
    this.logFilePath = path.join(logDir, `winuae-${Date.now()}.log`);
    const logFd = fs.openSync(this.logFilePath, 'w');
    let logOpen = true;
    const closeLog = () => {
      if (logOpen) { logOpen = false; fs.closeSync(logFd); }
    };

    const args = [
      '-f', path.resolve(this.config.configFile),
      '-s', 'use_gui=no',
      '-s', 'debugging_features=gdbserver',
      '-s', `gdb_port=${port}`,
      // WinUAE does not start the GDB server with the threaded CPU.
      '-s', 'cpu_threaded=false',
    ];

    if (process.platform === 'win32') {
      for (const key of ['active_not_captured_pause', 'inactive_pause', 'iconified_pause']) {
        args.push('-s', `win32.${key}=no`);
      }
    }

    // Inject floppy disk settings as CLI overrides
    for (const [drive, diskPath] of this.floppies) {
      args.push('-s', `floppy${drive}=${diskPath}`);
    }

    console.error(`[WinUAE] Launching ${exePath} ${args.join(' ')}`);
    console.error(`[WinUAE] GDB port: ${port}`);
    console.error(`[WinUAE] Log file: ${this.logFilePath}`);

    this.process = spawn(exePath, args, {
      stdio: ['ignore', logFd, logFd],
      detached: false,
      cwd: path.dirname(exePath),
    });

    // The child inherited the descriptors; the parent must not retain one
    // for every emulator whose lifetime is handed back by detach.
    closeLog();

    this.process.on('error', (err) => {
      console.error('[WinUAE] Process error:', err);
      try { closeLog(); } catch {}
    });

    const child = this.process;
    this.process.on('exit', (code) => {
      console.error(`[WinUAE] Process exited with code ${code}`);
      try { closeLog(); } catch {}
      if (this.process === child) { this.process = null; void this.cleanup(); }
    });

    // Wait for GDB server to become available
    try {
      await this.waitForGdb(child, port);
    } catch (err) {
      // Close log fd and clean up if GDB connection fails after launch
      try { closeLog(); } catch {}
      await this.cleanup();
      throw err;
    }
  }

  /**
   * Attach to an emulator the user started (no process spawn). Without a
   * port, use the fixed WINUAE_GDB_PORT or the conventional default.
   */
  async connectExisting(requestedPort?: number): Promise<void> {
    if (this.connected) {
      throw new Error('Already connected to WinUAE');
    }
    if (this.process) throw new Error('Attach requires no owned emulator; shut it down first');

    const port = checkPort(requestedPort ?? (this.config.gdbPort === 'auto' ? DEFAULT_ATTACH_PORT : this.config.gdbPort));
    console.error(`[WinUAE] Attaching to existing instance on port ${port}`);
    this.dropConnection();
    const protocol = new GdbProtocol();
    try {
      await protocol.connect('127.0.0.1', port);
    } catch (error) {
      protocol.disconnect();
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        throw new Error(`No GDB server is listening on 127.0.0.1:${port}; attach never launches an emulator. ` +
          `Start WinUAE with debugging_features=gdbserver and gdb_port=${port}, or pass the port it uses.`);
      }
      // WinUAE accepts one client; later connections wait unanswered in the backlog.
      if (error instanceof Error && error.message.startsWith('GDB command timeout')) {
        throw new Error(`The GDB server on port ${port} accepted the connection but did not answer. ` +
          'Another debugger client, possibly another MCP session, is probably attached; WinUAE serves one client at a time. ' +
          'Ask the user before disconnecting it.');
      }
      throw error;
    }
    this.protocol = protocol;
    this.isConnected = true;
    this.port = port;
  }

  /**
   * Connect for a session. By default, launch a private emulator on a free
   * port and never attach to another session's emulator. A fixed port names
   * one shared emulator: attach when it is in use, launch otherwise.
   */
  async connectSmart(): Promise<string> {
    if (this.isConnected && !this.protocol?.connected) this.dropConnection();
    if (this.connected) {
      throw new Error('Already connected to WinUAE');
    }
    if (this.process) throw new Error('Owned emulator is not responding; use shutdown before launching again');

    if (this.config.gdbPort !== 'auto' && !await portFree(checkPort(this.config.gdbPort))) {
      await this.connectExisting();
      return `Connected to existing WinUAE GDB server on port ${this.port}`;
    }

    await this.connect();
    return `Launched WinUAE and connected to GDB server on port ${this.port}`;
  }

  /**
   * Wait for the launched emulator's GDB server. WinUAE logs whether it could
   * listen; connecting before that could reach another emulator that holds
   * the port. Builds that log elsewhere are polled after a grace period.
   */
  private async waitForGdb(child: ChildProcess, port: number): Promise<void> {
    const maxAttempts = 30;
    const delayMs = 500;
    const silentAttempts = 10;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`WinUAE exited (${child.exitCode ?? child.signalCode}) before its GDB server started; see ${this.logFilePath}`);
      }
      let log = '';
      try { log = fs.readFileSync(this.logFilePath!, 'latin1'); } catch {}
      if (log.includes(`WinUAE GDB: cannot listen on 127.0.0.1:${port}`)) {
        await this.cleanup();
        throw new PortTakenError(`GDB port ${port} was taken before WinUAE could listen on it`);
      }
      if (log.includes(`WinUAE GDB: listening on 127.0.0.1:${port}`) || attempt >= silentAttempts) {
        try {
          this.protocol = new GdbProtocol();
          await this.protocol.connect('127.0.0.1', port);

          this.isConnected = true;
          console.error('[WinUAE] Connected to GDB server');
          return;
        } catch (err) {
          if (this.protocol) {
            this.protocol.disconnect();
            this.protocol = null;
          }
        }
      }

      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    throw new Error(`WinUAE GDB server on port ${port} did not start within ${maxAttempts * delayMs / 1000} seconds; see ${this.logFilePath}. ` +
      'On Windows, each new WinUAE beta build first shows a disclaimer dialog that must be dismissed by hand.');
  }

  /**
   * Restart WinUAE with updated configuration (preserves floppy state).
   */
  async restart(): Promise<string> {
    if (!this.process) {
      throw new Error('Restart requires an instance launched by this MCP server');
    }
    console.error('[WinUAE] Restarting with updated configuration...');
    await this.cleanup();
    await this.connect(this.requestedPort);
    return `Restarted WinUAE and connected to GDB server on port ${this.port}`;
  }

  /**
   * Disconnect and kill WinUAE
   */
  async disconnect(): Promise<void> {

    await this.cleanup();
    if (this.logFilePath) {
      console.error(`[WinUAE] Log file saved: ${this.logFilePath}`);
    }
    console.error('[WinUAE] Disconnected');
  }

  private dropConnection(): void {
    this.isConnected = false;
    this.port = null;
    this.protocol?.disconnect();
    this.protocol = null;
  }

  /** Detach hands process lifetime back to the user, including on MCP exit. */
  async detach(): Promise<void> {
    try { if (this.protocol?.connected) await this.protocol.detach(); }
    finally {
      this.dropConnection();
      this.process?.unref();
      this.process = null;
    }
  }

  async shutdown(): Promise<void> {
    if (!this.process) throw new Error('Shutdown requires an emulator launched and still owned by this MCP server');
    await this.cleanup();
  }

  async status() {
    const session = { connected:this.connected, owned:!!this.process, pid:this.process?.pid ?? null, port:this.connected ? this.port : null };
    if (!this.connected) return { ...session, responsive:false, execution:'disconnected' };
    try {
      const target = JSON.parse(await this.getProtocol().sendMonitorCommand('execution-status', true));
      return { ...session, responsive:true, target };
    } catch (error) {
      return { ...session, responsive:false, error:String(error) };
    }
  }

  private async cleanup(): Promise<void> {
    this.dropConnection();

    const child = this.process;
    this.process = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGINT');
      });
    }
  }

  /**
   * Get the GDB protocol handler
   */
  getProtocol(): GdbProtocol {
    if (!this.protocol || !this.isConnected) {
      throw new Error('Not connected to WinUAE');
    }
    return this.protocol;
  }

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.isConnected && !!this.protocol?.connected;
  }

  /**
   * Health check without interrupting execution
   */
  async healthCheck(): Promise<boolean> {
    if (!this.isConnected || !this.protocol) {
      return false;
    }
    try {
      await this.protocol.sendMonitorCommand('execution-status', true);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Set or clear a floppy disk image for a drive (0-3).
   * Takes effect on next connect() or restart().
   */
  setFloppy(drive: number, filePath: string | null): void {
    if (drive < 0 || drive > 3) throw new Error('Drive must be 0-3');
    if (filePath) {
      this.floppies.set(drive, filePath);
    } else {
      this.floppies.set(drive, ''); // Override disks present in the base configuration.
    }
  }

  getFloppies(): Map<number, string> {
    return new Map(this.floppies);
  }
}

/** Keep the most recent launch logs; each launch adds one. */
function pruneLogs(dir: string, keep = 10): void {
  try {
    const logs = fs.readdirSync(dir).filter(name => /^winuae-\d+\.log$/.test(name)).sort();
    for (const name of logs.slice(0, Math.max(0, logs.length - keep + 1))) fs.rmSync(path.join(dir, name), { force: true });
  } catch {}
}
