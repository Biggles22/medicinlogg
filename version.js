globalThis.MEDICINKOLL_VERSION = "34";

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-app-version]").forEach((element) => {
      element.textContent = globalThis.MEDICINKOLL_VERSION;
    });
  });
}
