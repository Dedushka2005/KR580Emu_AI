/*
 * Тестовое ПЗУ (ЗАГЛУШКА, не Монитор РК-86).
 *
 * Настоящий монитор — объект авторского права журнала «Радио», в комплект не
 * входит. Чтобы эмулятор было чем проверить сразу после открытия index.html,
 * здесь лежит крошечная программа, написанная вручную: она очищает экранную
 * область и печатает строку. На ней удобно посмотреть, как работают окно
 * дизассемблера, счётчик тактов и пошаговое выполнение.
 *
 * Настоящее ПЗУ загружается кнопкой «ПЗУ» и полностью замещает эту заглушку.
 *
 *   F800  31 00 76     LXI  SP,7600H    ; стек под экраном
 *   F803  21 D0 76     LXI  H,76D0H     ; начало экранной области
 *   F806  01 40 06     LXI  B,0640H     ; 1600 знакомест (64x25)
 *   F809  36 20   CLR: MVI  M,20H       ; заполняем пробелами
 *   F80B  23           INX  H
 *   F80C  0B           DCX  B
 *   F80D  78           MOV  A,B
 *   F80E  B1           ORA  C
 *   F80F  C2 09 F8     JNZ  CLR
 *   F812  21 D0 76     LXI  H,76D0H
 *   F815  11 26 F8     LXI  D,MSG
 *   F818  1A     PRT:  LDAX D
 *   F819  B7           ORA  A
 *   F81A  CA 23 F8     JZ   DONE
 *   F81D  77           MOV  M,A
 *   F81E  23           INX  H
 *   F81F  13           INX  D
 *   F820  C3 18 F8     JMP  PRT
 *   F823  C3 23 F8 DONE:JMP DONE        ; вечный цикл
 *   F826  MSG: строка, оканчивающаяся нулём
 */
(function (global) {
  'use strict';

  const CODE = [
    0x31, 0x00, 0x76,
    0x21, 0xD0, 0x76,
    0x01, 0x40, 0x06,
    0x36, 0x20,
    0x23,
    0x0B,
    0x78,
    0xB1,
    0xC2, 0x09, 0xF8,
    0x21, 0xD0, 0x76,
    0x11, 0x26, 0xF8,
    0x1A,
    0xB7,
    0xCA, 0x23, 0xF8,
    0x77,
    0x23,
    0x13,
    0xC3, 0x18, 0xF8,
    0xC3, 0x23, 0xF8
  ];

  const MESSAGE = '* RADIO-86RK EMULATOR *';

  /**
   * Собирает образ ПЗУ заданного размера.
   * @param {number} size размер области ПЗУ (для РК-86 — 2048 байт)
   */
  function build(size) {
    const rom = new Uint8Array(size || 0x800);
    rom.fill(0x76);                       // незанятое место — HLT, чтобы «убежавший»
                                          // процессор сразу останавливался
    rom.set(CODE, 0);
    let p = CODE.length;                  // 0x26 от начала ПЗУ
    for (let i = 0; i < MESSAGE.length; i++) rom[p++] = MESSAGE.charCodeAt(i);
    rom[p] = 0x00;
    return rom;
  }

  global.DemoROM = { build: build, CODE: CODE, MESSAGE: MESSAGE };

})(window);
