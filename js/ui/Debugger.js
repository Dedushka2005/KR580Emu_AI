/*
 * Окна отладчика: регистры с флагами и бегущий дизассемблер.
 *
 * В окне дизассемблера показываются две уже выполненные команды (берутся из
 * истории машины), текущая — та, которую процессор выполнит следующим шагом, —
 * и семь предстоящих. Предстоящие разбираются «вперёд» от текущего адреса;
 * если поток команд разойдётся с данными, картина восстановится на ближайшем
 * шаге, поскольку окно перестраивается заново каждый раз.
 *
 * Пока машина работает, обновление ограничено 20 кадрами в секунду: чаще
 * бессмысленно, а разметку перестраивать дорого.
 */
(function (global) {
  'use strict';

  const PAST = 2, FUTURE = 7;
  const hex = Disassembler.hex;

  class Debugger {
    constructor(elements) {
      this.el = elements;
      this.lastUpdate = 0;
      this.minInterval = 50;      // мс между обновлениями при работе
      this.machine = null;
    }

    attach(machine) {
      this.machine = machine;
      this.forceUpdate();
    }

    forceUpdate() {
      this.lastUpdate = 0;
      this.update();
    }

    update() {
      if (!this.machine) return;
      const now = performance.now();
      if (this.machine.running && now - this.lastUpdate < this.minInterval) return;
      this.lastUpdate = now;

      this.renderRegisters();
      this.renderDisassembly();
      this.renderStatus();
    }

    /* --- Регистры и флаги --------------------------------------------------- */

    renderRegisters() {
      const s = this.machine.cpu.getState();
      const el = this.el;

      el.regA.textContent = hex(s.a, 2);
      el.regBC.textContent = hex(s.bc, 4);
      el.regDE.textContent = hex(s.de, 4);
      el.regHL.textContent = hex(s.hl, 4);
      el.regSP.textContent = hex(s.sp, 4);
      el.regPC.textContent = hex(s.pc, 4);
      el.regF.textContent = hex(s.f, 2);
      el.regM.textContent = hex(this.machine.bus.peek(s.hl), 2);

      this.setFlag(el.flagS, s.fs);
      this.setFlag(el.flagZ, s.fz);
      this.setFlag(el.flagA, s.fa);
      this.setFlag(el.flagP, s.fp);
      this.setFlag(el.flagC, s.fc);
      this.setFlag(el.flagI, s.ime ? 1 : 0);

      el.cycles.textContent = s.cycles.toLocaleString('ru-RU');
      el.instructions.textContent = s.instructions.toLocaleString('ru-RU');
    }

    setFlag(node, value) {
      node.classList.toggle('on', !!value);
      node.dataset.value = value ? '1' : '0';
    }

    /* --- Дизассемблер --------------------------------------------------------- */

    renderDisassembly() {
      const m = this.machine;
      const bus = m.bus;
      const read = function (a) { return bus.peek(a); };
      const pc = m.cpu.pc;
      const rows = [];

      // Выполненные команды
      const past = m.getHistory(PAST);
      for (const addr of past) {
        rows.push(this.row(Disassembler.disassemble(read, addr), 'past', addr));
      }
      // Дополняем пустыми строками, чтобы окно не «прыгало» после сброса
      for (let i = past.length; i < PAST; i++) rows.unshift(this.emptyRow());

      // Текущая и предстоящие
      const ahead = Disassembler.disassembleRange(read, pc, FUTURE + 1);
      for (let i = 0; i < ahead.length; i++) {
        rows.push(this.row(ahead[i], i === 0 ? 'current' : 'next', ahead[i].addr));
      }

      this.el.disasm.innerHTML = rows.join('');
    }

    row(line, cls, addr) {
      const bp = this.machine.breakpoints[addr] ? ' bp' : '';
      const marker = cls === 'current' ? '&gt;' : (cls === 'past' ? '&middot;' : '&nbsp;');
      const bytes = line.bytes.map(function (b) { return hex(b, 2); }).join(' ');
      return '<div class="dis-row ' + cls + bp + '" data-addr="' + addr + '">' +
        '<span class="dis-mark">' + marker + '</span>' +
        '<span class="dis-addr">' + hex(line.addr, 4) + '</span>' +
        '<span class="dis-bytes">' + bytes + '</span>' +
        '<span class="dis-text">' + this.escape(line.text) + '</span>' +
        '</div>';
    }

    emptyRow() {
      return '<div class="dis-row empty">' +
        '<span class="dis-mark">&nbsp;</span>' +
        '<span class="dis-addr">----</span>' +
        '<span class="dis-bytes"></span>' +
        '<span class="dis-text"></span></div>';
    }

    escape(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /* --- Строка состояния ------------------------------------------------------ */

    renderStatus() {
      const m = this.machine;
      const v = m.video.getInfo();
      const el = this.el;

      el.stateBadge.textContent = m.cpu.halted ? 'ОСТАНОВ (HLT)' :
        (m.running ? 'РАБОТА' : 'ПАУЗА');
      el.stateBadge.className = 'badge ' + (m.cpu.halted ? 'halt' :
        (m.running ? 'run' : 'pause'));

      el.speed.textContent = m.running ? m.speedPercent + '%' : '—';
      el.videoBase.textContent = hex(v.base, 4);
      el.videoFormat.textContent = v.cols + 'x' + v.rows + ' (' + v.pixels + ' точек)';

      if (m.cpu.unknownOpcodes.size > 0) {
        const parts = [];
        m.cpu.unknownOpcodes.forEach(function (count, op) {
          parts.push(hex(op, 2) + '(' + count + ')');
        });
        el.unknown.textContent = parts.join(' ');
        el.unknown.parentElement.classList.add('warn');
      } else {
        el.unknown.textContent = 'нет';
        el.unknown.parentElement.classList.remove('warn');
      }
    }
  }

  global.Debugger = Debugger;

})(window);
