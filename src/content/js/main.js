(function () {
  const selectorsToUpdate = [
    ["title", "innerHTML"],
    [".garden_layout__header", "innerHTML"],
    [".garden_layout__main", "innerHTML"],
    [".garden_layout__toc", "innerHTML"],
    ["head link[rel=canonical]", "href"],
    ["head meta[name=description]", "content"],
  ];

  let loadedPage = new URL(location);

  async function loadPage(url) {
    const res = await fetch(url);
    const data = await res.text();
    const doc = new DOMParser().parseFromString(data, "text/html");

    for (const [selector, prop] of selectorsToUpdate) {
      const newValue = doc.querySelector(selector)[prop];
      document.querySelector(selector)[prop] = newValue;
    }

    loadedPage = url;
    window.scrollTo(0, 0);
  }

  document.addEventListener("click", async (e) => {
    if (e.target.tagName !== "A") {
      return;
    }

    const url = new URL(e.target.href);

    if (
      url.origin !== location.origin ||
      !url.pathname.startsWith("/garden/") ||
      url.pathname === location.pathname
    ) {
      return;
    }

    e.preventDefault();

    await loadPage(url);

    history.pushState(null, document.querySelector("title").innerHTML, url);

    gtag("event", "page_view", {
      page_location: document.location.href,
      page_title: document.title,
    });
  });

  window.onpopstate = async () => {
    const newUrl = new URL(location);

    if (newUrl.pathname === loadedPage.pathname) {
      return;
    }

    await loadPage(new URL(location));
  };
})();
