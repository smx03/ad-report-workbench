document.querySelectorAll("[data-page]").forEach((button) => {
  button.addEventListener("click", () => {
    const page = button.dataset.page;
    document.querySelectorAll("[data-page]").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelectorAll(".app-page").forEach((item) => item.classList.toggle("hidden", item.id !== `${page}-page`));
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
});
