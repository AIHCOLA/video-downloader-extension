chrome.runtime.sendMessage({ type: "PING" }, (resp) => {
  document.getElementById("h").textContent = "DUMMY OK " + JSON.stringify(resp);
});
