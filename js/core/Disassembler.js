/*
 * Дизассемблер КР580ВМ80А.
 *
 * Таблица строится один раз при загрузке: регулярные блоки (MOV, арифметика,
 * условные переходы) генерируются программно, нерегулярные коды заданы явно.
 * Формат шаблона: %b — байт-операнд, %w — слово-операнд.
 */
(function (global) {
  'use strict';

  const R = ['B', 'C', 'D', 'E', 'H', 'L', 'M', 'A'];
  const RP = ['B', 'D', 'H', 'SP'];
  const ALU = ['ADD', 'ADC', 'SUB', 'SBB', 'ANA', 'XRA', 'ORA', 'CMP'];
  const ALUI = ['ADI', 'ACI', 'SUI', 'SBI', 'ANI', 'XRI', 'ORI', 'CPI'];
  const CC = ['NZ', 'Z', 'NC', 'C', 'PO', 'PE', 'P', 'M'];

  // table[op] = { m: шаблон, n: длина в байтах }
  const TABLE = new Array(256);
  for (let i = 0; i < 256; i++) TABLE[i] = { m: 'DB %b', n: 1 };

  function set(op, m, n) { TABLE[op] = { m: m, n: n }; }

  // MOV / HLT
  for (let op = 0x40; op <= 0x7F; op++) {
    set(op, 'MOV ' + R[(op >> 3) & 7] + ',' + R[op & 7], 1);
  }
  set(0x76, 'HLT', 1);

  // Арифметика/логика с регистром
  for (let op = 0x80; op <= 0xBF; op++) {
    set(op, ALU[(op >> 3) & 7] + ' ' + R[op & 7], 1);
  }

  // Блок 0x00..0x3F
  for (let i = 0; i < 4; i++) {
    const rp = RP[i], base = i << 4;
    set(base + 0x01, 'LXI ' + rp + ',%w', 3);
    set(base + 0x03, 'INX ' + rp, 1);
    set(base + 0x09, 'DAD ' + rp, 1);
    set(base + 0x0B, 'DCX ' + rp, 1);
  }
  for (let i = 0; i < 8; i++) {
    set(0x04 + i * 8, 'INR ' + R[i], 1);
    set(0x05 + i * 8, 'DCR ' + R[i], 1);
    set(0x06 + i * 8, 'MVI ' + R[i] + ',%b', 2);
  }
  set(0x00, 'NOP', 1);
  set(0x02, 'STAX B', 1);  set(0x12, 'STAX D', 1);
  set(0x0A, 'LDAX B', 1);  set(0x1A, 'LDAX D', 1);
  set(0x07, 'RLC', 1);     set(0x0F, 'RRC', 1);
  set(0x17, 'RAL', 1);     set(0x1F, 'RAR', 1);
  set(0x22, 'SHLD %w', 3); set(0x2A, 'LHLD %w', 3);
  set(0x32, 'STA %w', 3);  set(0x3A, 'LDA %w', 3);
  set(0x27, 'DAA', 1);     set(0x2F, 'CMA', 1);
  set(0x37, 'STC', 1);     set(0x3F, 'CMC', 1);

  // Блок 0xC0..0xFF
  for (let i = 0; i < 8; i++) {
    set(0xC0 + i * 8, 'R' + CC[i], 1);
    set(0xC2 + i * 8, 'J' + CC[i] + ' %w', 3);
    set(0xC4 + i * 8, 'C' + CC[i] + ' %w', 3);
    set(0xC6 + i * 8, ALUI[i] + ' %b', 2);
    set(0xC7 + i * 8, 'RST ' + i, 1);
  }
  for (let i = 0; i < 4; i++) {
    const nm = ['B', 'D', 'H', 'PSW'][i];
    set(0xC1 + i * 0x10, 'POP ' + nm, 1);
    set(0xC5 + i * 0x10, 'PUSH ' + nm, 1);
  }
  set(0xC3, 'JMP %w', 3);
  set(0xC9, 'RET', 1);
  set(0xCD, 'CALL %w', 3);
  set(0xD3, 'OUT %b', 2);
  set(0xDB, 'IN %b', 2);
  set(0xE3, 'XTHL', 1);
  set(0xE9, 'PCHL', 1);
  set(0xEB, 'XCHG', 1);
  set(0xF9, 'SPHL', 1);
  set(0xF3, 'DI', 1);
  set(0xFB, 'EI', 1);

  // Недокументированные коды помечаем звёздочкой
  set(0x08, '*NOP', 1); set(0x10, '*NOP', 1); set(0x18, '*NOP', 1);
  set(0x20, '*NOP', 1); set(0x28, '*NOP', 1); set(0x30, '*NOP', 1);
  set(0x38, '*NOP', 1);
  set(0xCB, '*JMP %w', 3);
  set(0xD9, '*RET', 1);
  set(0xDD, '*CALL %w', 3);
  set(0xED, '*CALL %w', 3);
  set(0xFD, '*CALL %w', 3);

  function hex(v, digits) {
    return v.toString(16).toUpperCase().padStart(digits, '0');
  }

  const Disassembler = {
    TABLE: TABLE,

    /** Длина команды по её коду операции */
    length(op) { return TABLE[op & 0xFF].n; },

    /**
     * Разбирает одну команду по адресу addr.
     * readFn(addr) -> байт (обычно bus.read, но можно передать любой источник)
     * @returns {{addr:number, size:number, bytes:number[], text:string, target:number|null}}
     */
    disassemble(readFn, addr) {
      addr &= 0xFFFF;
      const op = readFn(addr) & 0xFF;
      const info = TABLE[op];
      const bytes = [op];
      let text = info.m;
      let target = null;

      if (info.n >= 2) {
        const b1 = readFn((addr + 1) & 0xFFFF) & 0xFF;
        bytes.push(b1);
        if (info.n === 3) {
          const b2 = readFn((addr + 2) & 0xFFFF) & 0xFF;
          bytes.push(b2);
          const word = b1 | (b2 << 8);
          text = text.replace('%w', hex(word, 4) + 'H');
          target = word;
        } else {
          text = text.replace('%b', hex(b1, 2) + 'H');
        }
      }

      return { addr: addr, size: info.n, bytes: bytes, text: text, target: target };
    },

    /** Разбирает count команд подряд, начиная с addr */
    disassembleRange(readFn, addr, count) {
      const out = [];
      let a = addr & 0xFFFF;
      for (let i = 0; i < count; i++) {
        const line = this.disassemble(readFn, a);
        out.push(line);
        a = (a + line.size) & 0xFFFF;
      }
      return out;
    },

    /** Строка вида "F800  31 00 76   LXI SP,7600H" */
    format(line) {
      const b = line.bytes.map(function (x) { return hex(x, 2); }).join(' ');
      return hex(line.addr, 4) + '  ' + b.padEnd(8) + '  ' + line.text;
    },

    hex: hex
  };

  global.Disassembler = Disassembler;

})(window);
