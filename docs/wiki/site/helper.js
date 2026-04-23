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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setActiveToc)
  } else {
    setActiveToc()
  }
})()
