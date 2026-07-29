const FIELDS = ["endpoint", "secret", "requester", "project"];

chrome.storage.sync.get(FIELDS).then((stored) => {
  for (const key of FIELDS) {
    document.getElementById(key).value = stored[key] || "";
  }
});

document.getElementById("save").addEventListener("click", async () => {
  const values = Object.fromEntries(
    FIELDS.map((key) => [key, document.getElementById(key).value.trim()])
  );
  await chrome.storage.sync.set(values);

  const flag = document.getElementById("saved");
  flag.dataset.on = "1";
  setTimeout(() => delete flag.dataset.on, 1400);
});
