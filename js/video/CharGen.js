/*
 * Знакогенератор.
 *
 * Настоящая машина хранит начертания символов в отдельном ПЗУ: по 8 байт на
 * знак, каждый байт — строка развёртки, единицы — светящиеся точки. Такой файл
 * можно загрузить кнопкой «Знакогенератор».
 *
 * Пока файл не загружен, используется резервный шрифт: он рисуется средствами
 * самого браузера (текст выводится в служебную канву и оцифровывается). Это не
 * копия ПЗУ РК-86, а именно заглушка, чтобы интерфейс был живым сразу.
 */
(function (global) {
  'use strict';

  class CharGen {
    /**
     * @param {object} cfg      machine.charGen
     * @param {object} videoCfg machine.video (нужны размеры знакоместа)
     */
    constructor(cfg, videoCfg) {
      this.cfg = cfg;
      this.charWidth = videoCfg.charWidth;
      this.charHeight = videoCfg.charHeight;
      this.bytesPerChar = cfg.bytesPerChar || videoCfg.charHeight;
      this.msbFirst = cfg.msbFirst !== false;

      this.data = new Uint8Array(256 * this.bytesPerChar);
      this.loaded = false;       // true, если загружен настоящий файл
      this.source = 'нет';
    }

    /** Загрузка файла знакогенератора (1 КБ = 128 знаков, 2 КБ = 256) */
    load(bytes, name) {
      const count = Math.floor(bytes.length / this.bytesPerChar);
      this.data.fill(0);
      const limit = Math.min(count, 256) * this.bytesPerChar;
      this.data.set(bytes.subarray(0, limit));
      this.loaded = true;
      this.source = (name || 'файл') + ' (' + count + ' знаков)';
      return count;
    }

    /** Байт строки развёртки: code — код символа, line — номер строки в знакоместе */
    getRow(code, line) {
      if (line >= this.bytesPerChar) return 0;
      return this.data[((code & 0xFF) * this.bytesPerChar) + line];
    }

    /**
     * Резервный шрифт: рисуем каждый знак браузерным шрифтом и оцифровываем.
     * @param {string} cyrillic строка кириллицы в порядке КОИ-7 для 0x60..0x7F
     */
    buildFallback(cyrillic) {
      const w = this.charWidth, h = this.charHeight;
      // Последний столбец и нижняя строка знакоместа остаются пустыми — это
      // промежутки между буквами и строками, иначе текст сливается.
      const glyphW = Math.max(1, w - 1);
      const glyphH = Math.max(1, h - 1);
      // Рисуем с запасом по размеру, затем прореживаем — так глифы читаемее
      const scale = 4;
      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      this.data.fill(0);

      for (let code = 0x20; code < 0x80; code++) {
        const ch = this.codeToChar(code, cyrillic);
        if (!ch) continue;

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold ' + (glyphH * scale) + 'px monospace';
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';

        // Ширина знака у моноширинных шрифтов меньше высоты, поэтому растягиваем
        // (или сжимаем) его точно в отведённые glyphW точек.
        const metrics = ctx.measureText(ch);
        const ascent = metrics.actualBoundingBoxAscent || glyphH * scale * 0.72;
        const width = metrics.width || glyphW * scale;
        ctx.save();
        ctx.scale((glyphW * scale) / width, 1);
        ctx.fillText(ch, 0, Math.min(glyphH * scale, Math.round(ascent) + scale));
        ctx.restore();

        const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let y = 0; y < h; y++) {
          let rowBits = 0;
          for (let x = 0; x < w; x++) {
            // Считаем «зажжённой» точку, если в её квадрате достаточно чернил
            let ink = 0;
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                const px = ((y * scale + sy) * canvas.width + (x * scale + sx)) * 4;
                if (img[px] > 110) ink++;
              }
            }
            if (ink * 3 >= scale * scale) {
              rowBits |= this.msbFirst ? (1 << (w - 1 - x)) : (1 << x);
            }
          }
          this.data[code * this.bytesPerChar + y] = rowBits;
        }
      }

      // Коды 0x00..0x1F в настоящем ПЗУ заняты псевдографикой; воспроизвести её
      // «на глаз» нельзя, поэтому оставляем пустыми — чистое ОЗУ даёт чистый экран.

      this.loaded = false;
      this.source = 'встроенный (заглушка)';
    }

    /** Код КОИ-7 -> символ Unicode для отрисовки резервного шрифта */
    codeToChar(code, cyrillic) {
      if (code >= 0x20 && code <= 0x5F) return String.fromCharCode(code);
      if (code >= 0x60 && code <= 0x7F && cyrillic) {
        return cyrillic.charAt(code - 0x60) || null;
      }
      return null;
    }
  }

  global.CharGen = CharGen;

})(window);
