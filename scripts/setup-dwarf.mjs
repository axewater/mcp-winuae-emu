import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const basePython = process.env.WINUAE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const directory = fileURLToPath(new URL('../.venv-dwarf', import.meta.url));
execFileSync(basePython, ['-m', 'venv', directory], { stdio: 'inherit' });
const python = fileURLToPath(new URL(process.platform === 'win32' ? '../.venv-dwarf/Scripts/python.exe' : '../.venv-dwarf/bin/python', import.meta.url));
execFileSync(python, ['-m', 'pip', 'install', '-r', fileURLToPath(new URL('../requirements-dwarf.txt', import.meta.url))], { stdio: 'inherit' });
