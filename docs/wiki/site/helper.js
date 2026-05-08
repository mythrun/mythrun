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

  // Schema-reference search/filter/highlight. Lives only on
  // /reference/schema.html — short-circuits everywhere else.
  function setupSchemaReferenceSearch() {
    var search = document.getElementById('schema-search')
    var counter = document.getElementById('schema-counter')
    var expandAll = document.getElementById('schema-expand-all')
    var collapseAll = document.getElementById('schema-collapse-all')
    if (search === null || counter === null) return

    var tables = Array.prototype.slice.call(document.querySelectorAll('details.schema-table'))
    var totalTables = tables.length

    // Track each table's initial open state so empty-query restores it.
    var initialOpen = new Map()
    tables.forEach(function (t) {
      initialOpen.set(t, t.open)
    })

    function clearHighlights(root) {
      var marks = root.querySelectorAll('mark.schema-match')
      marks.forEach(function (m) {
        var parent = m.parentNode
        while (m.firstChild !== null) parent.insertBefore(m.firstChild, m)
        parent.removeChild(m)
        parent.normalize()
      })
    }

    function highlightInTextNodes(root, query) {
      // Walk text nodes; wrap matches in <mark class="schema-match">.
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          // Skip <code> children inside the constraints/index lists — too noisy and we only
          // want to highlight in identifier-bearing cells.
          var p = node.parentNode
          if (p === null) return NodeFilter.FILTER_REJECT
          // Only highlight in: .schema-table-name, td (column rows), .schema-table-meta is fine to skip.
          var inTableName = p.classList && p.classList.contains('schema-table-name')
          var inSummary = false
          var ancestor = p
          while (ancestor !== null && ancestor !== root) {
            if (ancestor.tagName === 'TD') {
              inSummary = true
              break
            }
            ancestor = ancestor.parentNode
          }
          if (inTableName || inSummary) return NodeFilter.FILTER_ACCEPT
          return NodeFilter.FILTER_REJECT
        },
      })

      var nodes = []
      var n = walker.nextNode()
      while (n !== null) {
        nodes.push(n)
        n = walker.nextNode()
      }

      var lower = query.toLowerCase()
      nodes.forEach(function (textNode) {
        var text = textNode.nodeValue
        var lowerText = text.toLowerCase()
        var idx = lowerText.indexOf(lower)
        if (idx === -1) return
        var frag = document.createDocumentFragment()
        var cursor = 0
        while (idx !== -1) {
          if (idx > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, idx)))
          var m = document.createElement('mark')
          m.className = 'schema-match'
          m.appendChild(document.createTextNode(text.slice(idx, idx + query.length)))
          frag.appendChild(m)
          cursor = idx + query.length
          idx = lowerText.indexOf(lower, cursor)
        }
        if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)))
        textNode.parentNode.replaceChild(frag, textNode)
      })
    }

    function applyFilter() {
      var rawQuery = search.value
      var query = rawQuery.trim().toLowerCase()

      tables.forEach(function (t) {
        clearHighlights(t)
      })

      if (query === '') {
        // Restore initial state.
        tables.forEach(function (t) {
          t.classList.remove('schema-hidden')
          t.open = initialOpen.get(t) === true
        })
        counter.textContent = 'Showing all tables'
        return
      }

      var matches = 0
      tables.forEach(function (t) {
        var tableName = (t.getAttribute('data-table-name') || '').toLowerCase()
        var nameMatch = tableName.indexOf(query) !== -1

        var rows = t.querySelectorAll('tr[data-column-name]')
        var anyColumnMatch = false
        for (var i = 0; i < rows.length; i++) {
          var col = (rows[i].getAttribute('data-column-name') || '').toLowerCase()
          if (col.indexOf(query) !== -1) {
            anyColumnMatch = true
            break
          }
        }

        if (!nameMatch && !anyColumnMatch) {
          t.classList.add('schema-hidden')
          return
        }

        t.classList.remove('schema-hidden')
        t.open = true
        highlightInTextNodes(t, rawQuery.trim())
        matches++
      })

      counter.textContent = 'Showing ' + String(matches) + ' of ' + String(totalTables) + ' tables'
    }

    search.addEventListener('input', applyFilter)

    if (expandAll !== null) {
      expandAll.addEventListener('click', function () {
        tables.forEach(function (t) {
          t.open = true
        })
      })
    }
    if (collapseAll !== null) {
      collapseAll.addEventListener('click', function () {
        tables.forEach(function (t) {
          t.open = false
        })
      })
    }

    counter.textContent = 'Showing all tables'
  }

  function init() {
    setActiveToc()
    setupDiagramModal()
    setupSchemaReferenceSearch()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
