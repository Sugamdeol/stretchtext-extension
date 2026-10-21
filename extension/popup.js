/* Stretchtext popup: sign-in (device flow), balance, settings, explainer. */

const $ = (id) => document.getElementById(id);

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

let pollTimer = null;

function showError(message) {
  const element = $("signin-error");
  element.textContent = message;
  element.hidden = !message;
}

function renderStatus(response) {
  const signedIn = Boolean(response?.signedIn);
  $("signed-out").hidden = signedIn;
  $("signed-in").hidden = !signedIn;
  if (signedIn) {
    $("username").textContent = response.username || "reader";
    $("balance").textContent =
      response.balance === null || response.balance === undefined
        ? "—"
        : `${response.balance} 🌾`;
  }
  if (response?.verbosity) {
    $("verbosity").value = response.verbosity;
  }
  return signedIn;
}

async function refresh() {
  const response = await send("status");
  renderStatus(response);
}

async function refreshBalance() {
  const response = await send("refreshBalance");
  if (response?.ok && response.balance !== null && response.balance !== undefined) {
    $("balance").textContent = `${response.balance} 🌾`;
  }
}

async function startSignIn() {
  showError("");
  $("signin").disabled = true;
  $("signin").textContent = "Starting…";
  const response = await send("deviceStart");
  if (!response?.ok) {
    showError(response?.error || "Could not start sign-in.");
    $("signin").disabled = false;
    $("signin").textContent = "Sign in with your own Pollen";
    return;
  }
  $("signin-step").hidden = false;
  $("user-code").textContent = `Code: ${response.userCode}`;
  $("verify-link").href = response.verificationUriComplete || response.verificationUri;
  $("signin-hint").textContent =
    "Open the verification page, enter the code if it is not prefilled, then approve.";
  $("signin-status").textContent = "Waiting for you to approve…";
  $("signin").hidden = true;
  startPolling(response.interval || 5);
}

function startPolling(intervalSeconds) {
  if (pollTimer) clearInterval(pollTimer);
  const interval = Math.max(2, intervalSeconds) * 1000;
  pollTimer = setInterval(async () => {
    const response = await send("devicePoll");
    if (!response?.ok) {
      $("signin-status").textContent = response?.error || "Sign-in failed.";
      clearInterval(pollTimer);
      pollTimer = null;
      $("signin").hidden = false;
      $("signin").disabled = false;
      $("signin").textContent = "Sign in with your own Pollen";
      return;
    }
    if (response.status === "pending") {
      $("signin-status").textContent = "Waiting for you to approve…";
      return;
    }
    if (response.status === "done") {
      clearInterval(pollTimer);
      pollTimer = null;
      $("signin-step").hidden = true;
      $("signin").hidden = false;
      $("signin").disabled = false;
      $("signin").textContent = "Sign in with your own Pollen";
      await refresh();
      $("balance").textContent =
        response.balance === null || response.balance === undefined
          ? "—"
          : `${response.balance} 🌾`;
      return;
    }
    clearInterval(pollTimer);
    pollTimer = null;
    showError(response?.error || "Sign-in failed.");
    $("signin").hidden = false;
    $("signin").disabled = false;
    $("signin").textContent = "Sign in with your own Pollen";
  }, interval);
}

$("signin").addEventListener("click", startSignIn);

$("refresh").addEventListener("click", async () => {
  $("refresh").disabled = true;
  await refreshBalance();
  $("refresh").disabled = false;
});

$("signout").addEventListener("click", async () => {
  await send("signOut");
  await refresh();
});

$("verbosity").addEventListener("change", async (event) => {
  await send("setVerbosity", { value: event.target.value });
  const labels = {
    light: "Light: each expand adds roughly 60% more text.",
    medium: "Medium: each expand adds roughly 120% more text.",
    heavy: "Heavy: each expand adds roughly 220% more text.",
  };
  $("cost-note").textContent = labels[event.target.value] || "";
});

(async () => {
  const response = await send("status");
  const signedIn = renderStatus(response);
  if (signedIn) refreshBalance();
})();
