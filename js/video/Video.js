/*
 * Видеосистема: превращает содержимое экранной области памяти в картинку.
 *
 * Работает «по кадрам»: раз в кадр читает знакоместа из ОЗУ, разворачивает их
 * через знакогенератор в точки и выводит на канву. Адрес экранной области
 * берётся у контроллера ПДП (канал 2) — как на настоящей машине; если монитор
 * его ещё не запрограммировал, используется значение из конфигурации.
 *
 * Формат кадра (число знаков в строке и строк) запрашивается у ВГ75, поэтому
 * при смене машины ничего править в этом файле не нужно.
 */
(function (global) {
  'use strict';

  class Video {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {Bus} bus
     * @param {CharGen} charGen
     * @param {object} cfg   machine.video
     */
    constructor(canvas, bus, charGen, cfg) {
      this.canvas = canvas;
      this.bus = bus;
      this.charGen = charGen;
      this.cfg = cfg;

      this.crt = null;     // ВГ75, подключается снаружи
      this.dma = null;     // ВТ57

      this.cols = cfg.cols;
      this.rows = cfg.rows;
      this.charWidth = cfg.charWidth;
      this.charHeight = cfg.charHeight;
      this.scale = cfg.scale || 2;

      this.ctx = canvas.getContext('2d', { alpha: false });
      this.ctx.imageSmoothingEnabled = false;

      // Промежуточная канва в точках экрана 1:1, потом растягивается
      this.buffer = document.createElement('canvas');
      this.bufCtx = this.buffer.getContext('2d', { alpha: false });

      this.frames = 0;
      this.videoBase = cfg.base;
      this.setColors(cfg.colorFg, cfg.colorBg);
      this.resize();
    }

    setColors(fg, bg) {
      this.colorFg = fg;
      this.colorBg = bg;
      this.rgbaFg = this.parseColor(fg);
      this.rgbaBg = this.parseColor(bg);
    }

    parseColor(css) {
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css.trim());
      const r = m ? parseInt(m[1], 16) : 255;
      const g = m ? parseInt(m[2], 16) : 255;
      const b = m ? parseInt(m[3], 16) : 255;
      // Порядок в буфере — ABGR (little-endian), поэтому собираем так
      return (0xFF << 24) | (b << 16) | (g << 8) | r;
    }

    /** Пересчёт размеров канвы под текущий формат кадра */
    resize() {
      const w = this.cols * this.charWidth;
      const h = this.rows * this.charHeight;
      if (this.buffer.width !== w || this.buffer.height !== h) {
        this.buffer.width = w;
        this.buffer.height = h;
        this.image = this.bufCtx.createImageData(w, h);
        this.pixels = new Uint32Array(this.image.data.buffer);
      }
      const cw = w * this.scale, ch = h * this.scale;
      if (this.canvas.width !== cw || this.canvas.height !== ch) {
        this.canvas.width = cw;
        this.canvas.height = ch;
        this.ctx.imageSmoothingEnabled = false;
      }
    }

    setScale(scale) {
      this.scale = scale;
      this.resize();
      this.render();
    }

    /** Актуальный адрес экранной области */
    currentBase() {
      if (this.dma) {
        const addr = this.dma.getDisplayAddress();
        if (addr !== null) return addr;
      }
      return this.cfg.base;
    }

    /** Формат кадра: что скажет ВГ75, то и рисуем */
    syncFormat() {
      if (this.crt) {
        const f = this.crt.getScreenFormat();
        // Защита от мусора в регистрах, пока монитор их не настроил
        if (f.cols > 8 && f.cols <= 128 && f.rows > 4 && f.rows <= 64) {
          if (f.cols !== this.cols || f.rows !== this.rows) {
            this.cols = f.cols;
            this.rows = f.rows;
            this.resize();
          }
        }
      }
    }

    render() {
      this.syncFormat();
      const base = this.currentBase();
      this.videoBase = base;

      const cg = this.charGen;
      const cw = this.charWidth, chh = this.charHeight;
      const pitch = this.buffer.width;
      const px = this.pixels;
      const fg = this.rgbaFg, bg = this.rgbaBg;
      const inverseHigh = this.cfg.inverseOnHighBit;

      const showCursor = this.crt ? this.crt.cursorVisible() : false;
      const curX = this.crt ? this.crt.cursorX : -1;
      const curY = this.crt ? this.crt.cursorY : -1;

      let addr = base;
      for (let row = 0; row < this.rows; row++) {
        const yTop = row * chh;
        for (let col = 0; col < this.cols; col++) {
          let code = this.bus.peek(addr & 0xFFFF);
          addr++;

          let inverse = false;
          if (inverseHigh && (code & 0x80)) {
            inverse = true;
            code &= 0x7F;
          }
          if (showCursor && row === curY && col === curX) inverse = !inverse;

          const xLeft = col * cw;
          for (let line = 0; line < chh; line++) {
            let bits = cg.getRow(code, line);
            if (inverse) bits = ~bits;
            let out = (yTop + line) * pitch + xLeft;
            if (cg.msbFirst) {
              for (let x = 0; x < cw; x++) {
                px[out + x] = (bits & (1 << (cw - 1 - x))) ? fg : bg;
              }
            } else {
              for (let x = 0; x < cw; x++) {
                px[out + x] = (bits & (1 << x)) ? fg : bg;
              }
            }
          }
        }
      }

      this.bufCtx.putImageData(this.image, 0, 0);
      this.ctx.drawImage(this.buffer, 0, 0, this.canvas.width, this.canvas.height);
      this.frames++;
      if (this.crt) this.crt.tickFrame();
    }

    /** Заливка экрана фоном — например, при сбросе */
    clear() {
      this.ctx.fillStyle = this.colorBg;
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    getInfo() {
      return {
        base: this.videoBase,
        cols: this.cols,
        rows: this.rows,
        pixels: (this.cols * this.charWidth) + 'x' + (this.rows * this.charHeight),
        frames: this.frames
      };
    }
  }

  global.Video = Video;

})(window);
