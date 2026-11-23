console.log("[dummy-sw] alive");
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "PING") {
    sendResponse({ ok: true, pong: "hello-from-sw" });
    return true;
  }
});
