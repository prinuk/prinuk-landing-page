// Resolve order-site links to the matching environment so test/preview
// deployments link to their own order page instead of production.
(() => {
  const host = location.hostname;

  // Production landing host keeps the absolute production order links as-is.
  if (host === "prinuk.co.il" || host === "www.prinuk.co.il") {
    return;
  }

  // Test landing host points at the test order site; every other host
  // (Vercel preview, *.vercel.app, localhost) serves the order page from the
  // same origin at "/order/", so a relative path is correct there.
  const target =
    host === "test.prinuk.co.il"
      ? "https://test.order.prinuk.co.il/"
      : "/order/";

  document.querySelectorAll("[data-order-link]").forEach((link) => {
    link.setAttribute("href", target);
  });
})();

const form = document.querySelector("#orderForm");
const note = document.querySelector("#formNote");

form?.addEventListener("submit", (event) => {
  event.preventDefault();

  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  const phone = String(data.get("phone") || "").trim();
  const items = String(data.get("items") || "").trim();
  const method = String(data.get("method") || "איסוף מהמכירה").trim();

  if (!items) {
    note.textContent = "כדאי לכתוב לפחות כמה מוצרים להזמנה.";
    form.elements.namedItem("items")?.focus();
    return;
  }

  const lines = [
    "שלום פרינוּק, אשמח לבצע הזמנה למכירה השבועית:",
    name ? `שם: ${name}` : "",
    phone ? `טלפון: ${phone}` : "",
    `אופן קבלה: ${method}`,
    "",
    `רשימת מוצרים: ${items}`,
  ].filter(Boolean);

  note.textContent = "מעביר לוואטסאפ עם ההודעה המוכנה...";
  window.open(`https://wa.me/972535234975?text=${encodeURIComponent(lines.join("\n"))}`, "_blank", "noopener");
});
