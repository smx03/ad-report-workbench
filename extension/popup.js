const DEFAULT_LIST_URL = "https://usergrowth.com.cn/onestop/ad/ad_create?_app_id=482431&ad_platform=toutiao&owners[]=854784967720715__ps574347";

initialize();

async function initialize() {
  const tabs = await chrome.tabs.query({ url: "https://usergrowth.com.cn/onestop/*" });
  document.querySelector("#popup-status").textContent = tabs.length
    ? `扩展已连接，发现 ${tabs.length} 个一站式页面。`
    : "扩展已就绪。请先打开一站式并手动登录。";
}

document.querySelector("#open-dashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: "http://127.0.0.1:4319/" });
});

document.querySelector("#open-usergrowth").addEventListener("click", () => {
  chrome.tabs.create({ url: DEFAULT_LIST_URL });
});
