/*
 * КР580ВМ80А (Intel 8080A) — процессорное ядро.
 *
 * Главный метод — step(): выполняет ровно одну инструкцию и возвращает число
 * потраченных тактов. Такты считаются по таблице из документации, условные
 * переходы/возвраты добавляют такты только когда условие выполнилось.
 *
 * Неизвестные (недокументированные) коды операций не роняют эмулятор:
 * они выводятся в консоль через onUnknownOpcode() для последующего разбора,
 * после чего выполняются как их фактический аналог на реальном кристалле.
 */
(function (global) {
  'use strict';

  // Индексы регистров в поле this.r — совпадают с кодировкой в командах 8080
  const B = 0, C = 1, D = 2, E = 3, H = 4, L = 5, M = 6, A = 7;

  /* --- Таблица тактов ----------------------------------------------------- */
  const CYCLES = new Uint8Array(256);

  // MOV r,r' — 5 тактов, обращение к M — 7
  for (let op = 0x40; op <= 0x7F; op++) {
    const dst = (op >> 3) & 7, src = op & 7;
    CYCLES[op] = (dst === M || src === M) ? 7 : 5;
  }
  CYCLES[0x76] = 7;                                    // HLT
  // Арифметика/логика с регистром — 4 такта, с M — 7
  for (let op = 0x80; op <= 0xBF; op++) CYCLES[op] = (op & 7) === M ? 7 : 4;

  // Блок 0x00..0x3F
  {
    const t = [
      4, 10, 7, 5, 5, 5, 7, 4, 4, 10, 7, 5, 5, 5, 7, 4,   // 0x00
      4, 10, 7, 5, 5, 5, 7, 4, 4, 10, 7, 5, 5, 5, 7, 4,   // 0x10
      4, 10, 16, 5, 5, 5, 7, 4, 4, 10, 16, 5, 5, 5, 7, 4, // 0x20
      4, 10, 13, 5, 10, 10, 10, 4, 4, 10, 13, 5, 5, 5, 7, 4 // 0x30
    ];
    for (let i = 0; i < 64; i++) CYCLES[i] = t[i];
  }

  // Блок 0xC0..0xFF: повторяющийся узор по 8 кодов
  for (let op = 0xC0; op <= 0xFF; op++) {
    switch (op & 0x0F) {
      case 0x0: case 0x8: CYCLES[op] = 5; break;   // Rcond (+6 если возврат)
      case 0x1: CYCLES[op] = 10; break;            // POP
      case 0x2: case 0xA: CYCLES[op] = 10; break;  // Jcond
      case 0x3: case 0xB: CYCLES[op] = 10; break;  // JMP и прочее
      case 0x4: case 0xC: CYCLES[op] = 11; break;  // Ccond (+6 если вызов)
      case 0x5: CYCLES[op] = 11; break;            // PUSH
      case 0x6: case 0xE: CYCLES[op] = 7; break;   // ALU immediate
      case 0x7: case 0xF: CYCLES[op] = 11; break;  // RST
      case 0x9: CYCLES[op] = 10; break;            // RET
      case 0xD: CYCLES[op] = 17; break;            // CALL
    }
  }
  CYCLES[0xC9] = 10; CYCLES[0xD9] = 10;   // RET (0xD9 — недокументированный дубль)
  CYCLES[0xCD] = 17; CYCLES[0xDD] = 17; CYCLES[0xED] = 17; CYCLES[0xFD] = 17;
  CYCLES[0xD3] = 10; CYCLES[0xDB] = 10;   // OUT / IN
  CYCLES[0xE3] = 18;                      // XTHL
  CYCLES[0xE9] = 5;                       // PCHL
  CYCLES[0xEB] = 4;                       // XCHG
  CYCLES[0xF9] = 5;                       // SPHL
  CYCLES[0xF3] = 4; CYCLES[0xFB] = 4;     // DI / EI

  // Недокументированные коды: фактическое поведение на кристалле
  const UNDOCUMENTED = new Set([0x08, 0x10, 0x18, 0x20, 0x28, 0x30, 0x38,
                                0xCB, 0xD9, 0xDD, 0xED, 0xFD]);

  // Таблица чётности для флага P
  const PARITY = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let bits = 0, v = i;
    while (v) { bits += v & 1; v >>= 1; }
    PARITY[i] = bits & 1 ? 0 : 1;      // 1 = чётное число единиц
  }

  class I8080 {
    /**
     * @param {Bus} bus  шина памяти/устройств (read/write/ioRead/ioWrite)
     */
    constructor(bus) {
      this.bus = bus;
      this.r = new Uint8Array(8);   // B C D E H L (M — заглушка) A
      this.pc = 0;
      this.sp = 0;

      // Флаги хранятся отдельными полями — так быстрее и нагляднее при отладке
      this.fs = 0;   // знак
      this.fz = 0;   // ноль
      this.fa = 0;   // вспомогательный перенос
      this.fp = 0;   // чётность
      this.fc = 0;   // перенос

      this.ime = false;      // разрешение прерываний
      this.halted = false;
      this.intPending = -1;  // код команды, вставляемой по прерыванию (обычно RST)

      this.cycles = 0;       // всего тактов с момента сброса
      this.instructions = 0; // всего выполненных команд

      // Статистика по неизвестным кодам: код -> сколько раз встретился
      this.unknownOpcodes = new Map();

      this.reset();
    }

    reset(pc) {
      this.r.fill(0);
      this.pc = pc === undefined ? 0 : pc & 0xFFFF;
      this.sp = 0;
      this.fs = this.fz = this.fa = this.fp = this.fc = 0;
      this.ime = false;
      this.halted = false;
      this.intPending = -1;
      this.cycles = 0;
      this.instructions = 0;
      this.unknownOpcodes.clear();
    }

    /* --- Доступ к парам регистров ---------------------------------------- */
    get bc() { return (this.r[B] << 8) | this.r[C]; }
    set bc(v) { this.r[B] = (v >> 8) & 0xFF; this.r[C] = v & 0xFF; }
    get de() { return (this.r[D] << 8) | this.r[E]; }
    set de(v) { this.r[D] = (v >> 8) & 0xFF; this.r[E] = v & 0xFF; }
    get hl() { return (this.r[H] << 8) | this.r[L]; }
    set hl(v) { this.r[H] = (v >> 8) & 0xFF; this.r[L] = v & 0xFF; }
    get a() { return this.r[A]; }
    set a(v) { this.r[A] = v & 0xFF; }

    /** Регистр флагов F в виде байта (как его кладёт на стек PUSH PSW) */
    get f() {
      return (this.fs << 7) | (this.fz << 6) | (this.fa << 4) |
             (this.fp << 2) | 0x02 | this.fc;
    }
    set f(v) {
      this.fs = (v >> 7) & 1;
      this.fz = (v >> 6) & 1;
      this.fa = (v >> 4) & 1;
      this.fp = (v >> 2) & 1;
      this.fc = v & 1;
    }

    /* --- Обращения к памяти ----------------------------------------------- */
    read8(addr) { return this.bus.read(addr & 0xFFFF); }
    write8(addr, v) { this.bus.write(addr & 0xFFFF, v & 0xFF); }
    read16(addr) {
      return this.bus.read(addr & 0xFFFF) | (this.bus.read((addr + 1) & 0xFFFF) << 8);
    }
    write16(addr, v) {
      this.bus.write(addr & 0xFFFF, v & 0xFF);
      this.bus.write((addr + 1) & 0xFFFF, (v >> 8) & 0xFF);
    }

    fetch8() {
      const v = this.bus.read(this.pc);
      this.pc = (this.pc + 1) & 0xFFFF;
      return v;
    }
    fetch16() {
      const lo = this.fetch8();
      return lo | (this.fetch8() << 8);
    }

    push16(v) {
      this.sp = (this.sp - 2) & 0xFFFF;
      this.write16(this.sp, v);
    }
    pop16() {
      const v = this.read16(this.sp);
      this.sp = (this.sp + 2) & 0xFFFF;
      return v;
    }

    /* --- Чтение/запись «регистра» с учётом M ------------------------------ */
    getR(i) { return i === M ? this.bus.read(this.hl) : this.r[i]; }
    setR(i, v) {
      if (i === M) this.bus.write(this.hl, v & 0xFF);
      else this.r[i] = v & 0xFF;
    }

    /* --- Флаги ------------------------------------------------------------ */
    setSZP(v) {
      this.fs = (v >> 7) & 1;
      this.fz = v === 0 ? 1 : 0;
      this.fp = PARITY[v];
    }

    /* --- АЛУ -------------------------------------------------------------- */
    add(v, carryIn) {
      const a = this.r[A];
      const res = a + v + carryIn;
      this.fa = ((a & 0x0F) + (v & 0x0F) + carryIn) > 0x0F ? 1 : 0;
      this.fc = res > 0xFF ? 1 : 0;
      this.r[A] = res & 0xFF;
      this.setSZP(this.r[A]);
    }

    /* Вычитание выполняется как сложение с дополнением до двух — так
     * вспомогательный перенос получается ровно таким, каким его формирует
     * реальный кристалл (AC = отсутствие заёма из четвёртого бита). */
    sub(v, borrowIn) {
      const a = this.r[A];
      const nv = (~v) & 0xFF;
      const cin = borrowIn ? 0 : 1;
      const res = a + nv + cin;
      this.fa = ((a & 0x0F) + (nv & 0x0F) + cin) > 0x0F ? 1 : 0;
      this.fc = res > 0xFF ? 0 : 1;      // перенос инвертирован = заём
      this.r[A] = res & 0xFF;
      this.setSZP(this.r[A]);
    }

    cmp(v) {
      const saved = this.r[A];
      this.sub(v, 0);
      this.r[A] = saved;                 // CMP результат не сохраняет
    }

    ana(v) {
      // Особенность 8080: AC формируется как ИЛИ третьих битов операндов
      this.fa = ((this.r[A] | v) & 0x08) ? 1 : 0;
      this.r[A] &= v;
      this.fc = 0;
      this.setSZP(this.r[A]);
    }
    xra(v) {
      this.r[A] ^= v;
      this.fc = 0; this.fa = 0;
      this.setSZP(this.r[A]);
    }
    ora(v) {
      this.r[A] |= v;
      this.fc = 0; this.fa = 0;
      this.setSZP(this.r[A]);
    }

    inr(i) {
      const v = (this.getR(i) + 1) & 0xFF;
      this.fa = (v & 0x0F) === 0 ? 1 : 0;
      this.setR(i, v);
      this.setSZP(v);
    }
    dcr(i) {
      const v = (this.getR(i) - 1) & 0xFF;
      this.fa = (v & 0x0F) === 0x0F ? 0 : 1;
      this.setR(i, v);
      this.setSZP(v);
    }

    dad(v) {
      const res = this.hl + v;
      this.fc = res > 0xFFFF ? 1 : 0;
      this.hl = res & 0xFFFF;
    }

    daa() {
      let corr = 0;
      const a = this.r[A];
      let carry = this.fc;
      if (this.fa || (a & 0x0F) > 9) corr |= 0x06;
      if (this.fc || a > 0x99) { corr |= 0x60; carry = 1; }
      this.add(corr, 0);
      this.fc = carry;
    }

    /* --- Условия для J/C/R ------------------------------------------------ */
    testCondition(cc) {
      switch (cc) {
        case 0: return this.fz === 0;   // NZ
        case 1: return this.fz === 1;   // Z
        case 2: return this.fc === 0;   // NC
        case 3: return this.fc === 1;   // C
        case 4: return this.fp === 0;   // PO
        case 5: return this.fp === 1;   // PE
        case 6: return this.fs === 0;   // P
        case 7: return this.fs === 1;   // M
      }
      return false;
    }

    /* --- Прерывания -------------------------------------------------------- */
    /** Запрос прерывания. opcode — команда, выставляемая на шину (обычно RST n) */
    interrupt(opcode) {
      if (this.ime) this.intPending = opcode & 0xFF;
    }

    /* --- Диагностика неизвестных команд ------------------------------------ */
    onUnknownOpcode(op, addr) {
      const n = (this.unknownOpcodes.get(op) || 0) + 1;
      this.unknownOpcodes.set(op, n);
      // Не засоряем консоль: подробно печатаем первые встречи каждого кода
      if (n <= 3) {
        console.warn(
          '[i8080] Неизвестный код операции 0x' + op.toString(16).padStart(2, '0').toUpperCase() +
          ' по адресу 0x' + addr.toString(16).padStart(4, '0').toUpperCase() +
          ' (встреча №' + n + ')' +
          (UNDOCUMENTED.has(op) ? ' — недокументированная команда, выполняется как аналог' : '')
        );
      }
    }

    /* ====================================================================== *
     *  Выполнение одной инструкции. Возвращает число потраченных тактов.
     * ====================================================================== */
    step() {
      // Обработка запроса прерывания
      if (this.intPending >= 0) {
        const op = this.intPending;
        this.intPending = -1;
        this.ime = false;
        this.halted = false;
        if ((op & 0xC7) === 0xC7) {          // RST n — единственный вариант на РК-86
          this.push16(this.pc);
          this.pc = op & 0x38;
          this.cycles += 11;
          return 11;
        }
        console.warn('[i8080] По прерыванию выставлен код 0x' +
          op.toString(16).toUpperCase() + ', а не RST — не поддерживается, пропущен');
      }

      if (this.halted) {
        this.cycles += 4;
        return 4;                            // процессор стоит, но такты идут
      }

      const startPc = this.pc;
      const op = this.fetch8();
      let t = CYCLES[op];

      // --- MOV r,r' (0x40..0x7F, кроме 0x76 = HLT) ---
      if (op >= 0x40 && op <= 0x7F) {
        if (op === 0x76) {
          this.halted = true;
        } else {
          this.setR((op >> 3) & 7, this.getR(op & 7));
        }
        this.cycles += t; this.instructions++;
        return t;
      }

      // --- Арифметика и логика с регистром (0x80..0xBF) ---
      if (op >= 0x80 && op <= 0xBF) {
        const v = this.getR(op & 7);
        switch ((op >> 3) & 7) {
          case 0: this.add(v, 0); break;          // ADD
          case 1: this.add(v, this.fc); break;    // ADC
          case 2: this.sub(v, 0); break;          // SUB
          case 3: this.sub(v, this.fc); break;    // SBB
          case 4: this.ana(v); break;             // ANA
          case 5: this.xra(v); break;             // XRA
          case 6: this.ora(v); break;             // ORA
          case 7: this.cmp(v); break;             // CMP
        }
        this.cycles += t; this.instructions++;
        return t;
      }

      switch (op) {
        /* --- Пересылки и загрузки ---------------------------------------- */
        case 0x00: break;                                        // NOP
        case 0x01: this.bc = this.fetch16(); break;              // LXI B
        case 0x11: this.de = this.fetch16(); break;              // LXI D
        case 0x21: this.hl = this.fetch16(); break;              // LXI H
        case 0x31: this.sp = this.fetch16(); break;              // LXI SP

        case 0x02: this.write8(this.bc, this.r[A]); break;       // STAX B
        case 0x12: this.write8(this.de, this.r[A]); break;       // STAX D
        case 0x0A: this.r[A] = this.read8(this.bc); break;       // LDAX B
        case 0x1A: this.r[A] = this.read8(this.de); break;       // LDAX D

        case 0x22: this.write16(this.fetch16(), this.hl); break; // SHLD
        case 0x2A: this.hl = this.read16(this.fetch16()); break; // LHLD
        case 0x32: this.write8(this.fetch16(), this.r[A]); break;// STA
        case 0x3A: this.r[A] = this.read8(this.fetch16()); break;// LDA

        case 0x06: case 0x0E: case 0x16: case 0x1E:              // MVI r,d8
        case 0x26: case 0x2E: case 0x36: case 0x3E:
          this.setR((op >> 3) & 7, this.fetch8());
          break;

        /* --- Инкременты/декременты --------------------------------------- */
        case 0x03: this.bc = (this.bc + 1) & 0xFFFF; break;      // INX B
        case 0x13: this.de = (this.de + 1) & 0xFFFF; break;      // INX D
        case 0x23: this.hl = (this.hl + 1) & 0xFFFF; break;      // INX H
        case 0x33: this.sp = (this.sp + 1) & 0xFFFF; break;      // INX SP
        case 0x0B: this.bc = (this.bc - 1) & 0xFFFF; break;      // DCX B
        case 0x1B: this.de = (this.de - 1) & 0xFFFF; break;      // DCX D
        case 0x2B: this.hl = (this.hl - 1) & 0xFFFF; break;      // DCX H
        case 0x3B: this.sp = (this.sp - 1) & 0xFFFF; break;      // DCX SP

        case 0x04: case 0x0C: case 0x14: case 0x1C:              // INR r
        case 0x24: case 0x2C: case 0x34: case 0x3C:
          this.inr((op >> 3) & 7);
          break;
        case 0x05: case 0x0D: case 0x15: case 0x1D:              // DCR r
        case 0x25: case 0x2D: case 0x35: case 0x3D:
          this.dcr((op >> 3) & 7);
          break;

        /* --- Сложение пар ------------------------------------------------- */
        case 0x09: this.dad(this.bc); break;                     // DAD B
        case 0x19: this.dad(this.de); break;                     // DAD D
        case 0x29: this.dad(this.hl); break;                     // DAD H
        case 0x39: this.dad(this.sp); break;                     // DAD SP

        /* --- Сдвиги и операции с аккумулятором ---------------------------- */
        case 0x07: {                                             // RLC
          const a = this.r[A];
          this.fc = (a >> 7) & 1;
          this.r[A] = ((a << 1) | this.fc) & 0xFF;
          break;
        }
        case 0x0F: {                                             // RRC
          const a = this.r[A];
          this.fc = a & 1;
          this.r[A] = ((a >> 1) | (this.fc << 7)) & 0xFF;
          break;
        }
        case 0x17: {                                             // RAL
          const a = this.r[A], c = this.fc;
          this.fc = (a >> 7) & 1;
          this.r[A] = ((a << 1) | c) & 0xFF;
          break;
        }
        case 0x1F: {                                             // RAR
          const a = this.r[A], c = this.fc;
          this.fc = a & 1;
          this.r[A] = ((a >> 1) | (c << 7)) & 0xFF;
          break;
        }
        case 0x27: this.daa(); break;                            // DAA
        case 0x2F: this.r[A] = (~this.r[A]) & 0xFF; break;       // CMA
        case 0x37: this.fc = 1; break;                           // STC
        case 0x3F: this.fc ^= 1; break;                          // CMC

        /* --- Арифметика с непосредственным операндом ---------------------- */
        case 0xC6: this.add(this.fetch8(), 0); break;            // ADI
        case 0xCE: this.add(this.fetch8(), this.fc); break;      // ACI
        case 0xD6: this.sub(this.fetch8(), 0); break;            // SUI
        case 0xDE: this.sub(this.fetch8(), this.fc); break;      // SBI
        case 0xE6: this.ana(this.fetch8()); break;               // ANI
        case 0xEE: this.xra(this.fetch8()); break;               // XRI
        case 0xF6: this.ora(this.fetch8()); break;               // ORI
        case 0xFE: this.cmp(this.fetch8()); break;               // CPI

        /* --- Переходы ------------------------------------------------------ */
        case 0xC3:                                               // JMP
        case 0xCB: {                                             // недокум. дубль JMP
          if (op === 0xCB) this.onUnknownOpcode(op, startPc);
          this.pc = this.fetch16();
          break;
        }
        case 0xC2: case 0xCA: case 0xD2: case 0xDA:              // Jcond
        case 0xE2: case 0xEA: case 0xF2: case 0xFA: {
          const addr = this.fetch16();
          if (this.testCondition((op >> 3) & 7)) this.pc = addr;
          break;
        }

        case 0xCD:                                               // CALL
        case 0xDD: case 0xED: case 0xFD: {                       // недокум. дубли
          if (op !== 0xCD) this.onUnknownOpcode(op, startPc);
          const addr = this.fetch16();
          this.push16(this.pc);
          this.pc = addr;
          break;
        }
        case 0xC4: case 0xCC: case 0xD4: case 0xDC:              // Ccond
        case 0xE4: case 0xEC: case 0xF4: case 0xFC: {
          const addr = this.fetch16();
          if (this.testCondition((op >> 3) & 7)) {
            this.push16(this.pc);
            this.pc = addr;
            t += 6;                                              // 11 -> 17
          }
          break;
        }

        case 0xC9:                                               // RET
        case 0xD9: {                                             // недокум. дубль
          if (op === 0xD9) this.onUnknownOpcode(op, startPc);
          this.pc = this.pop16();
          break;
        }
        case 0xC0: case 0xC8: case 0xD0: case 0xD8:              // Rcond
        case 0xE0: case 0xE8: case 0xF0: case 0xF8: {
          if (this.testCondition((op >> 3) & 7)) {
            this.pc = this.pop16();
            t += 6;                                              // 5 -> 11
          }
          break;
        }

        case 0xC7: case 0xCF: case 0xD7: case 0xDF:              // RST n
        case 0xE7: case 0xEF: case 0xF7: case 0xFF:
          this.push16(this.pc);
          this.pc = op & 0x38;
          break;

        case 0xE9: this.pc = this.hl; break;                     // PCHL

        /* --- Стек ---------------------------------------------------------- */
        case 0xC1: this.bc = this.pop16(); break;                // POP B
        case 0xD1: this.de = this.pop16(); break;                // POP D
        case 0xE1: this.hl = this.pop16(); break;                // POP H
        case 0xF1: {                                             // POP PSW
          const v = this.pop16();
          this.f = v & 0xFF;
          this.r[A] = (v >> 8) & 0xFF;
          break;
        }
        case 0xC5: this.push16(this.bc); break;                  // PUSH B
        case 0xD5: this.push16(this.de); break;                  // PUSH D
        case 0xE5: this.push16(this.hl); break;                  // PUSH H
        case 0xF5: this.push16((this.r[A] << 8) | this.f); break;// PUSH PSW

        case 0xE3: {                                             // XTHL
          const v = this.read16(this.sp);
          this.write16(this.sp, this.hl);
          this.hl = v;
          break;
        }
        case 0xEB: {                                             // XCHG
          const t2 = this.hl;
          this.hl = this.de;
          this.de = t2;
          break;
        }
        case 0xF9: this.sp = this.hl; break;                     // SPHL

        /* --- Ввод/вывод и управление -------------------------------------- */
        case 0xDB: this.r[A] = this.bus.ioRead(this.fetch8()); break;         // IN
        case 0xD3: this.bus.ioWrite(this.fetch8(), this.r[A]); break;         // OUT
        case 0xF3: this.ime = false; break;                                   // DI
        case 0xFB: this.ime = true; break;                                    // EI

        /* --- Недокументированные NOP-ы ------------------------------------- */
        case 0x08: case 0x10: case 0x18: case 0x20: case 0x28:
        case 0x30: case 0x38:
          this.onUnknownOpcode(op, startPc);
          break;

        default:
          // Сюда попасть не должно — все 256 кодов разобраны выше.
          // Оставлено как страховка: сообщаем и выполняем как NOP.
          this.onUnknownOpcode(op, startPc);
          t = 4;
          break;
      }

      this.cycles += t;
      this.instructions++;
      return t;
    }

    /** Снимок состояния для отладчика */
    getState() {
      return {
        a: this.r[A], b: this.r[B], c: this.r[C], d: this.r[D],
        e: this.r[E], h: this.r[H], l: this.r[L],
        bc: this.bc, de: this.de, hl: this.hl,
        sp: this.sp, pc: this.pc, f: this.f,
        fs: this.fs, fz: this.fz, fa: this.fa, fp: this.fp, fc: this.fc,
        ime: this.ime, halted: this.halted,
        cycles: this.cycles, instructions: this.instructions
      };
    }
  }

  I8080.CYCLES = CYCLES;
  I8080.REG = { B, C, D, E, H, L, M, A };
  global.I8080 = I8080;

})(window);
