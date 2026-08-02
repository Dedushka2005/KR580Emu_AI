/*
 * Шина адреса/данных.
 *
 * Разбирает карту памяти из описания машины и строит таблицу страниц по 256
 * байт — обращение к памяти получается без перебора областей: один индекс.
 * Устройства подключаются по имени (см. region.device в конфигурации).
 */
(function (global) {
  'use strict';

  const KIND_NONE = 0, KIND_RAM = 1, KIND_ROM = 2, KIND_IO = 3;

  class Bus {
    constructor(config) {
      this.config = config;
      this.ram = new Uint8Array(0x10000);
      this.rom = null;               // Uint8Array, загружается отдельно
      this.romStart = config.romStart & 0xFFFF;
      this.romSize = config.romSize;

      this.devices = {};             // имя -> объект с read(off)/write(off,v)
      this.ioPorts = {};             // порт -> устройство (для команд IN/OUT)

      // Таблица страниц: для каждой из 256 страниц — вид и параметры
      this.pageKind = new Uint8Array(256);
      this.pageDev = new Array(256).fill(null);
      this.pageBase = new Uint16Array(256);
      this.pageMask = new Uint16Array(256);
      this.buildPageTable();

      // Счётчик обращений к незанятым адресам — помогает искать ошибки в ПЗУ
      this.strayReads = 0;
      this.romWriteWarned = new Set();
    }

    buildPageTable() {
      this.pageKind.fill(KIND_NONE);
      const regions = this.config.regions || [];
      for (const rg of regions) {
        const kind = rg.type === 'ram' ? KIND_RAM :
                     rg.type === 'rom' ? KIND_ROM :
                     rg.type === 'io' ? KIND_IO : KIND_NONE;
        const first = (rg.start >> 8) & 0xFF;
        const last = (rg.end >> 8) & 0xFF;
        for (let p = first; p <= last; p++) {
          this.pageKind[p] = kind;
          this.pageBase[p] = rg.start;
          this.pageMask[p] = rg.mask === undefined ? 0xFFFF : rg.mask;
          this.pageDev[p] = rg.device || null;
        }
      }
    }

    /** Подключить устройство. name должно совпадать с region.device */
    attach(name, device) {
      this.devices[name] = device;
    }

    /** Загрузить ПЗУ (Uint8Array). Размер сверх области отсекается. */
    loadROM(bytes) {
      const size = Math.min(bytes.length, this.romSize);
      this.rom = new Uint8Array(this.romSize);
      this.rom.set(bytes.subarray(0, size));
      return size;
    }

    hasROM() { return this.rom !== null; }

    read(addr) {
      addr &= 0xFFFF;
      const page = addr >> 8;
      switch (this.pageKind[page]) {
        case KIND_RAM:
          return this.ram[addr];
        case KIND_ROM: {
          if (!this.rom) return 0xFF;
          const off = (addr - this.romStart) & 0xFFFF;
          return off < this.rom.length ? this.rom[off] : 0xFF;
        }
        case KIND_IO: {
          const dev = this.devices[this.pageDev[page]];
          if (!dev) return 0xFF;
          return dev.read((addr - this.pageBase[page]) & this.pageMask[page]) & 0xFF;
        }
        default:
          this.strayReads++;
          return 0xFF;
      }
    }

    write(addr, value) {
      addr &= 0xFFFF;
      value &= 0xFF;
      const page = addr >> 8;
      switch (this.pageKind[page]) {
        case KIND_RAM:
          this.ram[addr] = value;
          return;
        case KIND_ROM:
          // Запись в ПЗУ игнорируется, но об этом стоит знать
          if (!this.romWriteWarned.has(page)) {
            this.romWriteWarned.add(page);
            console.warn('[bus] Запись в ПЗУ по адресу 0x' +
              addr.toString(16).toUpperCase().padStart(4, '0') + ' — игнорируется');
          }
          return;
        case KIND_IO: {
          const dev = this.devices[this.pageDev[page]];
          if (dev) dev.write((addr - this.pageBase[page]) & this.pageMask[page], value);
          return;
        }
        default:
          return;
      }
    }

    /* --- Пространство ввода/вывода (команды IN/OUT) ------------------------ */
    /* На РК-86 периферия отображена в память, порты почти не используются,
     * но механизм оставлен для совместимости с другими машинами. */
    bindPort(port, device, offset) {
      this.ioPorts[port & 0xFF] = { device: device, offset: offset | 0 };
    }

    ioRead(port) {
      const b = this.ioPorts[port & 0xFF];
      if (b) return this.devices[b.device] ? this.devices[b.device].read(b.offset) & 0xFF : 0xFF;
      return 0xFF;
    }

    ioWrite(port, value) {
      const b = this.ioPorts[port & 0xFF];
      if (b && this.devices[b.device]) this.devices[b.device].write(b.offset, value & 0xFF);
    }

    /* --- Вспомогательное для отладчика ------------------------------------ */
    /** Чтение без побочных эффектов: устройства не трогаем, чтобы дизассемблер
     *  не сбивал их состояние (например, флип-флоп в контроллере ПДП). */
    peek(addr) {
      addr &= 0xFFFF;
      const page = addr >> 8;
      switch (this.pageKind[page]) {
        case KIND_RAM: return this.ram[addr];
        case KIND_ROM: {
          if (!this.rom) return 0xFF;
          const off = (addr - this.romStart) & 0xFFFF;
          return off < this.rom.length ? this.rom[off] : 0xFF;
        }
        default: return 0xFF;
      }
    }

    /** Загрузка блока данных в ОЗУ (например, из файла .RK/.BIN) */
    loadRAM(addr, bytes) {
      addr &= 0xFFFF;
      for (let i = 0; i < bytes.length && addr + i <= 0xFFFF; i++) {
        this.ram[addr + i] = bytes[i];
      }
    }

    clearRAM() { this.ram.fill(0); }

    /** Текстовое описание карты памяти — выводится в интерфейсе */
    describe() {
      return (this.config.regions || []).map(function (rg) {
        const h = function (v) { return v.toString(16).toUpperCase().padStart(4, '0'); };
        return h(rg.start) + '-' + h(rg.end) + '  ' + rg.name;
      });
    }
  }

  Bus.KIND = { NONE: KIND_NONE, RAM: KIND_RAM, ROM: KIND_ROM, IO: KIND_IO };
  global.Bus = Bus;

})(window);
