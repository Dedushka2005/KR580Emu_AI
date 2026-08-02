/*
 * КР580ВТ57 (Intel 8257) — контроллер прямого доступа к памяти.
 *
 * Реальные пересылки нам не нужны: видеомодуль сам читает экранную область.
 * Но именно этот контроллер задаёт, ГДЕ она находится — монитор при старте
 * программирует канал 2 адресом экранного буфера. Считываем этот адрес и
 * отдаём видеосистеме, чтобы не зашивать 76D0 в код.
 *
 * Регистры 0..7: пары «адрес/счётчик» четырёх каналов. Каждый регистр
 * 16-разрядный и записывается двумя обращениями (сначала младший байт),
 * порядок отслеживает внутренний триггер. Регистр 8 — режим/состояние.
 */
(function (global) {
  'use strict';

  class I8257 {
    constructor() {
      this.reset();
    }

    reset() {
      this.channels = [];
      for (let i = 0; i < 4; i++) {
        this.channels.push({ address: 0, count: 0, mode: 0 });
      }
      this.flipFlop = 0;     // 0 — ждём младший байт, 1 — старший
      this.mode = 0;
      this.status = 0;
    }

    read(off) {
      off &= 0x0F;
      if (off === 8) {
        const s = this.status;
        this.status &= ~0x0F;
        return s;
      }
      const ch = this.channels[(off >> 1) & 3];
      const value = (off & 1) ? ch.count : ch.address;
      const byte = this.flipFlop ? (value >> 8) & 0xFF : value & 0xFF;
      this.flipFlop ^= 1;
      return byte;
    }

    write(off, value) {
      off &= 0x0F;
      value &= 0xFF;

      if (off === 8) {
        this.mode = value;
        this.flipFlop = 0;
        return;
      }

      const ch = this.channels[(off >> 1) & 3];
      if (off & 1) {
        // Регистр счётчика: старшие два бита — тип пересылки
        if (this.flipFlop) ch.count = (ch.count & 0x00FF) | (value << 8);
        else ch.count = (ch.count & 0xFF00) | value;
      } else {
        if (this.flipFlop) ch.address = (ch.address & 0x00FF) | (value << 8);
        else ch.address = (ch.address & 0xFF00) | value;
      }
      this.flipFlop ^= 1;
    }

    /** Включён ли канал (бит в регистре режима) */
    channelEnabled(n) { return (this.mode & (1 << n)) !== 0; }

    /**
     * Адрес экранного буфера: канал 2 обслуживает регенерацию изображения.
     * @returns {number|null} null, если канал ещё не запрограммирован
     */
    getDisplayAddress() {
      const ch = this.channels[2];
      if (!this.channelEnabled(2) || ch.address === 0) return null;
      return ch.address & 0xFFFF;
    }

    /** Сколько байт запрограммировано на вывод (число знакомест на экране) */
    getDisplayLength() {
      return (this.channels[2].count & 0x3FFF) + 1;
    }
  }

  global.I8257 = I8257;

})(window);
