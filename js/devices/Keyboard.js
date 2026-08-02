/*
 * Клавиатура: матрица 8x8 + перевод нажатий браузера в позиции матрицы.
 *
 * Состояние хранится как восемь байтов — по одному на строку, бит = столбец,
 * 1 означает «клавиша нажата». Наружу отдаётся в инверсии, потому что
 * на реальной машине замкнутая клавиша притягивает линию к нулю.
 *
 * Клавиши, которых на матрице нет как отдельных (ВК, ПС, стрелки, ЗБ),
 * получаются комбинацией СС + буква — ровно так, как это делает оператор
 * на настоящем РК-86.
 */
(function (global) {
  'use strict';

  class Keyboard {
    /**
     * @param {object} cfg  описание из конфигурации машины (machine.keyboard)
     */
    constructor(cfg) {
      this.cfg = cfg;
      this.matrix = cfg.matrix;
      this.keymap = cfg.keymap;

      // code -> [row, col] для быстрого поиска позиции
      this.positions = new Map();
      for (let row = 0; row < this.matrix.length; row++) {
        for (let col = 0; col < this.matrix[row].length; col++) {
          const code = this.matrix[row][col];
          if (code !== null && code !== undefined && !this.positions.has(code)) {
            this.positions.set(code, [row, col]);
          }
        }
      }

      this.rows = new Uint8Array(8);
      this.shift = false;   // УС
      this.ctrl = false;    // СС
      this.rus = false;     // РУС/ЛАТ (переключатель, фиксируется)

      // Что именно зажато с точки зрения браузера: event.code -> [row,col]
      this.held = new Map();
      this.lastKeyInfo = '';
    }

    reset() {
      this.rows.fill(0);
      this.held.clear();
      this.shift = this.ctrl = false;
    }

    /* --- Опрос со стороны ВВ55 --------------------------------------------- */

    /** Выбраны строки нулями в rowSelect, возвращаем столбцы (0 = нажато) */
    scanColumns(rowSelect) {
      let cols = 0;
      for (let row = 0; row < 8; row++) {
        if ((rowSelect & (1 << row)) === 0) cols |= this.rows[row];
      }
      return (~cols) & 0xFF;
    }

    /** Обратный опрос: выбраны столбцы, возвращаем строки (0 = нажато) */
    scanRows(colSelect) {
      let out = 0;
      for (let row = 0; row < 8; row++) {
        if (this.rows[row] & (~colSelect & 0xFF)) out |= (1 << row);
      }
      return (~out) & 0xFF;
    }

    /** Модификаторы в младших битах порта C, активный уровень низкий */
    readModifiers() {
      let v = 0x0F;
      if (this.shift) v &= ~this.cfg.modShift;
      if (this.ctrl) v &= ~this.cfg.modCtrl;
      if (this.rus) v &= ~this.cfg.modRus;
      return v & 0x0F;
    }

    /* --- Нажатия ------------------------------------------------------------ */

    /**
     * Приводит код КОИ-7 к позиции матрицы.
     * Управляющие коды (<0x20) — это СС + соответствующая буква,
     * кириллица (>=0x60) — РУС + латинская позиция.
     * @returns {{pos:[number,number], ctrl:boolean, rus:boolean}|null}
     */
    resolveCode(code) {
      let ctrl = false, rus = false, base = code;
      if (code < 0x20) { ctrl = true; base = code + 0x40; }
      else if (code >= 0x60) { rus = true; base = code - 0x20; }
      const pos = this.positions.get(base);
      if (!pos) return null;
      return { pos: pos, ctrl: ctrl, rus: rus };
    }

    /** Нажать клавишу по коду КОИ-7 (для экранной клавиатуры и вставки текста) */
    pressCode(code) {
      const r = this.resolveCode(code);
      if (!r) return false;
      if (r.ctrl) this.ctrl = true;
      this.rows[r.pos[0]] |= (1 << r.pos[1]);
      return true;
    }

    releaseCode(code) {
      const r = this.resolveCode(code);
      if (!r) return false;
      if (r.ctrl) this.ctrl = false;
      this.rows[r.pos[0]] &= ~(1 << r.pos[1]) & 0xFF;
      return true;
    }

    /* --- События браузера ---------------------------------------------------- */

    /** @returns true, если клавиша обработана (событие стоит погасить) */
    keyDown(e) {
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { this.shift = true; return true; }
      if (e.code === 'ControlLeft' || e.code === 'ControlRight') { this.ctrl = true; return true; }
      // РУС/ЛАТ — переключатель с фиксацией
      if (e.code === 'AltLeft' || e.code === 'AltRight' || e.code === 'CapsLock') {
        if (!e.repeat) this.rus = !this.rus;
        return true;
      }

      let code = this.keymap[e.code];
      if (code === undefined) return false;
      if (Array.isArray(code)) code = code[0];   // позиция матрицы — по базовому коду

      const r = this.resolveCode(code);
      if (!r) return false;

      if (r.ctrl) this.ctrl = true;
      this.rows[r.pos[0]] |= (1 << r.pos[1]);
      this.held.set(e.code, r);
      this.lastKeyInfo = e.code + ' -> ' + this.describeCode(code) +
        ' [строка ' + r.pos[0] + ', столбец ' + r.pos[1] + ']';
      return true;
    }

    keyUp(e) {
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { this.shift = false; return true; }
      if (e.code === 'ControlLeft' || e.code === 'ControlRight') { this.ctrl = false; return true; }
      if (e.code === 'AltLeft' || e.code === 'AltRight' || e.code === 'CapsLock') return true;

      const r = this.held.get(e.code);
      if (!r) return false;
      this.held.delete(e.code);
      this.rows[r.pos[0]] &= ~(1 << r.pos[1]) & 0xFF;
      if (r.ctrl && !this.anyHeldCtrl()) this.ctrl = false;
      return true;
    }

    anyHeldCtrl() {
      for (const r of this.held.values()) if (r.ctrl) return true;
      return false;
    }

    describeCode(code) {
      const names = {
        0x08: '<-', 0x09: 'ТАБ', 0x0A: 'ПС', 0x0C: 'СТР', 0x0D: 'ВК',
        0x18: '->', 0x19: '^', 0x1A: 'v', 0x1B: 'ESC', 0x1F: 'ЗБ', 0x20: 'ПРОБЕЛ'
      };
      if (names[code]) return names[code];
      if (code >= 0x21 && code <= 0x5F) return "'" + String.fromCharCode(code) + "'";
      return '0x' + code.toString(16).toUpperCase().padStart(2, '0');
    }
  }

  global.Keyboard = Keyboard;

})(window);
