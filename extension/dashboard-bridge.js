(() => {
  const WEB_SOURCE = "doubao-onestop-web";
  const EXTENSION_SOURCE = "doubao-onestop-extension";

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window || message?.source !== WEB_SOURCE || message?.kind !== "request") return;
    chrome.runtime.sendMessage({ channel: "ONESTOP_DASHBOARD", ...message }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      window.postMessage({
        source: EXTENSION_SOURCE,
        kind: "response",
        requestId: message.requestId,
        ok: !runtimeError && Boolean(response?.ok),
        data: response?.data,
        error: runtimeError?.message || response?.error || "扩展未返回结果",
      }, window.location.origin);
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.channel !== "ONESTOP_PROGRESS") return;
    window.postMessage({ source: EXTENSION_SOURCE, kind: "progress", payload: message.payload }, window.location.origin);
  });
})();
