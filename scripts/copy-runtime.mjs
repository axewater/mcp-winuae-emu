import { copyFile } from 'node:fs/promises';
await copyFile(new URL('../src/dwarf_helper.py', import.meta.url), new URL('../dist/dwarf_helper.py', import.meta.url));
