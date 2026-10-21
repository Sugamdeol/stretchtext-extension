# Stretchtext

[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

**Text that grows where the reader wants more, and shrinks back where they don't.**

In 1967 Ted Nelson described *stretchtext*: prose that a reader can pull open
one phrase at a time, so that detail appears exactly where attention is
directed. Writing every level by hand was too much work, so it never caught
on. Generated text makes it cheap.

Stretchtext is a Manifest V3 browser extension that brings that idea to any web
page. Hover a paragraph, click **Expand**, and the text grows **in place** — same
element, same page, same layout, no modal and no new tab. Click **Shrink** and
it condenses back down. Every rewrite is paid for with **the reader's own
Pollen** through the Pollinations device flow; there is no shared key and no
server of ours in the loop.

- **Install:** <https://sugamdeol.github.io/stretchtext-extension/>
- **Store listing / install page:** <https://sugamdeol.github.io/stretchtext-extension/>
- **Manifest V3**, plain JavaScript, no build step, no npm dependencies.
- **License:** MIT.

## Why it exists

Reference points:

- [cc-stretch](https://github.com/pro-vi/cc-stretch) (MIT) — a Claude Code plugin
  that grows and shrinks a reply in place. Its author says they now read about a
  sixth of the words.
- [StretchText on Wikipedia](https://en.wikipedia.org/wiki/StretchText) — the
  original 1967 concept by Ted Nelson.

## How it works

1. The content script walks the page for real text blocks (paragraphs, list
   items, block quotes, captions) that are long enough to be worth stretching
   and not mostly links or navigation.
2. Hovering a block shows a small floating control — **Expand**, **Shrink**,
   **Restore** — positioned right above that block. Selecting text inside a
   block focuses it too. Keyboard: `Alt`+`E` expands, `Alt`+`S` shrinks.
3. **Expand** sends the current text to the Pollinations text API with a
   "stretch" prompt and the result is written back into the *same element* with
   `textContent`, so the page's own typography, width and surroundings stay
   intact. The grown text is a genuinely longer rewrite (roughly 1.6x / 2.2x /
   3.2x by default), not a reworded sentence.
4. **Shrink** asks for a condensed version of the *original* wording, so the
   text walks back down the levels you opened, and **Restore** returns the
   element to its exact original text.
5. Nothing ever happens without an explicit click. The original text of every
   touched block is kept in memory for the life of the page, and the block can
   always be restored.

### Your own Pollen (BYOP)

The extension implements the OAuth **device flow** that the Pollinations docs
recommend for extensions:

1. `POST https://enter.pollinations.ai/api/device/code` with the publishable
   client id `pk_P4FikAH8k74gG31P`.
2. The popup shows the short `user_code` and opens
   `verification_uri_complete` so the reader can approve in one click.
3. The extension polls `POST https://enter.pollinations.ai/api/device/token`
   until Pollinations returns an `sk_…` access token.
4. The token is stored in `chrome.storage.local` only. It is never written into
   a web page, never put in a URL, and never logged.
5. All API calls are made from the extension's own service worker
   (`background.js`), so the key never touches a page's JavaScript context.
   `content.js` only ever receives the finished text.

Balances are read from `GET https://gen.pollinations.ai/account/balance` and
shown in the popup. The in-page control reports the Pollen spent on the current
page, and the before/after balance around each rewrite.

### Models and cost

Rewrites use the cheap text model `openai/gpt-5.4-nano` through
`POST https://gen.pollinations.ai/v1/chat/completions`. The cost of a rewrite is
deducted from the reader's own Pollen balance; the extension shows the balance
before and after and the running total for the page.

## Install (load unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `extension/` folder of this repo
   (or download `extension.zip` from the install page and unpack it first).
5. Pin "Stretchtext" to your toolbar, click it, and choose
   **Sign in with your own Pollen**.

No build step, no `npm install`, no bundler. The `extension/` directory is the
extension.

## Permissions, and why they are there

| Permission | Why |
| --- | --- |
| `storage` | Keeps the reader's Pollen key and their verbosity preference in `chrome.storage.local`. Never synced, never sent anywhere except Pollinations. |
| `host_permissions: https://gen.pollinations.ai/*` | The text API and balance endpoint. |
| `host_permissions: https://enter.pollinations.ai/*` | Device-flow sign-in and the userinfo endpoint. |
| Content script on `http://*/*` and `https://*/*` | The whole point of the extension: it has to be able to read the text of the page you are reading and rewrite that block in place. It only ever touches ordinary text blocks, and only ever after you click. |

No `<all_urls>` permission is requested and no background page script runs on
sites. The content script sends no page content anywhere until you press
**Expand** or **Shrink**, and even then only the single block you acted on
travels — to Pollinations, over the network, to be rewritten.

## Repository layout

```
extension/            the loadable Manifest V3 extension
  manifest.json
  background.js       service worker: device flow, token storage, API calls
  content.js          in-page control and the in-place rewrite
  content.css
  popup.html          the toolbar popup: sign-in, balance, settings, explainer
  popup.css
  popup.js
  icons/icon16.png, icon48.png, icon128.png
docs/screenshot.png   the screenshot shown on the install page
index.html            the install page (GitHub Pages)
site.css              styles for the install page
extension.zip         the extension, packaged for download
```

## Credits

Built with [pollinations.ai](https://pollinations.ai/?ref=badge) — thanks to the
Pollinations team for the API, the text models and the Pollen balance that make
reader-paid stretchtext possible.
