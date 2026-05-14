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
    "שלום פרינוק, אשמח לבצע הזמנה למכירה השבועית:",
    name ? `שם: ${name}` : "",
    phone ? `טלפון: ${phone}` : "",
    `אופן קבלה: ${method}`,
    "",
    `רשימת מוצרים: ${items}`,
  ].filter(Boolean);

  note.textContent = "מעביר לוואטסאפ עם ההודעה המוכנה...";
  window.open(`https://wa.me/972535234975?text=${encodeURIComponent(lines.join("\n"))}`, "_blank", "noopener");
});
