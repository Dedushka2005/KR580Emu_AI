/*
 * Интерфейс: кнопки управления, загрузка образов ПЗУ и знакогенератора,
 * передача нажатий клавиш в эмулируемую машину.
 *
 * Загрузка файлов сделана через <input type="file"> и перетаскивание, а не
 * через fetch: страница должна открываться прямо с диска (file://), где
 * сетевые запросы к соседним файлам браузер запрещает. Загруженные образы
 * складываются в localStorage, поэтому после перезагрузки страницы машина
 * поднимается с тем же ПЗУ.
 */
(function (global) {
  'use strict';

  const STORAGE_PREFIX = 'kr580emu.';

  class UI {
    constructor() {
      this.machine = null;
      this.debugger = null;
      this.el = {};
      this.cacheElements();
      this.bindControls();
      this.bindFiles();
      this.bindKeyboard();
    }

    cacheElements() {
      const ids = [
        'screen', 'btnReset', 'btnRun', 'btnPause', 'btnStep',
        'machineSelect', 'scaleSelect', 'fileRom', 'fileChar',
        'romName', 'charName', 'btnRomClear', 'btnCharClear',
        'regA', 'regBC', 'regDE', 'regHL', 'regSP', 'regPC', 'regF', 'regM',
        'flagS', 'flagZ', 'flagA', 'flagP', 'flagC', 'flagI',
        'cycles', 'instructions', 'disasm', 'stateBadge', 'speed',
        'videoBase', 'videoFormat', 'unknown', 'memoryMap',
        'bpAddr', 'btnBpAdd', 'btnBpClear', 'bpList', 'lastKey', 'log'
      ];
      for (const id of ids) this.el[id] = document.getElementById(id);
    }

    /* --- Машина --------------------------------------------------------------- */

    createMachine(configId) {
      const config = MACHINES[configId];
      if (this.machine) this.machine.pause();

      const machine = new Machine(config, this.el.screen);
      this.machine = machine;

      const self = this;
      machine.onFrame = function () { self.debugger.update(); };
      machine.onBreak = function (reason) {
        self.log('Остановлено: ' + reason + ' на адресе ' +
          Disassembler.hex(machine.cpu.pc, 4));
        self.updateButtons();
      };

      // Восстанавливаем ранее загруженные образы
      const rom = this.loadStored(configId + '.rom');
      if (rom) {
        machine.loadROM(rom.bytes, rom.name);
        this.el.romName.textContent = rom.name;
      } else {
        this.el.romName.textContent = machine.romName;
      }
      const chars = this.loadStored(configId + '.char');
      if (chars) {
        machine.loadCharGen(chars.bytes, chars.name);
        this.el.charName.textContent = chars.name;
      } else {
        this.el.charName.textContent = machine.charGen.source;
      }

      machine.reset();
      this.renderMemoryMap();
      this.debugger.attach(machine);
      this.updateButtons();
      this.log('Машина: ' + config.name + ', ' +
        (config.cpuFreq / 1e6).toFixed(2) + ' МГц');
      return machine;
    }

    setDebugger(dbg) { this.debugger = dbg; }

    /* --- Кнопки ---------------------------------------------------------------- */

    bindControls() {
      const self = this;

      this.el.btnReset.addEventListener('click', function () {
        self.machine.reset();
        self.log('Сброс');
        self.debugger.forceUpdate();
        self.updateButtons();
      });

      this.el.btnRun.addEventListener('click', function () {
        self.machine.start();
        self.updateButtons();
      });

      this.el.btnPause.addEventListener('click', function () {
        self.machine.pause();
        self.debugger.forceUpdate();
        self.updateButtons();
      });

      this.el.btnStep.addEventListener('click', function () {
        self.machine.stepOnce();
        self.debugger.forceUpdate();
        self.updateButtons();
      });

      this.el.machineSelect.addEventListener('change', function () {
        self.createMachine(this.value);
      });

      this.el.scaleSelect.addEventListener('change', function () {
        self.machine.video.setScale(parseInt(this.value, 10));
      });

      // Точки останова
      this.el.btnBpAdd.addEventListener('click', function () {
        const raw = self.el.bpAddr.value.trim().replace(/[hH]$/, '');
        const addr = parseInt(raw, 16);
        if (isNaN(addr)) { self.log('Не разобран адрес: ' + raw); return; }
        const added = self.machine.toggleBreakpoint(addr);
        self.log((added ? 'Точка останова ' : 'Снята точка ') + Disassembler.hex(addr & 0xFFFF, 4));
        self.renderBreakpoints();
        self.debugger.forceUpdate();
      });

      this.el.btnBpClear.addEventListener('click', function () {
        self.machine.clearBreakpoints();
        self.renderBreakpoints();
        self.debugger.forceUpdate();
      });

      // Щелчок по строке дизассемблера ставит/снимает точку останова
      this.el.disasm.addEventListener('click', function (e) {
        const row = e.target.closest('.dis-row');
        if (!row || !row.dataset.addr) return;
        self.machine.toggleBreakpoint(parseInt(row.dataset.addr, 10));
        self.renderBreakpoints();
        self.debugger.forceUpdate();
      });
    }

    updateButtons() {
      const running = this.machine ? this.machine.running : false;
      this.el.btnRun.disabled = running;
      this.el.btnPause.disabled = !running;
      this.el.btnStep.disabled = running;
    }

    renderBreakpoints() {
      const m = this.machine;
      const list = [];
      for (let a = 0; a < 0x10000 && list.length < 32; a++) {
        if (m.breakpoints[a]) list.push(Disassembler.hex(a, 4));
      }
      this.el.bpList.textContent = list.length ? list.join(' ') : 'нет';
    }

    renderMemoryMap() {
      this.el.memoryMap.innerHTML = this.machine.bus.describe()
        .map(function (s) { return '<div>' + s + '</div>'; }).join('');
    }

    /* --- Файлы ----------------------------------------------------------------- */

    bindFiles() {
      const self = this;

      this.el.fileRom.addEventListener('change', function (e) {
        const f = e.target.files[0];
        if (f) self.readFile(f, function (bytes) { self.applyROM(bytes, f.name); });
        e.target.value = '';
      });

      this.el.fileChar.addEventListener('change', function (e) {
        const f = e.target.files[0];
        if (f) self.readFile(f, function (bytes) { self.applyCharGen(bytes, f.name); });
        e.target.value = '';
      });

      this.el.btnRomClear.addEventListener('click', function () {
        self.clearStored(self.machine.config.id + '.rom');
        self.createMachine(self.machine.config.id);
        self.log('Загруженное ПЗУ удалено, возвращена тестовая заглушка');
      });

      this.el.btnCharClear.addEventListener('click', function () {
        self.clearStored(self.machine.config.id + '.char');
        self.createMachine(self.machine.config.id);
        self.log('Знакогенератор сброшен на встроенный');
      });

      // Перетаскивание файлов: размер образа подсказывает, что это
      document.addEventListener('dragover', function (e) { e.preventDefault(); });
      document.addEventListener('drop', function (e) {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (!f) return;
        self.readFile(f, function (bytes) {
          // Знакогенератор узнаём по имени файла, а при обычном имени — по размеру:
          // 1 КБ для образа знакогенератора почти однозначен.
          const byName = /зг|знак|chargen|font|sgen/i.test(f.name);
          const isFont = byName || bytes.length === 0x400;
          if (isFont) self.applyCharGen(bytes, f.name);
          else self.applyROM(bytes, f.name);
        });
      });
    }

    readFile(file, done) {
      const reader = new FileReader();
      const self = this;
      reader.onload = function () {
        done(new Uint8Array(reader.result));
      };
      reader.onerror = function () { self.log('Ошибка чтения файла ' + file.name); };
      reader.readAsArrayBuffer(file);
    }

    applyROM(bytes, name) {
      const size = this.machine.loadROM(bytes, name);
      this.store(this.machine.config.id + '.rom', bytes, name);
      this.el.romName.textContent = name + ' (' + size + ' байт)';
      this.machine.reset();
      this.debugger.forceUpdate();
      this.updateButtons();
      this.log('ПЗУ ' + name + ': ' + bytes.length + ' байт, размещено с адреса ' +
        Disassembler.hex(this.machine.config.romStart, 4));
    }

    applyCharGen(bytes, name) {
      const count = this.machine.loadCharGen(bytes, name);
      this.store(this.machine.config.id + '.char', bytes, name);
      this.el.charName.textContent = name + ' (' + count + ' знаков)';
      this.log('Знакогенератор ' + name + ': ' + count + ' знаков');
    }

    /* --- Хранилище -------------------------------------------------------------- */

    store(key, bytes, name) {
      try {
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        localStorage.setItem(STORAGE_PREFIX + key,
          JSON.stringify({ name: name, data: btoa(bin) }));
      } catch (e) {
        this.log('Не удалось сохранить образ: ' + e.message);
      }
    }

    loadStored(key) {
      try {
        const raw = localStorage.getItem(STORAGE_PREFIX + key);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        const bin = atob(obj.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { bytes: bytes, name: obj.name };
      } catch (e) {
        return null;
      }
    }

    clearStored(key) {
      try { localStorage.removeItem(STORAGE_PREFIX + key); } catch (e) { /* нечего делать */ }
    }

    /* --- Клавиатура -------------------------------------------------------------- */

    bindKeyboard() {
      const self = this;

      const isFormField = function () {
        const t = document.activeElement;
        return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
      };

      window.addEventListener('keydown', function (e) {
        if (isFormField() || e.metaKey) return;
        // F5..F12 оставляем браузеру
        if (/^F\d/.test(e.key)) return;
        if (self.machine && self.machine.keyboard.keyDown(e)) {
          e.preventDefault();
          self.el.lastKey.textContent = self.machine.keyboard.lastKeyInfo;
        }
      });

      window.addEventListener('keyup', function (e) {
        if (isFormField()) return;
        if (self.machine && self.machine.keyboard.keyUp(e)) e.preventDefault();
      });

      // При потере фокуса окном «отпускаем» все клавиши, иначе они залипнут
      window.addEventListener('blur', function () {
        if (self.machine) self.machine.keyboard.reset();
      });
    }

    /* --- Журнал ------------------------------------------------------------------ */

    log(text) {
      const line = document.createElement('div');
      const t = new Date();
      line.textContent = '[' + t.toLocaleTimeString('ru-RU') + '] ' + text;
      this.el.log.appendChild(line);
      while (this.el.log.childElementCount > 100) {
        this.el.log.removeChild(this.el.log.firstChild);
      }
      this.el.log.scrollTop = this.el.log.scrollHeight;
    }
  }

  global.UI = UI;

})(window);
