// Проверка ядра вне браузера: подсовываем модулям глобальный window.
// Запуск:  node tests/cpu-test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const sandbox = { console };
sandbox.window = sandbox;
sandbox.performance = { now: () => Date.now() };
vm.createContext(sandbox);

for (const f of ['js/config/machines.js', 'js/core/Disassembler.js', 'js/core/Bus.js',
                 'js/core/I8080.js', 'js/roms/DemoROM.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}

const { MACHINES, Bus, I8080, Disassembler, DemoROM } = sandbox;

let fails = 0, checks = 0;
function eq(actual, expected, what) {
  checks++;
  if (actual !== expected) {
    fails++;
    console.log(`ПРОВАЛ  ${what}: получено ${actual}, ожидалось ${expected}`);
  }
}

// --- Простейшая шина только с ОЗУ ---
function makeCpu(program, org = 0) {
  const bus = new Bus({ regions: [{ start: 0, end: 0xFFFF, type: 'ram' }], romStart: 0, romSize: 0 });
  bus.loadRAM(org, Uint8Array.from(program));
  const cpu = new I8080(bus);
  cpu.reset(org);
  return { cpu, bus };
}
function run(cpu, n) { let t = 0; for (let i = 0; i < n; i++) t += cpu.step(); return t; }

/* ============ 1. Флаги сложения/вычитания ============ */
{
  // MVI A,3Eh ; ADI 42h -> 80h. Единичный бит один, значит чётность нечётная: P=0
  const { cpu } = makeCpu([0x3E, 0x3E, 0xC6, 0x42]);
  run(cpu, 2);
  eq(cpu.a, 0x80, 'ADI результат');
  eq(cpu.fs, 1, 'ADI S'); eq(cpu.fz, 0, 'ADI Z');
  eq(cpu.fa, 1, 'ADI AC'); eq(cpu.fp, 0, 'ADI P'); eq(cpu.fc, 0, 'ADI C');
  // А 0x03 (два бита) должен дать P=1
  const b = makeCpu([0x3E, 0x01, 0xC6, 0x02]);
  run(b.cpu, 2);
  eq(b.cpu.fp, 1, 'ADI P при чётном числе единиц');
}
{
  // MVI A,00h ; SUI 01h -> FFh, C=1 (заём), AC=0
  const { cpu } = makeCpu([0x3E, 0x00, 0xD6, 0x01]);
  run(cpu, 2);
  eq(cpu.a, 0xFF, 'SUI результат');
  eq(cpu.fc, 1, 'SUI C (заём)');
  eq(cpu.fa, 0, 'SUI AC');
  eq(cpu.fs, 1, 'SUI S');
}
{
  // CMP не меняет аккумулятор, но ставит Z при равенстве
  const { cpu } = makeCpu([0x3E, 0x55, 0xFE, 0x55]);
  run(cpu, 2);
  eq(cpu.a, 0x55, 'CPI сохраняет A');
  eq(cpu.fz, 1, 'CPI Z'); eq(cpu.fc, 0, 'CPI C');
}
{
  // ANA: особенность 8080 — AC = ИЛИ третьих битов
  const { cpu } = makeCpu([0x3E, 0x08, 0x06, 0x00, 0xA0]); // MVI A,08; MVI B,00; ANA B
  run(cpu, 3);
  eq(cpu.a, 0x00, 'ANA результат');
  eq(cpu.fa, 1, 'ANA AC (8080)');
  eq(cpu.fz, 1, 'ANA Z'); eq(cpu.fc, 0, 'ANA C');
}

/* ============ 2. DAA ============ */
{
  // 9 + 8 = 11 в двоично-десятичном виде
  const { cpu } = makeCpu([0x3E, 0x09, 0xC6, 0x08, 0x27]);
  run(cpu, 3);
  eq(cpu.a, 0x17, 'DAA 9+8');
  eq(cpu.fc, 0, 'DAA 9+8 C');
}
{
  // 99 + 1 = 00 с переносом
  const { cpu } = makeCpu([0x3E, 0x99, 0xC6, 0x01, 0x27]);
  run(cpu, 3);
  eq(cpu.a, 0x00, 'DAA 99+1');
  eq(cpu.fc, 1, 'DAA 99+1 C');
  eq(cpu.fz, 1, 'DAA 99+1 Z');
}

/* ============ 3. Сдвиги ============ */
{
  const { cpu } = makeCpu([0x3E, 0xAA, 0x07]);      // MVI A,AA; RLC
  run(cpu, 2);
  eq(cpu.a, 0x55, 'RLC результат'); eq(cpu.fc, 1, 'RLC C');
}
{
  const { cpu } = makeCpu([0x3E, 0x81, 0x37, 0x1F]); // MVI A,81; STC; RAR
  run(cpu, 3);
  eq(cpu.a, 0xC0, 'RAR результат'); eq(cpu.fc, 1, 'RAR C');
}

/* ============ 4. Стек, PSW, XTHL ============ */
{
  const { cpu } = makeCpu([
    0x31, 0x00, 0x40,       // LXI SP,4000
    0x3E, 0x12, 0x37,       // MVI A,12 ; STC
    0xF5,                   // PUSH PSW
    0x3E, 0x00, 0x3F,       // MVI A,00 ; CMC (сбрасываем C)
    0xF1                    // POP PSW
  ]);
  run(cpu, 7);
  eq(cpu.a, 0x12, 'POP PSW восстановил A');
  eq(cpu.fc, 1, 'POP PSW восстановил C');
  eq(cpu.sp, 0x4000, 'SP вернулся на место');
}
{
  const { cpu, bus } = makeCpu([
    0x31, 0x00, 0x40,       // LXI SP,4000
    0x21, 0x34, 0x12,       // LXI H,1234
    0xE5,                   // PUSH H
    0x21, 0x78, 0x56,       // LXI H,5678
    0xE3                    // XTHL
  ]);
  run(cpu, 5);
  eq(cpu.hl, 0x1234, 'XTHL: HL <- вершина стека');
  eq(bus.read(0x3FFE) | (bus.read(0x3FFF) << 8), 0x5678, 'XTHL: стек <- HL');
}

/* ============ 5. Условные переходы и такты ============ */
{
  // Ccond не выполнен: 11 тактов; выполнен: 17
  const { cpu } = makeCpu([0x31, 0x00, 0x40, 0xAF, 0xC4, 0x20, 0x00]); // XRA A (Z=1); CNZ 0020
  run(cpu, 2);
  const t = cpu.step();
  eq(t, 11, 'CNZ без перехода — 11 тактов');
  eq(cpu.pc, 0x0007, 'CNZ без перехода — PC за командой');
}
{
  const { cpu } = makeCpu([0x31, 0x00, 0x40, 0xAF, 0xCC, 0x20, 0x00]); // CZ 0020 при Z=1
  run(cpu, 2);
  const t = cpu.step();
  eq(t, 17, 'CZ с переходом — 17 тактов');
  eq(cpu.pc, 0x0020, 'CZ с переходом — PC на цели');
  eq(cpu.sp, 0x3FFE, 'CZ положил адрес возврата');
}
{
  const { cpu } = makeCpu([0x31, 0x00, 0x40, 0xAF, 0xC0]); // RNZ при Z=1 -> не выполняется
  run(cpu, 2);
  eq(cpu.step(), 5, 'RNZ без возврата — 5 тактов');
}

/* ============ 6. DAD и INX ============ */
{
  const { cpu } = makeCpu([0x21, 0xFF, 0xFF, 0x01, 0x01, 0x00, 0x09]); // LXI H,FFFF; LXI B,0001; DAD B
  run(cpu, 3);
  eq(cpu.hl, 0x0000, 'DAD переполнение');
  eq(cpu.fc, 1, 'DAD C');
  eq(cpu.fz, 0, 'DAD не трогает Z');
}

/* ============ 7. Таблица тактов на характерных командах ============ */
{
  const C = I8080.CYCLES;
  eq(C[0x00], 4, 'такты NOP');
  eq(C[0x40], 5, 'такты MOV B,B');
  eq(C[0x46], 7, 'такты MOV B,M');
  eq(C[0x70], 7, 'такты MOV M,B');
  eq(C[0x76], 7, 'такты HLT');
  eq(C[0x80], 4, 'такты ADD B');
  eq(C[0x86], 7, 'такты ADD M');
  eq(C[0x34], 10, 'такты INR M');
  eq(C[0x36], 10, 'такты MVI M');
  eq(C[0x22], 16, 'такты SHLD');
  eq(C[0x32], 13, 'такты STA');
  eq(C[0xC3], 10, 'такты JMP');
  eq(C[0xCD], 17, 'такты CALL');
  eq(C[0xC9], 10, 'такты RET');
  eq(C[0xE3], 18, 'такты XTHL');
  eq(C[0xEB], 4, 'такты XCHG');
  eq(C[0xC5], 11, 'такты PUSH');
  eq(C[0xC1], 10, 'такты POP');
  eq(C[0xDB], 10, 'такты IN');
  eq(C[0xC7], 11, 'такты RST');
}

/* ============ 8. Все 256 кодов исполняются без исключений ============ */
{
  let unknownReported = 0;
  for (let op = 0; op < 256; op++) {
    const { cpu } = makeCpu([0x31, 0x00, 0x40, op, 0x00, 0x00], 0);
    cpu.step();                       // LXI SP
    try {
      const t = cpu.step();
      if (typeof t !== 'number' || t <= 0) {
        fails++; console.log(`ПРОВАЛ  код ${op.toString(16)}: такты = ${t}`);
      }
      checks++;
    } catch (e) {
      fails++; checks++;
      console.log(`ПРОВАЛ  код ${op.toString(16)} выбросил исключение: ${e.message}`);
    }
    if (cpu.unknownOpcodes.size) unknownReported++;
  }
  eq(unknownReported, 12, 'число кодов, помеченных как недокументированные');
}

/* ============ 9. Дизассемблер ============ */
{
  const prog = [0x31, 0x00, 0x76, 0x21, 0xD0, 0x76, 0x36, 0x20, 0xC3, 0x09, 0xF8, 0x76];
  const read = (a) => prog[a] === undefined ? 0 : prog[a];
  const lines = Disassembler.disassembleRange(read, 0, 5);
  eq(lines[0].text, 'LXI SP,7600H', 'дизасм LXI SP');
  eq(lines[1].text, 'LXI H,76D0H', 'дизасм LXI H');
  eq(lines[2].text, 'MVI M,20H', 'дизасм MVI M');
  eq(lines[3].text, 'JMP F809H', 'дизасм JMP');
  eq(lines[4].text, 'HLT', 'дизасм HLT');
  // Длины команд должны совпадать с тем, что реально съедает процессор
  for (let op = 0; op < 256; op++) {
    const { cpu } = makeCpu([op, 0x00, 0x00], 0x100);
    cpu.step();
    let consumed = (cpu.pc - 0x100) & 0xFFFF;
    // У переходов PC уходит на цель — их проверяем отдельно по таблице
    const info = Disassembler.TABLE[op];
    const isJump = /^(\*?)(JMP|J|CALL|C|RET|R|RST|PCHL)/.test(info.m) &&
                   !/^(CMA|CMC|CMP)/.test(info.m);
    if (!isJump) {
      checks++;
      if (consumed !== info.n) {
        fails++;
        console.log(`ПРОВАЛ  длина команды ${op.toString(16)} (${info.m}): ` +
                    `процессор съел ${consumed}, таблица говорит ${info.n}`);
      }
    }
  }
}

/* ============ 10. Полная сборка машины: тестовое ПЗУ рисует строку ============ */
{
  const cfg = MACHINES.rk86;
  const bus = new Bus(cfg);
  bus.loadROM(DemoROM.build(cfg.romSize));
  bus.attach('ppi1', { read: () => 0xFF, write: () => {} });
  bus.attach('ppi2', { read: () => 0xFF, write: () => {} });
  bus.attach('crt', { read: () => 0xFF, write: () => {} });
  bus.attach('dma', { read: () => 0xFF, write: () => {} });
  bus.attach('timer', { read: () => 0xFF, write: () => {} });

  const cpu = new I8080(bus);
  cpu.reset(cfg.resetVector);

  let steps = 0;
  while (cpu.pc !== 0xF823 && steps < 200000) { cpu.step(); steps++; }
  eq(cpu.pc, 0xF823, 'тестовое ПЗУ дошло до конца');

  let text = '';
  for (let i = 0; i < DemoROM.MESSAGE.length; i++) {
    text += String.fromCharCode(bus.read(cfg.video.base + i));
  }
  eq(text, DemoROM.MESSAGE, 'строка попала в экранную область');
  eq(bus.read(cfg.video.base + 100), 0x20, 'остальной экран очищен пробелами');
  eq(bus.read(0xF800), 0x31, 'ПЗУ читается по своему адресу');
  bus.write(0xF800, 0x00);
  eq(bus.read(0xF800), 0x31, 'запись в ПЗУ игнорируется');

  console.log(`  (тестовое ПЗУ отработало за ${steps} команд, ${cpu.cycles} тактов)`);
}

/* ============ 11. Клавиатурная матрица через ВВ55 ============ */
{
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/devices/Keyboard.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/devices/I8255.js'), 'utf8'), sandbox);
  const kb = new sandbox.Keyboard(MACHINES.rk86.keyboard);
  const ppi = new sandbox.I8255('ppi1');
  ppi.keyboard = kb;
  // Управляющее слово: PA — выход, PB — вход, младшая половина PC — вход
  ppi.write(3, 0x8B);
  eq(ppi.dirA, false, 'PA настроен на вывод');
  eq(ppi.dirB, true, 'PB настроен на ввод');
  eq(ppi.dirCLow, true, 'младший PC настроен на ввод');
  eq(ppi.read(2) & 0x0F, 0x0F, 'без модификаторов младший PC в единицах');

  eq(kb.scanColumns(0x00), 0xFF, 'ничего не нажато — все столбцы в единицах');

  kb.pressCode(0x41);            // 'A' = 0x41 -> строка 4, столбец 1
  const pos = kb.positions.get(0x41);
  eq(pos[0], 4, "'A' строка"); eq(pos[1], 1, "'A' столбец");
  ppi.write(0, ~(1 << 4) & 0xFF);          // выбираем строку 4
  eq(ppi.read(1), (~(1 << 1)) & 0xFF, "'A' читается в порту B");
  ppi.write(0, ~(1 << 3) & 0xFF);          // другая строка
  eq(ppi.read(1), 0xFF, 'в другой строке ничего не нажато');
  kb.releaseCode(0x41);
  ppi.write(0, ~(1 << 4) & 0xFF);
  eq(ppi.read(1), 0xFF, 'после отпускания столбец свободен');

  // ВК (0x0D) — это СС + M, модификатор должен уйти в порт C
  eq((ppi.read(2) & MACHINES.rk86.keyboard.modCtrl) !== 0, true, 'до нажатия СС не активен');
  kb.pressCode(0x0D);
  eq((ppi.read(2) & MACHINES.rk86.keyboard.modCtrl), 0, 'СС активен при ВК');
  const posM = kb.positions.get(0x4D);
  ppi.write(0, ~(1 << posM[0]) & 0xFF);
  eq(ppi.read(1), (~(1 << posM[1])) & 0xFF, 'ВК замыкает позицию буквы M');
  kb.releaseCode(0x0D);

  // Кириллица требует РУС
  const r = kb.resolveCode(0x61);   // 'а' в КОИ-7
  eq(r.rus, true, 'кириллица помечена как РУС');
  eq(kb.positions.has(0x41), true, 'позиция латинской A существует');
}

/* ============ 12. Контроллер ПДП отдаёт адрес экрана ============ */
{
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/devices/I8257.js'), 'utf8'), sandbox);
  const dma = new sandbox.I8257();
  eq(dma.getDisplayAddress(), null, 'до программирования адрес неизвестен');
  dma.write(4, 0xD0);       // канал 2, младший байт адреса
  dma.write(4, 0x76);       // старший байт
  dma.write(8, 0x04);       // разрешаем канал 2
  eq(dma.getDisplayAddress(), 0x76D0, 'адрес экрана прочитан из канала 2');
}

/* ============ 13. Скорость ============ */
{
  const { cpu } = makeCpu([0x00, 0x00, 0x00, 0xC3, 0x00, 0x00], 0);
  const t0 = Date.now();
  let n = 0;
  while (n < 5e6) { cpu.step(); n++; }
  const dt = (Date.now() - t0) / 1000;
  console.log(`  (${(n / dt / 1e6).toFixed(1)} млн команд/с — номинал машины 1.78 МГц)`);
}

console.log(`\n${checks - fails} из ${checks} проверок пройдено` +
            (fails ? `, ПРОВАЛОВ: ${fails}` : ''));
process.exit(fails ? 1 : 0);
