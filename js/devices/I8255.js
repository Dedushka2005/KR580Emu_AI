/*
 * КР580ВВ55 (Intel 8255) — параллельный интерфейс.
 *
 * На РК-86 к первой микросхеме подключена клавиатура:
 *   PA — выход, выбор строки матрицы (активный уровень низкий);
 *   PB — вход, чтение столбцов (нажатая клавиша даёт 0);
 *   PC(0..3) — вход, модификаторы УС / СС / РУС-ЛАТ;
 *   PC(4..7) — выход, магнитофон и звук.
 *
 * Реализован режим 0 (простой ввод-вывод) — единственный, который использует
 * монитор. Управляющее слово запоминается, направления портов учитываются.
 */
(function (global) {
  'use strict';

  const PORT_A = 0, PORT_B = 1, PORT_C = 2, PORT_CTRL = 3;

  class I8255 {
    constructor(name) {
      this.name = name || 'ppi';
      this.keyboard = null;      // подключается снаружи
      this.tapeOut = 0;          // старшие биты порта C (магнитофон/звук)
      this.reset();
    }

    reset() {
      this.control = 0x9B;       // после сброса все порты — на ввод
      this.latchA = 0xFF;
      this.latchB = 0xFF;
      this.latchC = 0xFF;
      this.dirA = true;          // true = вход
      this.dirB = true;
      this.dirCLow = true;
      this.dirCHigh = true;
    }

    setControl(v) {
      this.control = v & 0xFF;
      if (v & 0x80) {
        // Задание режима
        this.dirA = !!(v & 0x10);
        this.dirCHigh = !!(v & 0x08);
        this.dirB = !!(v & 0x02);
        this.dirCLow = !!(v & 0x01);
        this.latchA = 0;
        this.latchB = 0;
        this.latchC = 0;
      } else {
        // Установка/сброс отдельного бита порта C
        const bit = (v >> 1) & 7;
        if (v & 1) this.latchC |= (1 << bit);
        else this.latchC &= ~(1 << bit) & 0xFF;
        this.tapeOut = (this.latchC >> 4) & 0x0F;
      }
    }

    read(off) {
      switch (off & 3) {
        case PORT_A:
          // Обратный опрос: если PA настроен на ввод, читаем строки по столбцам
          if (this.dirA && this.keyboard) return this.keyboard.scanRows(this.latchB);
          return this.latchA;

        case PORT_B:
          // Основной путь: строка выбрана через PA, читаем состояние столбцов
          if (this.dirB && this.keyboard) return this.keyboard.scanColumns(this.latchA);
          return this.latchB;

        case PORT_C: {
          let v = this.latchC;
          if (this.dirCLow && this.keyboard) {
            v = (v & 0xF0) | (this.keyboard.readModifiers() & 0x0F);
          }
          return v & 0xFF;
        }

        case PORT_CTRL:
          return this.control;
      }
      return 0xFF;
    }

    write(off, value) {
      value &= 0xFF;
      switch (off & 3) {
        case PORT_A: this.latchA = value; break;
        case PORT_B: this.latchB = value; break;
        case PORT_C:
          this.latchC = value;
          this.tapeOut = (value >> 4) & 0x0F;
          break;
        case PORT_CTRL: this.setControl(value); break;
      }
    }
  }

  global.I8255 = I8255;

})(window);
