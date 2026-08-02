/*
 * Панель диагностики клавиатуры.
 *
 * Отвечает на единственный вопрос, который возникает при подключении
 * настоящего ПЗУ: «монитор вообще опрашивает клавиатуру, и если да, то как?»
 *
 *   * счётчик опросов в секунду — видно, идёт ли сканирование;
 *   * управляющее слово и направления портов ВВ55 — видно, как монитор
 *     настроил микросхему (и совпадает ли это с нашими ожиданиями);
 *   * живая матрица 8x8 — подсвечивается выбранная монитором строка и
 *     нажатые клавиши, то есть сразу видно, попадает ли опрос в нужную строку;
 *   * переключатели полярности — четыре сочетания перебираются на ходу.
 */
(function (global) {
  'use strict';

  const hex = Disassembler.hex;

  class KeyboardPanel {
    constructor(elements) {
      this.el = elements;
      this.machine = null;
      this.cells = [];
      this.lastUpdate = 0;
      this.lastScans = 0;
      this.lastRateTime = 0;
      this.scanRate = 0;
      this.buildMatrix();
      this.bindControls();
    }

    attach(machine) {
      this.machine = machine;
      const kb = machine.keyboard;
      this.el.polScan.checked = kb.scanActiveLow;
      this.el.polReturn.checked = kb.returnActiveLow;
      this.el.polMod.checked = kb.modActiveLow;
      this.lastScans = 0;
      this.lastRateTime = performance.now();
      this.update(true);
    }

    /** Сетка 8x8: строка матрицы — строка таблицы, столбец — столбец */
    buildMatrix() {
      const grid = this.el.kbMatrix;
      grid.innerHTML = '';
      this.cells = [];
      for (let row = 0; row < 8; row++) {
        const line = [];
        for (let col = 0; col < 8; col++) {
          const cell = document.createElement('div');
          cell.className = 'kb-cell';
          grid.appendChild(cell);
          line.push(cell);
        }
        this.cells.push(line);
      }
    }

    bindControls() {
      const self = this;

      const apply = function () {
        if (!self.machine) return;
        const kb = self.machine.keyboard;
        kb.scanActiveLow = self.el.polScan.checked;
        kb.returnActiveLow = self.el.polReturn.checked;
        kb.modActiveLow = self.el.polMod.checked;
        self.update(true);
      };
      this.el.polScan.addEventListener('change', apply);
      this.el.polReturn.addEventListener('change', apply);
      this.el.polMod.addEventListener('change', apply);

      this.el.btnKbTrace.addEventListener('click', function () {
        self.dumpTrace();
      });
      this.el.btnKbClear.addEventListener('click', function () {
        if (self.machine) self.machine.ppi1.clearTrace();
        self.update(true);
      });
    }

    /** Журнал обращений к ВВ55 в консоль — его удобно скопировать и прислать */
    dumpTrace() {
      if (!this.machine) return;
      const ppi = this.machine.ppi1;
      const trace = ppi.getTrace(120);
      const c = ppi.counters;

      console.group('[ВВ55] Журнал обращений к клавиатуре');
      console.log('Управляющее слово: ' + hex(ppi.control, 2) +
        '  (PA ' + (ppi.dirA ? 'ввод' : 'вывод') +
        ', PB ' + (ppi.dirB ? 'ввод' : 'вывод') +
        ', PC мл. ' + (ppi.dirCLow ? 'ввод' : 'вывод') + ')');
      console.log('Обращений: записей в PA ' + c.writeA + ', чтений PB ' + c.readB +
        ', чтений PC ' + c.readC + ', управляющих слов ' + c.ctrl);
      console.log('Опросов матрицы: ' + this.machine.keyboard.stats.scans);
      if (!trace.length) {
        console.log('Журнал пуст — монитор к ВВ55 не обращался.');
      } else {
        console.table(trace.map(function (e) {
          return { Операция: e.op, Порт: e.port, Значение: hex(e.value, 2) };
        }));
      }
      console.groupEnd();
    }

    update(force) {
      if (!this.machine) return;
      const now = performance.now();
      if (!force && now - this.lastUpdate < 100) return;
      this.lastUpdate = now;

      const m = this.machine;
      const kb = m.keyboard;
      const ppi = m.ppi1;
      const el = this.el;

      // Частота опроса — главный признак того, что монитор жив и сканирует
      const dt = now - this.lastRateTime;
      if (dt >= 500) {
        this.scanRate = Math.round(1000 * (kb.stats.scans - this.lastScans) / dt);
        this.lastScans = kb.stats.scans;
        this.lastRateTime = now;
      }

      el.kbScanRate.textContent = this.scanRate + ' /с';
      el.kbScanRate.parentElement.classList.toggle('warn', this.scanRate === 0);

      el.kbControl.textContent = hex(ppi.control, 2) + 'H';
      el.kbDirs.textContent =
        'PA ' + (ppi.dirA ? 'вх' : 'вых') +
        ', PB ' + (ppi.dirB ? 'вх' : 'вых') +
        ', PC ' + (ppi.dirCLow ? 'вх' : 'вых');
      el.kbLastScan.textContent = hex(kb.stats.lastRowSelect, 2) + 'H';
      el.kbLastCols.textContent = hex(kb.stats.lastColumns, 2) + 'H';
      el.kbMods.textContent =
        (kb.shift ? 'УС ' : '') + (kb.ctrl ? 'СС ' : '') + (kb.rus ? 'РУС' : '') || '—';

      // Живая матрица: подсветка выбранной строки и нажатых клавиш
      const sel = kb.stats.lastRowSelect;
      for (let row = 0; row < 8; row++) {
        const bit = (sel & (1 << row)) !== 0;
        const selected = kb.scanActiveLow ? !bit : bit;
        for (let col = 0; col < 8; col++) {
          const cell = this.cells[row][col];
          const pressed = (kb.rows[row] & (1 << col)) !== 0;
          const code = kb.matrix[row][col];
          const label = (code >= 0x21 && code <= 0x5F) ? String.fromCharCode(code) :
                        (code === 0x20 ? '␣' : hex(code, 2));
          if (cell.textContent !== label) cell.textContent = label;
          cell.classList.toggle('sel', selected);
          cell.classList.toggle('down', pressed);
        }
      }
    }
  }

  global.KeyboardPanel = KeyboardPanel;

})(window);
