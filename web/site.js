(function () {
  "use strict";

  var button = document.getElementById("open-preview");
  if (button) {
    button.addEventListener("click", function () {
      window.open("./preview.html", "blackbox-preview", "width=1280,height=860");
    });
  }

  // Download links point at the release asset; if a visitor has no network the
  // browser handles the error, but make the size expectation explicit once.
  document.querySelectorAll('a[href*="Blackbox-1.1.0-win-x64.exe"]').forEach(function (link) {
    link.addEventListener("click", function () {
      link.setAttribute("data-clicked", "true");
    });
  });

  var sections = Array.prototype.slice.call(document.querySelectorAll("main section[id]"));
  var links = Array.prototype.slice.call(document.querySelectorAll(".nav__links a"));
  if (!("IntersectionObserver" in window) || sections.length === 0) return;

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (link) {
          link.classList.toggle("is-current", link.getAttribute("href") === "#" + entry.target.id);
        });
      });
    },
    { rootMargin: "-45% 0px -50% 0px" },
  );
  sections.forEach(function (section) {
    observer.observe(section);
  });
})();
