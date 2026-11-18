
/* 中台明细折叠：仅对有 .fold-btn 的卡片生效，状态不持久化 */
(function () {
  var btns = document.querySelectorAll('.fold-btn[data-fold]');
  for (var i = 0; i < btns.length; i++) {
    (function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var card = b.closest('.card');
        if (!card) return;
        var collapsed = card.classList.toggle('collapsed');
        b.setAttribute('aria-expanded', String(!collapsed));
        b.title = collapsed ? '展开' : '收起';
      });
    })(btns[i]);
  }
})();
