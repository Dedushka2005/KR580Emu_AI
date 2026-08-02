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

  /*
   * Второе тестовое ПЗУ: опрос клавиатуры так, как это делает монитор.
   *
   * Нужно, чтобы отделить неисправность тракта «ВВ55 — матрица» от несовпадения
   * раскладки с настоящим ПЗУ. Программа настраивает ВВ55, ищет нажатую клавишу
   * перебором строк, вычисляет код как 20H + строка*8 + столбец и выводит его в
   * левый верхний угол экрана. Если здесь символы появляются, а монитор из
   * настоящего ПЗУ молчит — значит расходятся раскладка или полярность сигналов.
   *
   *   F800  21 D0 76     LXI  H,76D0H     ; очистка экрана
   *   F803  01 40 06     LXI  B,0640H
   *   F806  36 20   CLR: MVI  M,20H
   *   F808  23           INX  H
   *   F809  0B           DCX  B
   *   F80A  78           MOV  A,B
   *   F80B  B1           ORA  C
   *   F80C  C2 06 F8     JNZ  CLR
   *   F80F  3E 8B        MVI  A,8BH       ; PA — вывод, PB и младший PC — ввод
   *   F811  32 03 80     STA  8003H
   *   F814  AF     LOOP: XRA  A           ; выбрать сразу все строки
   *   F815  32 00 80     STA  8000H
   *   F818  3A 01 80     LDA  8001H       ; есть ли хоть одно нажатие?
   *   F81B  2F           CMA
   *   F81C  A7           ANA  A
   *   F81D  CA 14 F8     JZ   LOOP
   *   F820  06 00        MVI  B,00H       ; B — номер строки
   *   F822  0E FE        MVI  C,FEH       ; C — маска строки
   *   F824  79     ROW:  MOV  A,C
   *   F825  32 00 80     STA  8000H
   *   F828  3A 01 80     LDA  8001H
   *   F82B  2F           CMA
   *   F82C  A7           ANA  A
   *   F82D  C2 3D F8     JNZ  FOUND
   *   F830  79           MOV  A,C         ; следующая строка
   *   F831  07           RLC
   *   F832  4F           MOV  C,A
   *   F833  04           INR  B
   *   F834  78           MOV  A,B
   *   F835  FE 08        CPI  08H
   *   F837  C2 24 F8     JNZ  ROW
   *   F83A  C3 14 F8     JMP  LOOP
   *   F83D  4F    FOUND: MOV  C,A         ; A — маска столбцов
   *   F83E  16 00        MVI  D,00H       ; D — номер столбца
   *   F840  79     COL:  MOV  A,C
   *   F841  0F           RRC
   *   F842  4F           MOV  C,A
   *   F843  DA 50 F8     JC   GOT
   *   F846  14           INR  D
   *   F847  7A           MOV  A,D
   *   F848  FE 08        CPI  08H
   *   F84A  C2 40 F8     JNZ  COL
   *   F84D  C3 14 F8     JMP  LOOP
   *   F850  78     GOT:  MOV  A,B         ; код = 20H + строка*8 + столбец
   *   F851  87           ADD  A
   *   F852  87           ADD  A
   *   F853  87           ADD  A
   *   F854  82           ADD  D
   *   F855  C6 20        ADI  20H
   *   F857  32 D0 76     STA  76D0H
   *   F85A  C3 14 F8     JMP  LOOP
   */
  const KEYTEST = [
    0x21, 0xD0, 0x76, 0x01, 0x40, 0x06, 0x36, 0x20, 0x23, 0x0B, 0x78, 0xB1,
    0xC2, 0x06, 0xF8, 0x3E, 0x8B, 0x32, 0x03, 0x80,
    0xAF, 0x32, 0x00, 0x80, 0x3A, 0x01, 0x80, 0x2F, 0xA7, 0xCA, 0x14, 0xF8,
    0x06, 0x00, 0x0E, 0xFE,
    0x79, 0x32, 0x00, 0x80, 0x3A, 0x01, 0x80, 0x2F, 0xA7, 0xC2, 0x3D, 0xF8,
    0x79, 0x07, 0x4F, 0x04, 0x78, 0xFE, 0x08, 0xC2, 0x24, 0xF8, 0xC3, 0x14, 0xF8,
    0x4F, 0x16, 0x00,
    0x79, 0x0F, 0x4F, 0xDA, 0x50, 0xF8, 0x14, 0x7A, 0xFE, 0x08, 0xC2, 0x40, 0xF8,
    0xC3, 0x14, 0xF8,
    0x78, 0x87, 0x87, 0x87, 0x82, 0xC6, 0x20, 0x32, 0xD0, 0x76, 0xC3, 0x14, 0xF8
  ];

  function buildKeyboardTest(size) {
    const rom = new Uint8Array(size || 0x800);
    rom.fill(0x76);
    rom.set(KEYTEST, 0);
    return rom;
  }

  global.DemoROM = {
    build: build,
    buildKeyboardTest: buildKeyboardTest,
    CODE: CODE,
    KEYTEST: KEYTEST,
    MESSAGE: MESSAGE
  };

})(window);
