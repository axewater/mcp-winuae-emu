# mcp-winuae-emu

An [MCP](https://modelcontextprotocol.io/) server that provides Amiga 68k
debugging tools through the [WinUAE](https://www.winuae.net/) emulator. It
connects to WinUAE's built-in GDB server via the GDB Remote Serial Protocol
(RSP), giving AI assistants direct read-write access to the emulated Amiga.

## What it does

This server lets an AI assistant (Claude, etc.) launch WinUAE, connect to its
GDB server, and then read and write memory and registers, set breakpoints and
watchpoints, step through code, inspect AmigaDOS processes and Exec tasks,
decode Copper lists and bitplanes, map symbols and DWARF debug information,
drive keyboard, mouse and joystick input, and save or restore checkpoints --
all through MCP tool calls.

## Quick Start

### 1. Get WinUAE with the GDB server

WinUAE has a built-in GDB server starting with WinUAE 6.1.0 (in beta at the
time of writing) on Windows, macOS and Linux. The extended tools need
matching monitor commands from WinUAE; they check the target's capabilities
and report a missing command instead of failing silently.

Set `WINUAE_PATH` to the executable, its directory, or a macOS `.app` bundle.

On Windows, each new WinUAE beta build shows a disclaimer dialog on its first
start. Start it once by hand and dismiss the dialog, otherwise the GDB server
does not start when the MCP server launches it.

### 2. Install the MCP server

```bash
git clone https://github.com/axewater/mcp-winuae-emu.git
cd mcp-winuae-emu
npm ci
npm run build
```

### 3. Add to Claude Code

```bash
claude mcp add winuae-emu \
  -e WINUAE_PATH=/path/to/winuae \
  -e WINUAE_CONFIG=/path/to/A500-Dev.uae \
  -- node /path/to/mcp-winuae-emu/dist/index.js
```

Or add it to a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "winuae-emu": {
      "command": "node",
      "args": ["C:/path/to/mcp-winuae-emu/dist/index.js"],
      "env": {
        "WINUAE_PATH": "C:/apps/winuae",
        "WINUAE_CONFIG": "C:/apps/winuae/Configurations/A500-Dev.uae"
      }
    }
  }
}
```

### 4. Provide a Kickstart ROM and config

You need a valid Amiga Kickstart ROM file (e.g., Kickstart 1.3 for A500) and a
WinUAE `.uae` config file. A minimal config:

```ini
cpu_model=68000
chipset=ocs
chipmem_size=1
kickstart_rom_file=C:\path\to\kickstart.rom
```

The server passes your configuration to WinUAE and enables GDB with
command-line overrides. It does not modify the configuration file.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `WINUAE_PATH` | `C:\apps\winuae` | Executable, executable directory, or macOS app bundle |
| `WINUAE_CONFIG` | `<WINUAE_PATH>\Configurations\A500-Dev.uae` | Path to your `.uae` config file |
| `WINUAE_GDB_PORT` | `2345` | GDB server TCP port |
| `WINUAE_DEBUG` | `0` | Set to `1` to enable GDB protocol debug logging |
| `WINUAE_PYTHON` | `.venv-dwarf` | Python with `pyelftools` for the DWARF tools |

The defaults follow the Windows layout. On macOS and Linux, and when
`WINUAE_PATH` names an executable or application bundle, set both
`WINUAE_PATH` and `WINUAE_CONFIG`.

## Tools

### Session

| Tool | Description |
|---|---|
| `winuae_connect` | Attach to a running WinUAE, or launch one and connect |
| `winuae_attach` | Attach to a running WinUAE only |
| `winuae_launch` | Launch an owned WinUAE and connect |
| `winuae_detach` | Release debugger state and leave the emulator running |
| `winuae_shutdown` | Stop an emulator launched by this server |
| `winuae_disconnect` | Disconnect; stop only an emulator launched by this server |
| `winuae_status` | Connection, ownership and execution state, without pausing |
| `winuae_capabilities` | Target commands, CPU/MMU models and address semantics |

### Memory

| Tool | Description |
|---|---|
| `winuae_memory_read` | Read memory bytes as hex |
| `winuae_memory_write` | Write hex bytes to memory |
| `winuae_memory_dump` | Hex + ASCII dump (like a hex editor) |
| `winuae_memory_search` | Search a bounded address range for bytes |
| `winuae_memory_map` | RAM, ROM and I/O regions from the emulator |
| `winuae_load` | Load a raw binary into memory, or boot a disk image |

### CPU and execution

| Tool | Description |
|---|---|
| `winuae_registers_get` | Read all m68k registers (D0-D7, A0-A7, SR, PC) |
| `winuae_registers_set` | Write registers (any subset of D0-D7, A0-A7, SR, PC) |
| `winuae_step` | Single-step N instructions |
| `winuae_step_over` | Run to the next sequential instruction |
| `winuae_range_step` | Step until the PC leaves an address range |
| `winuae_continue` | Resume execution |
| `winuae_pause` | Pause execution and read registers |
| `winuae_wait_stop` | Wait for a stop without interrupting execution |
| `winuae_reset` | Restart an owned emulator and read its registers |
| `winuae_history` | Read or control the debugger's PC history |

### Breakpoints and watchpoints

| Tool | Description |
|---|---|
| `winuae_breakpoint_set` | Set a breakpoint at an address |
| `winuae_breakpoint_clear` | Remove a breakpoint |
| `winuae_conditional_breakpoint` | Stop on register conditions |
| `winuae_watchpoint_set` | Break on CPU memory read/write/access |
| `winuae_watchpoint_clear` | Remove a watchpoint |
| `winuae_watch` | Exact-access watches with value matching and an access log |
| `winuae_dma_watchpoint` | Watch accesses by selected DMA sources |
| `winuae_exceptions` | Stop on selected CPU exceptions |
| `winuae_process_breakpoint` | Stop at the entry of an AmigaDOS program |

### AmigaDOS and Exec

| Tool | Description |
|---|---|
| `winuae_loaded_segments` | Loaded segment addresses of an AmigaDOS process |
| `winuae_tasks` | Exec task lists with stack information |

### Amiga hardware

| Tool | Description |
|---|---|
| `winuae_custom_registers` | Read and decode all custom chip registers ($DFF000-$DFF1FE) |
| `winuae_copper_disassemble` | Decode a Copper list (WAIT, MOVE, SKIP, END) |
| `winuae_disassemble` | Use WinUAE's m68k disassembler |
| `winuae_screenshot` | Save a PNG screenshot to a native host path |
| `winuae_bitmap` | Decode bitplanes in memory to a PNG image |
| `winuae_insert_disk` | Insert a floppy image and restart an owned emulator |
| `winuae_eject_disk` | Eject a floppy and restart an owned emulator |

### Diagnosis

| Tool | Description |
|---|---|
| `winuae_snapshot` | Registers, stop reason and selected memory in one call |
| `winuae_postmortem` | Bounded crash report with fault context |
| `winuae_guest_output` | Capture guest debug messages (uaelib function 86) |
| `winuae_checkpoint` | Save or restore a WinUAE state file |

### Executables and symbols

| Tool | Description |
|---|---|
| `winuae_hunk_inspect` | Validate and describe a Hunk executable |
| `winuae_hunk_load` | Relocate a Hunk executable into reserved RAM |
| `winuae_symbols` | List Hunk and ELF symbols |
| `winuae_symbol_read` | Read a symbol's value through explicit mappings |
| `winuae_source` | Source file and line for an address (DWARF) |
| `winuae_variable` | Read a C variable or expression (DWARF) |
| `winuae_backtrace` | Call stack from DWARF unwind information |

### Input

| Tool | Description |
|---|---|
| `winuae_input` | Send keyboard, mouse and joystick events |
| `winuae_input_sequence` | Send frame-timed input sequences |
| `winuae_key_tap` | Tap a key or chord |
| `winuae_type_text` | Type text with the US keymap |

## How it works

1. **Connect**: Try an existing server on `127.0.0.1` at the configured port
   (2345 by default).
2. **Launch**: If needed, launch WinUAE with `-f <config>`, `-s use_gui=no`,
   `-s debugging_features=gdbserver`, `-s gdb_port=<port>` and
   `-s cpu_threaded=false`, because WinUAE does not start its GDB server with
   the threaded CPU. Windows launch overrides also disable focus/minimize
   pause for the owned process. If WinUAE exits or the server does not start,
   the error names the launch log in the `winuae-mcp` temporary directory;
   the 10 most recent logs are kept.
3. **Debug**: Use GDB RSP for registers, memory, breakpoints and execution
   control, and GDB `monitor` commands for the WinUAE-specific tools.
   Guest-state operations pause execution first. Tool calls are serialized so
   their pause/read/write sequences do not overlap.
4. **Shutdown**: Disconnect stops only a process this server launched.
   Restart waits for that child to exit before launching its replacement.
   Closing the MCP input stream also cleans up the owned process.

### Technical notes

- Both `OK` replies and hexadecimal `O` console-output packets are handled.
- Large memory reads and writes are split into bounded requests.
- SR is written before A7 because changing CPU privilege mode switches stacks.
- Custom registers use the emulator's saved snapshot; CIA reads are unsupported.
- Native screenshot paths support spaces and Unicode. Unix PNG output requires
  a WinUAE build with libpng.
- Reset and disk insertion/ejection restart an owned emulator. They cannot
  restart an externally launched instance.
- Release a host UI pause before connecting to an existing instance.

## Tool details

### Session lifecycle

`winuae_attach` connects only to an existing listener; GDB attach stops the
CPU. `winuae_launch` starts an owned emulator and rejects an occupied port
before spawning. `winuae_connect` attaches when a server is listening and
launches otherwise. None of these commands changes the user's configuration file.

`winuae_detach` releases remote input and debugger state, resumes the guest
(unless host-paused), and relinquishes process ownership. The emulator then
survives MCP exit. `winuae_shutdown` requires a process still owned by this
MCP server and waits for it to exit. It refuses attached/detached instances.
`winuae_disconnect` terminates an owned child, or disconnects from an
externally launched emulator.

`winuae_status` returns structured JSON with connection health, ownership,
PID and target execution/frame/beam state. It never pauses execution. Host
UI pauses and debugger stops are reported separately; if the host event
pump is unavailable the query reports a communication error, not a guessed
execution state. Cycle counts are strings to preserve integer precision.

`winuae_capabilities` queries the current target's available commands,
CPU/MMU models and address semantics. `winuae_memory_map` exposes the
existing debugger map with RAM/ROM/I/O and chip-memory classification;
it explicitly reports truncation. Hunk loading requires target
`memory-check` support and validates every placement's writable RAM and
memory kind before the first write. These checks do not allocate RAM or
establish that the application owns it.

### Execution and breakpoints

`winuae_wait_stop` observes execution for up to 60 seconds without stopping
it. Pause and disconnect remain available while a wait is pending. A
wait timeout does not interrupt the CPU.

`winuae_range_step` uses standard GDB range stepping with inclusive `start`
and exclusive `end`. It starts asynchronously and remains interruptible,
including when the guest loops inside the range. Use pause to inspect the
stop. Equal bounds perform one instruction. The client checks support
before resuming the target.

`winuae_tasks` reports Exec current/ready/waiting lists, saved SP and stack
bounds. `winuae_history` reads the existing debugger history and supports
`on`/`off` recording controls. Recording slows execution and coalesces
adjacent identical PCs; D/A registers and beam positions are included.
`winuae_step_over` resumes toward the next sequential instruction using
the console debugger's trace mode; wait or interrupt with the existing
tools. `winuae_conditional_breakpoint` adds/lists/removes remote-owned
register comparisons in the existing breakpoint table. Conditions
support eq/ne/le/ge/lt/gt, a mask and signed comparisons. All these tools
check target capabilities before use.

`winuae_exceptions` replaces the selected exception vectors (`action: set`,
`vectors: [2,3,4,5,6,7,8,10,11]`), disables them (`clear`), or queries the mask
and last captured fault (`status`). Masks are independent of console stops
and clear on disconnect. Execution stops after exception-frame construction;
inspect `last.instruction_pc` and the pre-frame register snapshot for fault
diagnosis, and normal register tools for the current handler-entry state.

`winuae_process_breakpoint` sets, inspects or clears a one-shot entry stop.
Select a printable ASCII process/CLI command `name` or a Process `address`,
then continue execution and launch the program in the guest. Console
breakpoints are not changed.

`winuae_loaded_segments` returns current or selected AmigaDOS Process metadata
and loaded segment addresses in load order. Relocate a symbol's hunk-relative
offset by adding the corresponding segment address. Sizes describe allocated
payload bounds, including any padding; they are not exact code lengths.
The emulator validates bounded CLI and Workbench lists and rejects corrupt
metadata. It does not load host symbol files into the emulation core.

### Memory and display

`winuae_memory_search` searches an explicit address range (up to 16 MiB)
for hex bytes. It handles overlapping matches and reads across chunk
boundaries. `max_matches` bounds the response; `next_address` and
`remaining` allow continuation when `limit_reached` is true. Alignment
uses absolute guest addresses. Unreadable memory is an error, not a hole
silently skipped by the search.

`winuae_bitmap` returns a PNG image decoded from 1-8 indexed bitplanes.
Supply `width`, `height`, `planes` (addresses, least significant first),
`palette` (exactly 2^planes RGB values) and optionally `row_stride` (bytes
between rows of the same plane). The default stride is a word-aligned
row. Explicit addresses and stride also support interleaved planes.
Limits are 262144 pixels and 2 MiB of guest reads. HAM/EHB interpretation
and display-mode detection are intentionally outside this tool.

### Watchpoints

`winuae_dma_watchpoint` adds a read, write or access watchpoint with named
source groups: blitter, copper, disk, audio, bitplane and sprite. CPU accesses
are excluded. Keep the returned ID for `remove`, or use `list` to inspect
remote DMA entries. Stops include the actual source mask and custom register.
These entries are independent of standard GDB CPU watchpoints and are
removed on disconnect.

`winuae_watch` adds exact-access watchpoints with aligned `address`, `size`
(1, 2 or 4 bytes), `access` and optional source groups, value/mask matching,
`change_only` and `log_only`. Change-only watches require writable-access
mode and mapped RAM. They compare the old and new value of the entire
access; the optional mask applies to value matching. A 68000 longword
store can appear as two word accesses: select the actual bus access width.
Standard range watchpoints remain available for overlapping accesses.

`last` and `events` return actual access address, size, value, previous
value when available, instruction PC, source mask and DMA register. The
64-event ring evicts oldest records and reports `dropped`; reads do not
consume records. Standard remote CPU and DMA watchpoint hits also enter
this ring. `clear-events` clears evidence. `log_only` watches neither stop
execution nor write an unbounded host log. Queries pause execution.

Extended watchpoint IDs are managed separately from standard CPU/DMA
watchpoints and console entries. Disconnect and checkpoint restore remove
remote watches and evidence. Existing memwatch CPU/MMU restrictions apply.

### Diagnosis

`winuae_snapshot` pauses execution and returns all registers, the stop
reply and optional `{address, length}` memory ranges (16 ranges, 256 KiB
combined). `winuae_postmortem` returns a complete bounded JSON report with
fault and current contexts, disassembly, stack bytes, loaded segments
and captured guest output. An exception is used as the diagnosis context
only when its vector and instruction address match the current stop.
Unavailable optional data appears in `errors`. Neither tool resumes the
CPU or writes guest memory. Reports describe CPU state, not a disk backup.

`winuae_guest_output` controls and reads guest diagnostics sent through the
existing uaelib function 86. Capture is opt-in, limited to 64 records and
4096 bytes, with individual messages capped at 1024 bytes. Record IDs and
truncation/eviction counters make data loss visible. Reads are nondestructive;
`off` retains records and `clear` preserves the enable setting. Disconnect
and reset disable and clear capture. This does not capture guest console or
serial output, and does not alter the emulator's host logging.

`winuae_checkpoint` saves or restores a standard WinUAE state file at `file`.
State files are only valid at the start of a frame, so save resumes the
CPU, writes the file at the next frame start and stops again right after
it. The CPU therefore ends up to one frame past the original stop; read
the returned registers. Any other stop before that, such as a breakpoint
or an interrupt, cancels the save with an error and leaves no file behind.
Save replaces an existing file. Restore replies after completion, keeps the
connection, and leaves the CPU stopped at the restored state. Remote entry
and CPU breakpoints, watchpoints, exception selection and guest-output
capture are cleared; re-arm them after inspecting the restored registers.
External disk/file changes are not rolled back. Normal WinUAE savestate
limitations apply, including completing an active blit when saving. Busy
host filesystems, incompatible devices and input recording/playback are
rejected. Ordinary reset behavior is unchanged.

Postmortem fault context includes target-provided bus/address-fault
metadata and banked stack pointers when supported by WinUAE.

### Executables and symbols

`winuae_hunk_inspect` validates Hunk executables before returning segment
sizes, CHIP/FAST requirements, relocation counts and up to 1024 symbols.
The parser supports CODE, DATA, BSS, RELOC32, RELOC32SHORT (including the
historical DREL32 encoding), NAME, SYMBOL, DEBUG and END. It rejects
other records, overlays and extended memory requirements explicitly.
Files are limited to 16 MiB, allocations to 8 MiB and hunks to 256.

`winuae_hunk_load` requires one `{address, capacity, memory}` placement
per hunk, where `memory` is `chip` or `fast`. Reserve those guest RAM
regions yourself and provide their actual memory kind. This is a debug
loader, not AmigaDOS LoadSeg: it does not allocate guest memory, build
segment lists or start a process. It validates all relocations before
writing, zeroes BSS and padding, verifies every hunk, and attempts to
restore the original bytes on failure. If rollback also fails the
error explicitly identifies possibly modified hunks. Use normal
AmigaDOS loading plus process-entry breakpoints for OS applications.
The raw `winuae_load` tool rejects Hunk files instead of copying
their headers into executable memory.

`winuae_symbols` lists Hunk and ELF32 big-endian m68k symbols, section
metadata and the input file's SHA-256. It and `winuae_hunk_inspect` work
without an emulator connection. Symbol output is bounded and supports
prefix filtering.

`winuae_symbol_read` reads an exact symbol name. Hunk indices correspond
to loaded DOS segment indices. ELF requires an explicit `mappings`
entry, such as `{section: ".data", segment: 1, offset: 0}`; ELF sections
are not assumed to have the same order as DOS hunks. Alternatively use
`{section: 1, address: "0x20000", size: 4096}` for an explicitly known
region. `process` optionally selects the DOS process. Mapping offsets
locate sections within a segment. Use the matching executable/debug
file; a symbol table alone cannot establish the running binary's identity.

Byte reads require `length`. Explicit `u8`, `s8`, `u16`, `s16`, `u32` or
`s32` formats use `count` (default 1) and big-endian decoding. `offset`
is a caller-supplied byte offset, and `section` disambiguates duplicate
names. Reads are bounded by the symbol size when known, section size,
mapped segment size and a 4096-byte response limit. No default 32-byte
read, guessed C layout, DWARF expression evaluation or automatic member
lookup is performed. Use the dedicated DWARF tools below for C-type inspection.

File-format references: [AmigaDOS executable format, chapter 11](https://developer.amigaos3.net/sites/default/files/downloads/2024-10/Amiga_ROM_Kernel_Reference_Manual_DOS.pdf)
and the [generic ELF ABI](https://gabi.xinuos.com/elf/05-symtab.html).

### DWARF source, variables and call stacks

Run `npm run setup:dwarf` to create an isolated `.venv-dwarf` containing
Python's `pyelftools==0.32`. Python 3 must already be installed. The tools
use this environment automatically; `WINUAE_PYTHON` can select another
Python executable containing that version. Other MCP tools do not need
Python. No target code, debugger startup scripts or source files are
executed by the helper.

`winuae_source`, `winuae_variable` and `winuae_backtrace` take a linked
ELF32 big-endian m68k `file` and explicit section `mappings`, using the
same segment/address mapping syntax as symbol reads. The ELF must match
the guest executable. These tools currently require MMU-disabled targets
because remote memory access is physical. Source lookup defaults to PC
or accepts `address`. `context: "fault"` uses the pre-frame registers only
when they match the current exception stop.

Variable expressions support `name.member`, `name->member` and `name[index]`.
Locals and parameters use their active DWARF location, frame base and CFI.
Structures, unions, one-dimensional arrays, pointers and supported scalar
types use their declared offsets and element sizes. Pointers are only
followed with an explicit selector. Unsupported operations, dynamic
bounds, bitfields, ambiguous names and optimized-out locations produce
errors; they are never replaced with guessed layouts or default reads.

Backtraces use `.debug_frame`/`.eh_frame` CFI, including m68k return columns
24 and 25. The report identifies why unwinding stopped if information is
missing, unsupported or inconsistent. There is no stack-scanning fallback.
Source lookup includes inline function names and source file/line data.
Postmortem reports optionally accept `file` and `mappings` to attach a
backtrace from the selected fault/current context; unavailable unwind
support is recorded without discarding the rest of the crash report.

Analysis is bounded to 15 seconds, 16 MiB ELF files, 4 MiB per debug
section, 64 frames, 4096 bytes per value and 64 KiB of total guest reads.
Value expansion has depth/member/element limits. DWARF parsing is provided
by [pyelftools](https://github.com/eliben/pyelftools); the evaluator supports
an explicit subset and reports unsupported forms of evaluation.

### Guest input

`winuae_input` sends Amiga raw keys, relative mouse motion, mouse/joystick
buttons and joystick directions through the shared WinUAE input subsystem.
It leaves the execution state unchanged. Ports 0 and 1 are the physical
Amiga game ports; mouse and joystick buttons share their hardware lines.
Mouse deltas are signed hardware counts, not host screen coordinates.

Use explicit `pressed: true/false` pairs, or `action: release` to release
all remotely held controls. Duplicate state changes are idempotent. Status
reports only remote input ownership, not physical host device state. Do
not simultaneously drive the same control from the host and MCP. Reset,
checkpoint restore and disconnect release remote controls. Input recording
and playback reject new remote input. A paused guest cannot consume key
transitions; frame-timed sequences are needed for reliable taps and typing.

`winuae_input_sequence` accepts up to 256 steps with `after_frames` relative
to the previous step (maximum 3600 frames total). Submission validates the
whole sequence before changing input. Execution starts at a frame boundary;
zero delays group events at that boundary. Sequences freeze during debugger
or host pauses. Completion releases any remaining held controls.

`winuae_key_tap` supplies a raw key or chord. `winuae_type_text` requires
`layout: us`, meaning the **guest** must use the US Amiga keymap. It supports
printable ASCII, tab and newline; unsupported text fails before submission.
Both helpers default to three frames held and three frames between taps.
Their generated events must fit the same sequence limits. Long text can
be split into batches after each preceding sequence completes.

Sequences are asynchronous and do not resume execution unless explicitly
passed `resume: true`. Query `winuae_input` with `action: status`; use
`action: release` to cancel and release held controls. A sequence requires
no existing remote held input, and concurrent submissions are rejected.

## Limitations

- Requires WinUAE with the built-in GDB server.
- Binary loading copies bytes into RAM; it does not relocate or execute
  Amiga Hunk files.
- CPU/DMA profiling and the debug overlay are not exposed.
- Memory addresses are physical; ROM writes and arbitrary I/O access fail.
- Standard GDB watchpoints cover CPU data accesses; the DMA tool selects
  hardware sources. Both follow the emulator's documented range and
  MMU-debugger restrictions.
- The GDB server accepts one local client at a time.

## Credits

- [WinUAE](https://www.winuae.net/) by Toni Wilen -- the Amiga emulator and its built-in GDB server
- [BartmanAbyss WinUAE fork](https://github.com/BartmanAbyss/WinUAE) -- the first GDB server for WinUAE, used by earlier versions of this server
- [vscode-amiga-debug](https://github.com/BartmanAbyss/vscode-amiga-debug) by BartmanAbyss -- the VSCode extension that pioneered Amiga GDB debugging, and the reference for this work
- [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic

## License

MIT
