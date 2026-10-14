/* Build with a m68k ELF compiler and -g -nostdlib -Wl,--emit-relocs.
 * Run: node scripts/test-dwarf-linked.mjs /path/to/linked.elf
 */
void corrupt(void);
void _start(void) { corrupt(); }
volatile unsigned short watched = 0x1122;
__attribute__((noinline)) void corrupt(void)
{
    watched = 0x1144;
    __asm__ volatile ("illegal");
}
