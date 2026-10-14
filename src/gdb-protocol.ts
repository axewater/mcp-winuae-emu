/**
 * GDB Remote Serial Protocol (RSP) client for WinUAE
 * Handles packet framing, checksum, ack mode, and all m68k debug commands
 */

import { Socket } from 'net';

// m68k register layout in GDB order (18 regs × 4 bytes each, big-endian)
export interface M68kRegisters {
  D0: number; D1: number; D2: number; D3: number;
  D4: number; D5: number; D6: number; D7: number;
  A0: number; A1: number; A2: number; A3: number;
  A4: number; A5: number; A6: number; A7: number;
  SR: number; PC: number;
}

export type WatchpointType = 'write' | 'read' | 'access';

export const REGISTER_NAMES: (keyof M68kRegisters)[] = [
  'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7',
  'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7',
  'SR', 'PC',
];

const WATCHPOINT_TYPE_MAP: Record<WatchpointType, number> = {
  write: 2,
  read: 3,
  access: 4,
};

export class GdbProtocol {
  private socket: Socket | null = null;
  private receiveBuffer = '';
  private noAckMode = false;
  private packetResolvers: Array<{
    stop: boolean;
    resolve: (data: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private debugMode = process.env.WINUAE_DEBUG === '1';
  private pendingData = '';
  private _isRunning = false;
  private pendingStopReply: string | null = null;
  private stopWaiters = new Set<{
    resolve: (reply: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  get lastStopReply(): string | null { return this.pendingStopReply; }

  /** Observe execution without claiming a command reply or interrupting it. */
  waitForStop(timeoutMs = 30000): Promise<string> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
      return Promise.reject(new Error('Stop timeout must be 1-60000 ms'));
    if (!this.connected) return Promise.reject(new Error('Disconnected'));
    if (!this._isRunning) return Promise.resolve(this.pendingStopReply ?? 'S00');
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => {
        this.stopWaiters.delete(waiter);
        reject(new Error('Stop wait timed out; execution was not interrupted'));
      }, timeoutMs) };
      this.stopWaiters.add(waiter);
    });
  }

  /**
   * Connect to GDB server and perform handshake
   */
  async connect(host: string, port: number): Promise<void> {
    this.socket = new Socket();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('GDB connection timeout'));
      }, 5000);

      this.socket!.connect(port, host, () => {
        clearTimeout(timeout);
        resolve();
      });

      this.socket!.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    this.socket.on('data', (data) => this.handleData(data));
    this.socket.on('error', (err) => {
      this.debug(`[GDB] Socket error: ${err.message}`);
      this.rejectAll(new Error(`Socket error: ${err.message}`));
    });
    this.socket.on('close', () => {
      this.debug('[GDB] Socket closed');
      this.rejectAll(new Error('Socket closed'));
    });

    // Handshake: feature negotiation
    const supported = await this.sendCommand('qSupported:multiprocess+;swbreak+;hwbreak+');
    this.debug(`[GDB] qSupported response: ${supported}`);

    // Try to enable no-ack mode for speed
    try {
      const ackReply = await this.sendCommand('QStartNoAckMode');
      if (ackReply === 'OK') {
        this.noAckMode = true;
        this.debug('[GDB] No-ack mode enabled');
      }
    } catch {
      this.debug('[GDB] No-ack mode not supported, continuing with acks');
    }

    // Query halt reason
    const haltReason = await this.sendCommand('?');
    this.debug(`[GDB] Halt reason: ${haltReason}`);
  }

  /**
   * Handle incoming TCP data
   */
  private handleData(data: Buffer): void {
    this.pendingData += data.toString('binary');

    while (this.pendingData.length > 0) {
      // Handle ack/nack bytes
      if (this.pendingData[0] === '+') {
        this.pendingData = this.pendingData.slice(1);
        continue;
      }
      if (this.pendingData[0] === '-') {
        this.debug('[GDB] Received NACK');
        this.pendingData = this.pendingData.slice(1);
        continue;
      }

      // Look for packet start
      const dollarIdx = this.pendingData.indexOf('$');
      if (dollarIdx === -1) {
        // No packet start found, discard
        this.pendingData = '';
        break;
      }

      // Skip any bytes before $
      if (dollarIdx > 0) {
        this.pendingData = this.pendingData.slice(dollarIdx);
      }

      // Look for packet end (#XX)
      const hashIdx = this.pendingData.indexOf('#');
      if (hashIdx === -1 || hashIdx + 2 >= this.pendingData.length) {
        // Incomplete packet, wait for more data
        break;
      }

      // Extract packet
      const packetData = this.pendingData.slice(1, hashIdx); // between $ and #
      const checksumStr = this.pendingData.slice(hashIdx + 1, hashIdx + 3);
      this.pendingData = this.pendingData.slice(hashIdx + 3);

      // Verify checksum
      const expectedChecksum = parseInt(checksumStr, 16);
      const actualChecksum = this.computeChecksum(packetData);

      if (expectedChecksum !== actualChecksum) {
        this.debug(`[GDB] Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`);
        if (!this.noAckMode) {
          this.socketWrite('-');
        }
        continue;
      }

      // Send ack
      if (!this.noAckMode) {
        this.socketWrite('+');
      }

      this.debug(`[GDB] [RECV] ${packetData.slice(0, 100)}${packetData.length > 100 ? '...' : ''}`);

      // O packets are async console output from GDB server -- log and skip
      if (/^O(?:[0-9a-fA-F]{2})+$/.test(packetData)) {
        try {
          const hexText = packetData.slice(1);
          const text = Buffer.from(hexText, 'hex').toString('utf8').trim();
          this.debug(`[GDB] Server output: ${text}`);
        } catch {
          this.debug(`[GDB] Server output (raw): ${packetData.slice(1, 50)}`);
        }
        continue;
      }

      const isStop = /^(?:S[0-9a-fA-F]{2}$|T[0-9a-fA-F]{2})/.test(packetData);
      if (isStop) {
        this.pendingStopReply = packetData;
        this._isRunning = false;
        for (const waiter of this.stopWaiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(packetData);
        }
        this.stopWaiters.clear();
      }
      // A stop cannot consume a register/monitor reply. Observers never enter
      // this queue, so an ordinary reply cannot satisfy a stop wait either.
      const index = this.packetResolvers.findIndex(r => r.stop === isStop);
      const fallback = !isStop && /^E[0-9a-fA-F]{2}$/.test(packetData) ? 0 : -1;
      const selected = index >= 0 ? index : fallback;
      if (selected >= 0 && this.packetResolvers.length) {
        const [resolver] = this.packetResolvers.splice(selected, 1);
        clearTimeout(resolver.timer);
        if (resolver.stop && !isStop) resolver.reject(new Error(`Run command failed: ${packetData}`));
        else resolver.resolve(packetData);
      }
    }
  }

  /**
   * Compute GDB RSP checksum (sum of bytes mod 256)
   */
  private computeChecksum(data: string): number {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data.charCodeAt(i);
    }
    return sum & 0xFF;
  }

  /**
   * Send a raw packet with framing: $data#XX
   */
  private sendPacket(data: string): void {
    const checksum = this.computeChecksum(data);
    const packet = `$${data}#${checksum.toString(16).padStart(2, '0')}`;
    this.debug(`[GDB] [SEND] ${data.slice(0, 100)}${data.length > 100 ? '...' : ''}`);
    this.socketWrite(packet);
  }

  /**
   * Send a command and wait for response
   */
  private sendCommand(command: string, timeoutMs: number = 10000, stop = command === '?'): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.packetResolvers.findIndex(r => r.resolve === resolve);
        if (idx >= 0) {
          this.packetResolvers.splice(idx, 1);
        }
        reject(new Error(`GDB command timeout: ${command}`));
      }, timeoutMs);

      this.packetResolvers.push({ stop, resolve, reject, timer });
      this.sendPacket(command);
    });
  }

  /**
   * Send a command and wait for stop reply (for continue/step)
   * These commands get a stop reply (S/T packet) when execution stops
   */
  private sendRunCommand(command: string, timeoutMs: number = 30000): Promise<string> {
    return this.sendCommand(command, timeoutMs, true);
  }

  private socketWrite(data: string): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(data, 'binary');
    }
  }

  private debug(msg: string): void {
    if (this.debugMode) {
      console.error(msg);
    }
  }

  private rejectAll(error: Error): void {
    for (const resolver of this.packetResolvers) {
      clearTimeout(resolver.timer);
      resolver.reject(error);
    }
    this.packetResolvers = [];
    for (const waiter of this.stopWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.stopWaiters.clear();
  }

  // ─── Register Commands ──────────────────────────────────────────────

  /**
   * Read all registers: sends 'g', parses 18 × 8 hex chars (big-endian 32-bit)
   */
  async readRegisters(): Promise<M68kRegisters> {
    if (this._isRunning) await this.pause();
    const reply = await this.sendCommand('g');
    if (!/^[0-9a-fA-F]{144}$/.test(reply)) {
      throw new Error(`Invalid register reply: ${reply.length} chars (expected 144)`);
    }

    const regs: Partial<M68kRegisters> = {};
    for (let i = 0; i < 18; i++) {
      const hex = reply.slice(i * 8, i * 8 + 8);
      const value = parseInt(hex, 16); // big-endian
      (regs as any)[REGISTER_NAMES[i]] = value;
    }
    return regs as M68kRegisters;
  }

  /**
   * Read a single register by index
   */
  async readRegister(id: number): Promise<number> {
    if (this._isRunning) await this.pause();
    const reply = await this.sendCommand(`p${id.toString(16)}`);
    return parseInt(reply, 16);
  }

  /**
   * Write a single register by index: sends 'P<id>=<hex>'
   * Uses a longer timeout — WinUAE GDB server responds slowly to register writes.
   */
  async writeRegister(id: number, value: number): Promise<void> {
    if (this._isRunning) await this.pause();
    const hex = (value >>> 0).toString(16).padStart(8, '0');
    const reply = await this.sendCommand(`P${id.toString(16)}=${hex}`, 30000);
    if (reply !== 'OK') throw new Error(`Register write failed for reg ${id}: ${reply}`);
  }

  /**
   * Write all registers: sends 'G<hex>' (18 regs × 8 hex chars)
   */
  async writeRegisters(regs: M68kRegisters): Promise<void> {
    if (this._isRunning) await this.pause();
    let hex = '';
    for (const name of REGISTER_NAMES) {
      hex += ((regs[name] as number) >>> 0).toString(16).padStart(8, '0');
    }
    const reply = await this.sendCommand(`G${hex}`);
    if (reply !== 'OK') throw new Error(`Register write-all failed: ${reply}`);
  }

  // ─── Memory Commands ────────────────────────────────────────────────

  /**
   * Read memory: sends 'm<addr>,<len>', returns Buffer
   */
  async readMemory(addr: number, length: number): Promise<Buffer> {
    if (this._isRunning) await this.pause();
    if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(addr) || addr < 0 || addr + length > 0x100000000) {
      throw new Error('Invalid memory range');
    }
    if (length > 4096) {
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < length; offset += 4096) {
        chunks.push(await this.readMemory(addr + offset, Math.min(4096, length - offset)));
      }
      return Buffer.concat(chunks);
    }
    const reply = await this.sendCommand(`m${addr.toString(16)},${length.toString(16)}`);
    if (reply.startsWith('E')) {
      throw new Error(`Memory read error at $${addr.toString(16)}: ${reply}`);
    }
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(reply) || reply.length !== length * 2) throw new Error('Invalid memory reply');
    return Buffer.from(reply, 'hex');
  }

  /**
   * Write memory: sends 'M<addr>,<len>:<hex>'
   * Automatically chunks large writes to avoid GDB packet timeouts.
   * Each chunk uses a generous timeout since the WinUAE GDB server
   * processes writes slowly but reliably.
   */
  async writeMemory(addr: number, data: Buffer): Promise<void> {
    if (this._isRunning) await this.pause();
    const CHUNK_SIZE = 256; // bytes per GDB M command
    const WRITE_TIMEOUT = 30000; // 30s per chunk — WinUAE GDB is slow but works

    if (data.length <= CHUNK_SIZE) {
      const hex = data.toString('hex');
      const reply = await this.sendCommand(
        `M${addr.toString(16)},${data.length.toString(16)}:${hex}`,
        WRITE_TIMEOUT
      );
      if (reply !== 'OK') {
        throw new Error(`Memory write error at $${addr.toString(16)}: ${reply}`);
      }
      return;
    }

    // Chunked write for large payloads
    for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
      const chunk = data.subarray(offset, Math.min(offset + CHUNK_SIZE, data.length));
      const chunkAddr = addr + offset;
      const hex = chunk.toString('hex');
      const reply = await this.sendCommand(
        `M${chunkAddr.toString(16)},${chunk.length.toString(16)}:${hex}`,
        WRITE_TIMEOUT
      );
      if (reply !== 'OK') {
        throw new Error(`Memory write error at $${chunkAddr.toString(16)} (offset ${offset}): ${reply}`);
      }
    }
  }

  /**
   * Send a GDB monitor command (qRcmd). Used for custom WinUAE commands.
   * Returns the response text, or throws on error.
   */
  async sendMonitorCommand(cmd: string, live = false): Promise<string> {
    if (live && !/^(capabilities$|execution-status$|input )/.test(cmd)) throw new Error('Command is not safe during execution');
    if (!live && this._isRunning) await this.pause();
    const hexCmd = Buffer.from(cmd, 'utf8').toString('hex');
    const reply = await this.sendCommand(`qRcmd,${hexCmd}`, 30000);
    if (reply === 'OK') {
      if (/^(checkpoint restore |reset\b)/.test(cmd)) this.pendingStopReply = null;
      return 'OK';
    }
    if (reply.startsWith('E')) throw new Error(`Monitor command '${cmd}' failed: ${reply}`);
    if (!reply) throw new Error(`Unsupported monitor command: ${cmd}`);
    // Response may be hex-encoded output
    try {
      return Buffer.from(reply, 'hex').toString('utf8');
    } catch {
      return reply;
    }
  }

  // ─── Breakpoint Commands ────────────────────────────────────────────

  /**
   * Set software breakpoint: Z0,<addr>,2
   */
  async setBreakpoint(addr: number): Promise<void> {
    if (this._isRunning) await this.pause();
    const reply = await this.sendCommand(`Z0,${addr.toString(16)},2`);
    if (reply !== 'OK') {
      throw new Error(`Set breakpoint failed at $${addr.toString(16)}: ${reply}`);
    }
  }

  /**
   * Clear software breakpoint: z0,<addr>,2
   */
  async clearBreakpoint(addr: number): Promise<void> {
    if (this._isRunning) await this.pause();
    const reply = await this.sendCommand(`z0,${addr.toString(16)},2`);
    if (reply !== 'OK') {
      throw new Error(`Clear breakpoint failed at $${addr.toString(16)}: ${reply}`);
    }
  }

  // ─── Watchpoint Commands ────────────────────────────────────────────

  /**
   * Set watchpoint: Z<type>,<addr>,<len>
   */
  async setWatchpoint(addr: number, length: number, type: WatchpointType): Promise<void> {
    if (this._isRunning) await this.pause();
    const typeNum = WATCHPOINT_TYPE_MAP[type];
    const reply = await this.sendCommand(`Z${typeNum},${addr.toString(16)},${length.toString(16)}`);
    if (reply !== 'OK') {
      throw new Error(`Set watchpoint failed at $${addr.toString(16)}: ${reply}`);
    }
  }

  /**
   * Clear watchpoint: z<type>,<addr>,<len>
   */
  async clearWatchpoint(addr: number, length: number, type: WatchpointType): Promise<void> {
    if (this._isRunning) await this.pause();
    const typeNum = WATCHPOINT_TYPE_MAP[type];
    const reply = await this.sendCommand(`z${typeNum},${addr.toString(16)},${length.toString(16)}`);
    if (reply !== 'OK') {
      throw new Error(`Clear watchpoint failed at $${addr.toString(16)}: ${reply}`);
    }
  }

  // ─── Execution Control ──────────────────────────────────────────────

  /**
   * Continue execution: sends 'vCont;c', returns immediately (fire-and-forget).
   * The stop reply will arrive asynchronously when a breakpoint/watchpoint fires.
   * Use pause() to stop execution, or check isRunning to see if already stopped.
   * Uses the negotiated vCont execution interface.
   */
  async continue(): Promise<void> {
    if (this._isRunning) return;
    this.pendingStopReply = null;
    this._isRunning = true;
    this.sendPacket('vCont;c');
  }

  /**
   * Single step: sends 'vCont;s', waits for stop reply (step always stops quickly)
   * Uses the negotiated vCont execution interface.
   */
  async rangeStep(start: number, end: number): Promise<void> {
    if (![start, end].every(v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff) || start > end) {
      throw new Error('Range must contain ordered 32-bit addresses');
    }
    if (this._isRunning) await this.pause();
    const supported = await this.sendCommand('vCont?');
    if (!supported.split(';').includes('r')) throw new Error('Target does not support range stepping');
    this.pendingStopReply = null;
    this._isRunning = true;
    this.sendPacket(`vCont;r${start.toString(16)},${end.toString(16)}`);
  }

  async stepOver(): Promise<void> {
    if (this._isRunning) await this.pause();
    this.pendingStopReply = null;
    this._isRunning = true;
    try {
      const reply = await this.sendCommand(`qRcmd,${Buffer.from('step-over').toString('hex')}`);
      if (reply !== 'OK') throw new Error(`Step over failed: ${reply}`);
    } catch (e) { this._isRunning = false; throw e; }
  }

  async step(): Promise<string> {
    if (this._isRunning) await this.pause();
    this.pendingStopReply = null;
    this._isRunning = true;
    const reply = await this.sendRunCommand('vCont;s');
    this._isRunning = false;
    return reply;
  }

  /**
   * Pause/interrupt execution. If CPU already stopped (async breakpoint hit),
   * returns the pending stop reply immediately. Otherwise sends 0x03 interrupt.
   */
  async pause(): Promise<string> {
    if (!this.connected) throw new Error('Disconnected');
    if (!this._isRunning) return this.pendingStopReply ?? 'S00';
    const stopped = this.waitForStop(10000);
    this.socketWrite('\x03');
    return stopped;
  }

  /**
   * Whether the CPU is currently running (continue was sent, no stop reply yet)
   */
  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Disconnect from GDB server
   */
  async detach(): Promise<void> {
    try {
      const reply = await this.sendCommand('D');
      if (reply !== 'OK') throw new Error(`Detach failed: ${reply}`);
    } finally { this.disconnect(); }
  }

  disconnect(): void {
    this.rejectAll(new Error('Disconnected'));
    this._isRunning = false;
    this.pendingStopReply = null;
    this.pendingData = '';
    this.noAckMode = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }
}
