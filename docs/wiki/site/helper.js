// Client-side: TOC scrollspy and mild active-nav fallback.
// No frameworks. No build step. Plain ES module, loaded via <script src=...>.

;(function () {
  'use strict'

  function setActiveToc() {
    var tocLinks = document.querySelectorAll('.wiki-toc a[href^="#"]')
    if (tocLinks.length === 0) return

    var targets = []
    tocLinks.forEach(function (a) {
      var id = a.getAttribute('href').slice(1)
      var el = document.getElementById(id)
      if (el !== null) targets.push({ id: id, el: el, link: a })
    })

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            tocLinks.forEach(function (l) {
              l.classList.remove('active')
            })
            var match = targets.find(function (t) {
              return t.el === entry.target
            })
            if (match !== undefined) match.link.classList.add('active')
          }
        })
      },
      { rootMargin: '-20% 0% -70% 0%', threshold: 0 },
    )

    targets.forEach(function (t) {
      observer.observe(t.el)
    })
  }

  // Diagram expand-to-modal. Click the button on any .wiki-diagram → clone its
  // SVG into a viewport-size modal. ESC or backdrop click closes.
  function setupDiagramModal() {
    var triggers = document.querySelectorAll('.wiki-diagram-expand')
    if (triggers.length === 0) return

    var modal = document.createElement('div')
    modal.className = 'wiki-diagram-modal'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.innerHTML =
      '<div class="wiki-diagram-modal-inner"></div>' +
      '<button type="button" class="wiki-diagram-modal-close" aria-label="Close">&times;</button>'
    document.body.appendChild(modal)
    var inner = modal.querySelector('.wiki-diagram-modal-inner')
    var closeBtn = modal.querySelector('.wiki-diagram-modal-close')

    function openModal(sourceSvg) {
      var clone = sourceSvg.cloneNode(true)
      // Drop fixed width/height so the clone scales to the modal container.
      clone.removeAttribute('width')
      clone.removeAttribute('height')
      inner.innerHTML = ''
      inner.appendChild(clone)
      modal.classList.add('open')
      document.body.style.overflow = 'hidden'
    }
    function closeModal() {
      modal.classList.remove('open')
      inner.innerHTML = ''
      document.body.style.overflow = ''
    }

    triggers.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var fig = btn.closest('.wiki-diagram')
        if (fig === null) return
        var svg = fig.querySelector('svg')
        if (svg !== null) openModal(svg)
      })
    })
    closeBtn.addEventListener('click', closeModal)
    modal.addEventListener('click', function (ev) {
      // Close when clicking the backdrop (the modal itself) but not the inner.
      if (ev.target === modal) closeModal()
    })
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && modal.classList.contains('open')) closeModal()
    })
  }

  function init() {
    setActiveToc()
    setupDiagramModal()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
