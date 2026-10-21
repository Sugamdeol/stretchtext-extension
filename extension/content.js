/*
 * Stretchtext content script.
 *
 * Finds the text blocks of the page, shows a small floating control when the
 * reader hovers one (or selects text inside one), and rewrites that block in
 * place with Pollinations. The rewritten text goes back into the very same
 * element, so the page layout is preserved and the reader never leaves the
 * page. The original text is kept in a WeakMap so "shrink" can walk back down
 * and "restore" can return to the original wording.
 */

(() => {
  if (window.__stretchtextLoaded) return;
  window.__stretchtextLoaded = true;

  const ORIGINALS = new WeakMap(); // element -> the untouched original text
  const VERSIONS = new WeakMap(); // element -> [{ text, kind }] ladder of texts
  const MIN_LENGTH = 120; // characters before a block is worth stretching
  const MAX_LENGTH = 8000;

  const BLOCK_SELECTOR = [
    "p",
    "li",
    "blockquote",
    "dd",
    "figcaption",
    "article section > div",
    "main > div",
  ].join(",");

  let signedIn = false;
  let toolbar = null;
  let activeBlock = null;
  let hoverBlock = null;
  let busy = false;
  let spentOnPage = 0;

  /* ---------------------------------------------------------------- */
  /* Small helpers                                                    */
  /* ---------------------------------------------------------------- */

  const send = (type, payload = {}) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "No response from extension." });
      });
    });

  function isTextBlock(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element.closest(".stretchtext-root, [data-stretchtext-ui]")) return false;
    const tag = element.tagName.toLowerCase();
    if (tag === "li" && element.closest("nav, ul.menu, .toc, #toc")) return false;
    const text = (element.innerText || "").trim();
    if (text.length < MIN_LENGTH || text.length > MAX_LENGTH) return false;
    if (!element.getClientRects().length) return false;
    // Skip blocks that are mostly links/nav chrome.
    const links = element.querySelectorAll("a");
    if (links.length > 0) {
      let linkChars = 0;
      links.forEach((a) => {
        linkChars += (a.innerText || "").length;
      });
      if (linkChars > text.length * 0.6) return false;
    }
    return true;
  }

  function blockOf(node) {
    let element = node;
    while (element && element !== document.body) {
      if (isTextBlock(element)) return element;
      element = element.parentElement;
    }
    return null;
  }

  function blockText(element) {
    return (element.innerText || "").trim();
  }

  function originalOf(element) {
    return ORIGINALS.get(element) ?? blockText(element);
  }

  /* ---------------------------------------------------------------- */
  /* Toolbar UI                                                       */
  /* ---------------------------------------------------------------- */

  function buildToolbar() {
    const root = document.createElement("div");
    root.className = "stretchtext-root";
    root.setAttribute("data-stretchtext-ui", "1");
    root.setAttribute("role", "toolbar");
    root.setAttribute("aria-label", "Stretchtext controls");
    root.innerHTML = `
      <style>
        .stretchtext-root {
          position: absolute;
          z-index: 2147483647;
          display: none;
          gap: 6px;
          align-items: center;
          padding: 6px 8px;
          border-radius: 10px;
          background: #10131a;
          color: #eef2ff;
          font: 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          box-shadow: 0 6px 22px rgba(0,0,0,.35);
          border: 1px solid rgba(255,255,255,.14);
          user-select: none;
        }
        .stretchtext-root[data-open="1"] { display: flex; }
        .stretchtext-root button {
          border: 0;
          border-radius: 7px;
          padding: 5px 9px;
          font: inherit;
          font-weight: 600;
          cursor: pointer;
          background: #1f2533;
          color: #eef2ff;
        }
        .stretchtext-root button:hover { background: #2b3245; }
        .stretchtext-root button[data-action="expand"] { background: #3f7d58; }
        .stretchtext-root button[data-action="expand"]:hover { background: #4b9670; }
        .stretchtext-root button[data-action="shrink"] { background: #7d5a3f; }
        .stretchtext-root button[data-action="shrink"]:hover { background: #96694b; }
        .stretchtext-root button[disabled] { opacity: .5; cursor: progress; }
        .stretchtext-root .st-status { color: #a9b3cc; max-width: 220px; }
        .stretchtext-root .st-credit { color: #8fd3ff; text-decoration: none; }
      </style>
      <button data-action="expand" title="Grow this text in place">Expand</button>
      <button data-action="shrink" title="Condense this text">Shrink</button>
      <button data-action="restore" title="Restore the original wording">Restore</button>
      <button data-action="signin" title="Open the Stretchtext popup to sign in">Sign in</button>
      <span class="st-status"></span>
      <a class="st-credit" href="https://pollinations.ai/?ref=badge" target="_blank" rel="noopener">Made with pollinations.ai</a>
    `;
    document.documentElement.appendChild(root);

    root.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const action = button.getAttribute("data-action");
      runAction(action);
    });
    return root;
  }

  // When the reader has not signed in yet, the control says so instead of
  // pretending it can rewrite. Nothing is ever rewritten without a key.
  function setStatus(text, isError = false) {
    if (!toolbar) return;
    const status = toolbar.querySelector(".st-status");
    status.textContent = text || "";
    status.style.color = isError ? "#ff9a9a" : "#a9b3cc";
  }

  function setBusy(value) {
    busy = value;
    if (!toolbar) return;
    toolbar
      .querySelectorAll('button[data-action="expand"], button[data-action="shrink"]')
      .forEach((button) => {
        button.disabled = value || !signedIn;
      });
    const restore = toolbar.querySelector('button[data-action="restore"]');
    if (restore) restore.disabled = value;
  }

  function positionToolbar(element) {
    if (!toolbar) return;
    const rect = element.getBoundingClientRect();
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    toolbar.setAttribute("data-open", "1");
    // Measure the control so it can be placed beside the text column when
    // there is room, instead of covering the line above the paragraph.
    const width = toolbar.offsetWidth || 260;
    const height = toolbar.offsetHeight || 34;
    const left = rect.left + scrollX;
    const top = rect.top + scrollY;
    let x = left;
    let y = top - height - 8;
    if (left - width - 12 >= 8) {
      // Beside the column: the tidiest place for a floating control.
      x = left - width - 12;
      y = top + 2;
    } else if (y < 4) {
      // No room above: drop it just inside the top of the block.
      y = top + 4;
    }
    toolbar.style.left = `${Math.max(4, x)}px`;
    toolbar.style.top = `${Math.max(4, y)}px`;
  }

  function showToolbarFor(element) {
    if (!element) return;
    if (activeBlock && activeBlock !== element) {
      // keep the previous block's state visible but move on
    }
    activeBlock = element;
    if (!toolbar) toolbar = buildToolbar();
    positionToolbar(element);
    const signin = toolbar.querySelector('button[data-action="signin"]');
    if (signin) signin.style.display = signedIn ? "none" : "";
    setBusy(busy);
    if (!signedIn) setStatus("Sign in with your own Pollen to rewrite");
    else setStatus("");
  }

  function hideToolbar() {
    if (!toolbar) return;
    toolbar.removeAttribute("data-open");
    activeBlock = null;
  }

  /* ---------------------------------------------------------------- */
  /* Rewriting                                                        */
  /* ---------------------------------------------------------------- */

  function applyText(element, text) {
    // Keep the block's own styling; only the text content changes.
    element.textContent = text;
  }

  async function runAction(action) {
    if (busy) return;
    const element = activeBlock;
    if (!element) return;

    if (action === "signin") {
      send("openPopup");
      return;
    }

    if (action === "restore") {
      const original = originalOf(element);
      applyText(element, original);
      VERSIONS.set(element, [{ text: original, kind: "original" }]);
      setStatus("restored to the original wording");
      return;
    }

    setBusy(true);
    setStatus(action === "expand" ? "growing…" : "shrinking…");

    if (!ORIGINALS.has(element)) {
      ORIGINALS.set(element, blockText(element));
      VERSIONS.set(element, [
        { text: originalOf(element), kind: "original" },
      ]);
    }
    const ladder = VERSIONS.get(element);
    const current = ladder[ladder.length - 1].text;

    // "shrink" condenses whatever is on screen right now, so repeated shrinks
    // keep making the text shorter. "expand" grows the current text, and
    // pushes a new rung onto the ladder so the previous wording is still
    // reachable.
    const response = await send("rewrite", {
      text: current,
      mode: action === "expand" ? "expand" : "shrink",
    });

    setBusy(false);

    if (!response || !response.ok) {
      const message = response?.error || "The rewrite failed.";
      setStatus(message, true);
      if (response?.needsSignIn) {
        send("openPopup");
      }
      return;
    }

    if (action === "expand") {
      ladder.push({ text: response.text, kind: "expanded" });
    } else {
      ladder[ladder.length - 1] = { text: response.text, kind: "shrunk" };
    }
    applyText(element, response.text);

    const level = ladder.length - 1;
    const cost =
      response.spent !== null && response.spent !== undefined
        ? ` · ${response.spent.toFixed(3)} 🌾`
        : "";
    spentOnPage += response.spent || 0;
    setStatus(
      `level ${level} · ${spentOnPage.toFixed(3)} 🌾 spent on this page${cost}`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Interaction                                                      */
  /* ---------------------------------------------------------------- */

  document.addEventListener(
    "mouseover",
    (event) => {
      if (event.target.closest && event.target.closest(".stretchtext-root")) return;
      const block = blockOf(event.target);
      if (block && block !== hoverBlock) {
        hoverBlock = block;
        showToolbarFor(block);
      }
    },
    true,
  );

  document.addEventListener("mouseout", (event) => {
    if (event.target.closest && event.target.closest(".stretchtext-root")) return;
    const related = event.relatedTarget;
    if (related && related.closest && related.closest(".stretchtext-root")) return;
    hoverBlock = null;
  });

  document.addEventListener("keydown", (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "e" || event.key === "E") {
      if (activeBlock) {
        event.preventDefault();
        runAction("expand");
      }
    } else if (event.key === "s" || event.key === "S") {
      if (activeBlock) {
        event.preventDefault();
        runAction("shrink");
      }
    }
  });

  // Selecting text inside a block focuses that block.
  document.addEventListener("selectionchange", () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const node = selection.anchorNode;
    if (!node) return;
    const element = node.nodeType === 1 ? node : node.parentElement;
    const block = element ? blockOf(element) : null;
    if (block) showToolbarFor(block);
  });

  window.addEventListener("scroll", () => {
    if (activeBlock) positionToolbar(activeBlock);
  });

  // Keep the sign-in state fresh so the toolbar can tell the reader to
  // sign in before trying to spend their own Pollen.
  (async () => {
    const response = await send("status");
    signedIn = Boolean(response?.signedIn);
  })();

  // The reader may sign in from the popup while this page is open; the
  // control should notice and become usable straight away.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (!("stretchtext.token" in changes)) return;
      signedIn = Boolean(changes["stretchtext.token"].newValue);
      if (activeBlock) showToolbarFor(activeBlock);
    });
  }
})();
