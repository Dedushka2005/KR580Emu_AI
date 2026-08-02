/*
 * Машина целиком: собирает процессор, шину, устройства и видео в одно целое
 * и управляет ходом времени.
 *
 * Модель времени простая и достаточная: кадр длится cpuFreq / fps тактов,
 * процессор крутится, пока не выберет этот бюджет, затем перерисовывается
 * экран. Реальная скорость подстраивается по часам браузера, поэтому эмулятор
 * не убегает вперёд на быстрой машине.
 */
(function (global) {
  'use strict';

  const HISTORY_SIZE = 16;

  class Machine {
    /**
     * @param {object} config описание машины из MACHINES
     * @param {HTMLCanvasElement} canvas экран
     */
    constructor(config, canvas) {
      this.config = config;
      this.canvas = canvas;

      this.bus = new Bus(config);
      this.cpu = new I8080(this.bus);

      // Периферия
      this.ppi1 = new I8255('ppi1');
      this.ppi2 = new I8255('ppi2');
      this.crt = new I8275(config.video);
      this.dma = new I8257();
      this.keyboard = new Keyboard(config.keyboard);

      this.ppi1.keyboard = this.keyboard;

      this.bus.attach('ppi1', this.ppi1);
      this.bus.attach('ppi2', this.ppi2);
      this.bus.attach('crt', this.crt);
      this.bus.attach('dma', this.dma);
      this.bus.attach('timer', { read: function () { return 0xFF; }, write: function () {} });

      // Видео
      this.charGen = new CharGen(config.charGen, config.video);
      this.charGen.buildFallback(config.charsetCyrillic);
      this.video = new Video(canvas, this.bus, this.charGen, config.video);
      this.video.crt = this.crt;
      this.video.dma = this.dma;

      // Состояние выполнения
      this.running = false;
      this.cyclesPerFrame = Math.round(config.cpuFreq / config.framesPerSecond);
      this.lastTime = 0;
      this.rafId = 0;
      this.frameCycles = 0;

      // Точки останова: массив флагов быстрее множества при опросе на каждой команде
      this.breakpoints = new Uint8Array(0x10000);
      this.breakpointCount = 0;

      // Кольцевой буфер выполненных адресов — для окна дизассемблера
      this.history = new Uint16Array(HISTORY_SIZE);
      this.historyPos = 0;
      this.historyLen = 0;

      // Измерение реальной скорости
      this.speedCycles = 0;
      this.speedTime = 0;
      this.speedPercent = 0;

      this.romName = 'встроенное тестовое';
      this.onFrame = null;      // колбэк для интерфейса
      this.onBreak = null;      // сработала точка останова / HLT

      this.loadROM(DemoROM.build(config.romSize), 'встроенное тестовое');
      this.reset();
    }

    /* --- Загрузка образов --------------------------------------------------- */

    loadROM(bytes, name) {
      const size = this.bus.loadROM(bytes);
      this.romName = name || 'без имени';
      console.info('[машина] ПЗУ загружено: ' + this.romName + ', ' + size + ' байт');
      return size;
    }

    loadCharGen(bytes, name) {
      const count = this.charGen.load(bytes, name);
      console.info('[машина] Знакогенератор загружен: ' + count + ' знаков');
      this.video.render();
      return count;
    }

    /* --- Управление --------------------------------------------------------- */

    reset() {
      this.pause();
      this.bus.clearRAM();
      this.ppi1.reset();
      this.ppi2.reset();
      this.crt.reset();
      this.dma.reset();
      this.keyboard.reset();
      this.cpu.reset(this.config.resetVector);
      this.historyLen = 0;
      this.historyPos = 0;
      this.frameCycles = 0;
      this.video.clear();
      this.video.render();
    }

    /** Одна инструкция. Возвращает число потраченных тактов. */
    step() {
      this.history[this.historyPos] = this.cpu.pc;
      this.historyPos = (this.historyPos + 1) & (HISTORY_SIZE - 1);
      if (this.historyLen < HISTORY_SIZE) this.historyLen++;
      return this.cpu.step();
    }

    /** Один шаг «вручную» — с перерисовкой экрана и уведомлением интерфейса */
    stepOnce() {
      this.pause();
      this.step();
      this.video.render();
      if (this.onFrame) this.onFrame();
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.lastTime = performance.now();
      this.speedTime = this.lastTime;
      this.speedCycles = this.cpu.cycles;
      const self = this;
      const loop = function (now) {
        if (!self.running) return;
        self.rafId = requestAnimationFrame(loop);
        self.tick(now);
      };
      this.rafId = requestAnimationFrame(loop);
    }

    pause() {
      if (!this.running) return;
      this.running = false;
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }

    toggle() {
      if (this.running) this.pause(); else this.start();
    }

    /* --- Ход времени -------------------------------------------------------- */

    tick(now) {
      let elapsed = now - this.lastTime;
      this.lastTime = now;
      // После сворачивания вкладки не догоняем часами накопленное отставание
      if (elapsed > 100) elapsed = 100;

      let budget = Math.round(this.config.cpuFreq * elapsed / 1000);
      const stopped = this.runCycles(budget);

      this.video.render();

      // Реальная скорость в процентах от номинала
      const dt = now - this.speedTime;
      if (dt >= 500) {
        const done = this.cpu.cycles - this.speedCycles;
        this.speedPercent = Math.round(100 * done / (this.config.cpuFreq * dt / 1000));
        this.speedTime = now;
        this.speedCycles = this.cpu.cycles;
      }

      if (this.onFrame) this.onFrame();
      if (stopped) {
        this.pause();
        if (this.onBreak) this.onBreak(stopped);
      }
    }

    /**
     * Прокрутить заданное число тактов.
     * @returns {string|null} причина преждевременной остановки
     */
    runCycles(budget) {
      const cpu = this.cpu;
      const hasBreakpoints = this.breakpointCount > 0;
      let spent = 0;

      while (spent < budget) {
        if (hasBreakpoints && this.breakpoints[cpu.pc]) return 'точка останова';
        spent += this.step();
        if (cpu.halted) return 'HLT';
      }
      return null;
    }

    /* --- Точки останова ------------------------------------------------------ */

    toggleBreakpoint(addr) {
      addr &= 0xFFFF;
      if (this.breakpoints[addr]) {
        this.breakpoints[addr] = 0;
        this.breakpointCount--;
        return false;
      }
      this.breakpoints[addr] = 1;
      this.breakpointCount++;
      return true;
    }

    clearBreakpoints() {
      this.breakpoints.fill(0);
      this.breakpointCount = 0;
    }

    /** Адреса последних выполненных команд, от старых к новым */
    getHistory(count) {
      const out = [];
      const n = Math.min(count, this.historyLen);
      for (let i = n; i > 0; i--) {
        const idx = (this.historyPos - i + HISTORY_SIZE) % HISTORY_SIZE;
        out.push(this.history[idx]);
      }
      return out;
    }
  }

  global.Machine = Machine;

})(window);
