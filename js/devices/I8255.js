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

      /* Трассировка обращений — нужна, чтобы понять, как именно монитор из
       * настоящего ПЗУ опрашивает клавиатуру. Хранится в кольцевом буфере на
       * типизированных массивах: на частоте опроса создавать объекты нельзя. */
      this.traceSize = 256;
      this.traceOp = new Uint8Array(this.traceSize);     // 0 — чтение, 1 — запись
      this.tracePort = new Uint8Array(this.traceSize);
      this.traceValue = new Uint8Array(this.traceSize);
      this.tracePos = 0;
      this.traceCount = 0;
      this.counters = { readA: 0, readB: 0, readC: 0, writeA: 0, writeB: 0, writeC: 0, ctrl: 0 };

      this.reset();
    }

    record(op, port, value) {
      this.traceOp[this.tracePos] = op;
      this.tracePos = (this.tracePos + 1) & (this.traceSize - 1);
      this.traceCount++;
      const p = (this.tracePos - 1) & (this.traceSize - 1);
      this.tracePort[p] = port;
      this.traceValue[p] = value;
    }

    /** Журнал последних обращений, от старых к новым */
    getTrace(limit) {
      const names = ['A', 'B', 'C', 'УПР'];
      const n = Math.min(limit || this.traceSize, this.traceCount, this.traceSize);
      const out = [];
      for (let i = n; i > 0; i--) {
        const p = (this.tracePos - i + this.traceSize) & (this.traceSize - 1);
        out.push({
          op: this.traceOp[p] ? 'запись' : 'чтение',
          port: names[this.tracePort[p] & 3],
          value: this.traceValue[p]
        });
      }
      return out;
    }

    clearTrace() {
      this.tracePos = 0;
      this.traceCount = 0;
      for (const k in this.counters) this.counters[k] = 0;
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
      const port = off & 3;
      let v;
      switch (port) {
        case PORT_A:
          // Обратный опрос: если PA настроен на ввод, читаем строки по столбцам
          v = (this.dirA && this.keyboard) ? this.keyboard.scanRows(this.latchB) : this.latchA;
          this.counters.readA++;
          break;

        case PORT_B:
          // Основной путь: строка выбрана через PA, читаем состояние столбцов
          v = (this.dirB && this.keyboard) ? this.keyboard.scanColumns(this.latchA) : this.latchB;
          this.counters.readB++;
          break;

        case PORT_C:
          v = this.latchC;
          if (this.dirCLow && this.keyboard) {
            v = (v & 0xF0) | (this.keyboard.readModifiers() & 0x0F);
          }
          v &= 0xFF;
          this.counters.readC++;
          break;

        default:
          v = this.control;
          break;
      }
      this.record(0, port, v);
      return v;
    }

    write(off, value) {
      value &= 0xFF;
      const port = off & 3;
      this.record(1, port, value);
      switch (port) {
        case PORT_A: this.latchA = value; this.counters.writeA++; break;
        case PORT_B: this.latchB = value; this.counters.writeB++; break;
        case PORT_C:
          this.latchC = value;
          this.tapeOut = (value >> 4) & 0x0F;
          this.counters.writeC++;
          break;
        case PORT_CTRL: this.setControl(value); this.counters.ctrl++; break;
      }
    }
  }

  global.I8255 = I8255;

})(window);
