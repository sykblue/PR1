"use strict";

(() => {
  function migrate() {
    if (window.location.hash === "#simulation") window.location.replace("/simulation");
  }
  migrate();
  window.addEventListener("hashchange", migrate);
})();

