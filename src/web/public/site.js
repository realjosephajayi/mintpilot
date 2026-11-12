'use strict';
// Plays the example chat in the hero once: each message appears in order, with a typing pause before the last one.
(function () {
  var bubbles = Array.prototype.slice.call(document.querySelectorAll('#chat .bubble'));
  var typing = document.getElementById('typing');
  if (!bubbles.length) return;
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (calm) { bubbles.forEach(function (b) { b.classList.add('show'); }); return; }
  bubbles.forEach(function (b) {
    var at = Number(b.getAttribute('data-at')) || 0;
    if (b.classList.contains('win') && typing) setTimeout(function () { typing.classList.add('on'); }, Math.max(0, at - 1600));
    setTimeout(function () {
      if (b.classList.contains('win') && typing) typing.classList.remove('on');
      b.classList.add('show');
    }, at);
  });
})();
