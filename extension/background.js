/*
 * Stretchtext background service worker.
 *
 * All network calls to Pollinations happen here so that the reader's secret
 * key never leaves the extension's own origin and never reaches a web page.
 * The Pollen key lives in chrome.storage.local and is only ever attached as a
 * Bearer header to requests aimed at the Pollinations API.
 */

const GEN_BASE = "https://gen.pollinations.ai";
const ENTER_BASE = "https://enter.pollinations.ai";
const CLIENT_ID = "pk_P4FikAH8k74gG31P";
const DEFAULT_MODEL = "openai/gpt-5.4-nano";

const KEY_TOKEN = "stretchtext.token";
const KEY_USERNAME = "stretchtext.username";
const KEY_BALANCE = "stretchtext.balance";
const KEY_VERBOSITY = "stretchtext.verbosity";
const KEY_DEVICE = "stretchtext.device";

const VERBOSITY = {
  light: { factor: 1.6, label: "Light" },
  medium: { factor: 2.2, label: "Medium" },
  heavy: { factor: 3.2, label: "Heavy" },
};

async function getToken() {
  const data = await chrome.storage.local.get(KEY_TOKEN);
  return data[KEY_TOKEN] || null;
}

async function getVerbosity() {
  const data = await chrome.storage.local.get(KEY_VERBOSITY);
  const value = data[KEY_VERBOSITY];
  return VERBOSITY[value] ? value : "medium";
}

async function setVerbosity(value) {
  if (!VERBOSITY[value]) return false;
  await chrome.storage.local.set({ [KEY_VERBOSITY]: value });
  return true;
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const detail =
      (parsed && (parsed.error?.message || parsed.error || parsed.message)) ||
      text ||
      `HTTP ${response.status}`;
    const error = new Error(String(detail).slice(0, 400));
    error.status = response.status;
    throw error;
  }
  return parsed;
}

async function fetchBalance() {
  const token = await getToken();
  if (!token) return null;
  const data = await apiFetch(`${GEN_BASE}/account/balance`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const total = Number(data?.accountBalance?.total);
  const balance = Number.isFinite(total) ? total : null;
  if (balance !== null) {
    await chrome.storage.local.set({ [KEY_BALANCE]: balance });
  }
  return balance;
}

async function fetchUser() {
  const token = await getToken();
  if (!token) return null;
  try {
    const data = await apiFetch(`${ENTER_BASE}/api/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const username = data?.preferred_username || data?.name || "reader";
    await chrome.storage.local.set({ [KEY_USERNAME]: username });
    return username;
  } catch {
    return (await chrome.storage.local.get(KEY_USERNAME))[KEY_USERNAME] || null;
  }
}

async function status() {
  const token = await getToken();
  const data = await chrome.storage.local.get([
    KEY_USERNAME,
    KEY_BALANCE,
    KEY_VERBOSITY,
  ]);
  return {
    signedIn: Boolean(token),
    username: data[KEY_USERNAME] || null,
    balance: data[KEY_BALANCE] ?? null,
    verbosity: VERBOSITY[data[KEY_VERBOSITY]] ? data[KEY_VERBOSITY] : "medium",
  };
}

/* ------------------------------------------------------------------ */
/* Device flow (bring your own Pollen)                                 */
/* ------------------------------------------------------------------ */

async function deviceStart() {
  const data = await apiFetch(`${ENTER_BASE}/api/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  const record = {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete,
    expiresIn: data.expires_in || 900,
    interval: Math.max(2, Number(data.interval) || 5),
    startedAt: Date.now(),
  };
  await chrome.storage.local.set({ [KEY_DEVICE]: record });
  return {
    userCode: record.userCode,
    verificationUri: record.verificationUri,
    verificationUriComplete: record.verificationUriComplete,
    expiresIn: record.expiresIn,
    interval: record.interval,
  };
}

async function devicePoll() {
  const data = await chrome.storage.local.get(KEY_DEVICE);
  const record = data[KEY_DEVICE];
  if (!record || !record.deviceCode) {
    return { status: "error", error: "No sign-in is in progress." };
  }
  if (Date.now() - record.startedAt > (record.expiresIn + 30) * 1000) {
    await chrome.storage.local.remove(KEY_DEVICE);
    return { status: "expired", error: "The sign-in code expired. Start again." };
  }
  let result;
  try {
    result = await apiFetch(`${ENTER_BASE}/api/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: record.deviceCode }),
    });
  } catch (error) {
    // The endpoint answers 400 with a JSON body while the user has not
    // approved yet, so a failed request is not necessarily fatal.
    result = { error: error.message };
  }
  const code = result?.error;
  if (result?.access_token) {
    await chrome.storage.local.set({
      [KEY_TOKEN]: result.access_token,
      [KEY_USERNAME]: null,
    });
    await chrome.storage.local.remove(KEY_DEVICE);
    const username = await fetchUser();
    let balance = null;
    try {
      balance = await fetchBalance();
    } catch {
      balance = null;
    }
    return { status: "done", username, balance };
  }
  if (code === "authorization_pending" || code === "slow_down") {
    return { status: "pending", userCode: record.userCode };
  }
  if (code === "expired_token" || code === "access_denied") {
    await chrome.storage.local.remove(KEY_DEVICE);
    return { status: "error", error: `Sign-in failed: ${code}.` };
  }
  return {
    status: "pending",
    userCode: record.userCode,
    error: code ? String(code) : undefined,
  };
}

async function signOut() {
  await chrome.storage.local.remove([
    KEY_TOKEN,
    KEY_USERNAME,
    KEY_BALANCE,
    KEY_DEVICE,
  ]);
  return { signedIn: false };
}

/* ------------------------------------------------------------------ */
/* The rewrite itself                                                  */
/* ------------------------------------------------------------------ */

function buildPrompt(text, mode, factor) {
  if (mode === "shrink") {
    return [
      "You compress a passage for a reader who wants less of it.",
      "Rewrite the passage so it is roughly 40% of its original length while keeping",
      "every key fact, name, number and conclusion. Drop examples, repetition and",
      "filler. Keep the original language and tone.",
      "Output only the rewritten passage: no preamble, no quotes, no notes.",
      "",
      "PASSAGE:",
      text,
    ].join("\n");
  }
  const target = Math.round(text.length * factor);
  return [
    "You are a stretchtext engine (Ted Nelson, 1967): text that grows where the",
    "reader wants more.",
    `Rewrite the passage so it becomes about ${factor}x longer, roughly ${target} characters,`,
    "by adding concrete specifics, context, examples, qualifications and mechanism —",
    "the kind of detail a reader wants when they ask for more.",
    "Rules: keep every fact in the original and never contradict it; keep the",
    "original language and tone; prefer concrete detail over vague padding; do not",
    "invent specific names, dates, statistics or citations that are not in the",
    "passage; do not add headings or bullet lists; do not address the reader.",
    "Output only the rewritten passage: no preamble, no quotes, no notes.",
    "",
    "PASSAGE:",
    text,
  ].join("\n");
}

async function rewrite(payload) {
  const text = String(payload?.text || "").trim();
  const mode = payload?.mode === "shrink" ? "shrink" : "expand";
  if (!text) {
    return { ok: false, error: "There is no text to rewrite." };
  }
  const token = await getToken();
  if (!token) {
    return {
      ok: false,
      needsSignIn: true,
      error:
        "Sign in with your own Pollen first (open the Stretchtext popup). Nothing is rewritten without your key.",
    };
  }
  const verbosityKey = await getVerbosity();
  const factor = VERBOSITY[verbosityKey].factor;

  const before = await fetchBalance().catch(() => null);
  const maxTokens = mode === "shrink" ? 500 : 1400;
  const data = await apiFetch(`${GEN_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [{ role: "user", content: buildPrompt(text, mode, factor) }],
      max_tokens: maxTokens,
      temperature: 0.4,
    }),
  });
  let rewritten =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    "";
  if (typeof rewritten !== "string") rewritten = "";
  rewritten = rewritten.trim();
  if (!rewritten) {
    return { ok: false, error: "The model returned an empty rewrite." };
  }
  const after = await fetchBalance().catch(() => null);
  const spent =
    before !== null && after !== null ? Math.max(0, before - after) : null;
  return {
    ok: true,
    text: rewritten,
    mode,
    before,
    after,
    spent,
    verbosity: verbosityKey,
    model: DEFAULT_MODEL,
  };
}

/* ------------------------------------------------------------------ */
/* Messaging                                                           */
/* ------------------------------------------------------------------ */

const HANDLERS = {
  status: () => status(),
  deviceStart: () => deviceStart(),
  devicePoll: () => devicePoll(),
  signOut: () => signOut(),
  refreshBalance: async () => ({ balance: await fetchBalance() }),
  refreshUser: async () => ({ username: await fetchUser() }),
  setVerbosity: async (payload) => ({
    ok: await setVerbosity(payload?.value),
    verbosity: await getVerbosity(),
  }),
  rewrite: (payload) => rewrite(payload),
  openPopup: async () => {
    try {
      await chrome.action.openPopup();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;
  handler(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) =>
      sendResponse({ ok: false, error: error?.message || String(error) }),
    );
  return true; // keep the message channel open for the async response
});
