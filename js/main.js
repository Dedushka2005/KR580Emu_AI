/*
 * Точка входа. Собирает интерфейс и поднимает машину по умолчанию.
 *
 * Все модули подключены обычными тегами <script> и кладут свои классы в
 * глобальную область: так index.html открывается прямо с диска, без
 * локального сервера (модули ES с file:// браузер загружать отказывается).
 */
(function (global) {
  'use strict';

  function boot() {
    const ui = new UI();
    const dbg = new Debugger(ui.el);
    ui.setDebugger(dbg);

    const startId = ui.el.machineSelect.value || 'rk86';
    ui.createMachine(startId);
    ui.renderBreakpoints();

    ui.log('Готово. Загрузите настоящее ПЗУ и знакогенератор кнопками справа ' +
           'или перетащите файлы в окно.');
    ui.log('Управление: Пуск / Пауза / Один шаг; щелчок по строке дизассемблера ' +
           'ставит точку останова.');

    // Для опытов из консоли браузера
    global.emu = { ui: ui, dbg: dbg, get machine() { return ui.machine; } };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window);
