/*
 * КР580ВГ75 (Intel 8275) — контроллер электронно-лучевой трубки.
 *
 * Полноценная эмуляция построчного вывода с DMA здесь не нужна: изображение
 * формируется видеомодулем один раз за кадр по содержимому экранной области.
 * Что действительно важно — вытащить из команд формат экрана (число знаков в
 * строке и строк в кадре) и положение курсора, чтобы не хардкодить их.
 *
 * Регистры: смещение 0 — параметры/данные, смещение 1 — команда/состояние.
 */
(function (global) {
  'use strict';

  const CMD_RESET = 0x00, CMD_START = 0x20, CMD_STOP = 0x40,
        CMD_READ_LP = 0x60, CMD_LOAD_CURSOR = 0x80,
        CMD_EI = 0xA0, CMD_DI = 0xC0, CMD_PRESET = 0xE0;

  class I8275 {
    constructor(videoCfg) {
      this.cols = videoCfg.cols;
      this.rows = videoCfg.rows;
      this.charHeight = videoCfg.charHeight;
      this.reset();
    }

    reset() {
      this.status = 0;
      this.command = 0;
      this.paramsLeft = 0;
      this.paramIndex = 0;
      this.params = [0, 0, 0, 0];
      this.displayEnabled = false;
      this.cursorX = 0;
      this.cursorY = 0;
      this.cursorPhase = 0;
      this.interruptEnabled = false;
    }

    /** Вызывается видеомодулем раз в кадр — мигание курсора */
    tickFrame() {
      this.cursorPhase = (this.cursorPhase + 1) & 0x1F;
      if (this.displayEnabled) this.status |= 0x20;   // признак конца кадра
    }

    cursorVisible() {
      return this.displayEnabled && (this.cursorPhase & 0x10) === 0;
    }

    read(off) {
      if ((off & 1) === 0) {
        return 0xFF;                     // чтение параметров не используется
      }
      const s = this.status;
      this.status &= ~0x20;              // признак конца кадра сбрасывается чтением
      return s;
    }

    write(off, value) {
      value &= 0xFF;
      if ((off & 1) === 0) {
        this.writeParam(value);
      } else {
        this.writeCommand(value);
      }
    }

    writeCommand(value) {
      this.command = value;
      switch (value & 0xE0) {
        case CMD_RESET:
          this.paramsLeft = 4;
          this.paramIndex = 0;
          this.displayEnabled = false;
          break;
        case CMD_START:
          // Младшие биты задают режим DMA — на формирование картинки не влияют
          this.displayEnabled = true;
          break;
        case CMD_STOP:
          this.displayEnabled = false;
          break;
        case CMD_LOAD_CURSOR:
          this.paramsLeft = 2;
          this.paramIndex = 0;
          break;
        case CMD_EI: this.interruptEnabled = true; break;
        case CMD_DI: this.interruptEnabled = false; break;
        case CMD_PRESET: break;
        case CMD_READ_LP: this.paramsLeft = 2; this.paramIndex = 0; break;
        default:
          console.warn('[ВГ75] Неизвестная команда 0x' + value.toString(16).toUpperCase());
      }
    }

    writeParam(value) {
      if (this.paramsLeft <= 0) return;
      const cmdType = this.command & 0xE0;

      if (cmdType === CMD_LOAD_CURSOR) {
        if (this.paramIndex === 0) this.cursorX = value & 0x7F;
        else this.cursorY = value & 0x3F;
      } else if (cmdType === CMD_RESET) {
        this.params[this.paramIndex] = value;
        if (this.paramIndex === 0) {
          // S + число знаков в строке (значение на 1 меньше реального)
          this.cols = (value & 0x7F) + 1;
        } else if (this.paramIndex === 1) {
          // Число строк в кадре
          this.rows = (value & 0x3F) + 1;
        } else if (this.paramIndex === 2) {
          // Число строк развёртки в знакоместе
          this.charHeight = (value & 0x0F) + 1;
        }
      }

      this.paramIndex++;
      this.paramsLeft--;
    }

    /** Параметры экрана, которые видеомодуль берёт вместо значений по умолчанию */
    getScreenFormat() {
      return { cols: this.cols, rows: this.rows, charHeight: this.charHeight };
    }
  }

  global.I8275 = I8275;

})(window);
