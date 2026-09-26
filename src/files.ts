export function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field");
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
const escapeIcs = (value: string) =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", "")
    .replaceAll("\n", "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");
const stamp = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
export function calendar(
  occasions: {
    id: string | number;
    title: string;
    starts_at: string;
    venue_name?: string;
    place?: string;
  }[],
) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Invibox//Event Calendar//EN",
    "CALSCALE:GREGORIAN",
  ];
  for (const o of occasions)
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeIcs(String(o.id))}@invibox`,
      `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(new Date(o.starts_at))}`,
      `SUMMARY:${escapeIcs(o.title)}`,
      `LOCATION:${escapeIcs(o.venue_name || o.place || "")}`,
      "END:VEVENT",
    );
  lines.push("END:VCALENDAR");
  // RFC 5545 folds at 75 octets without splitting Unicode code points.
  return (
    lines
      .map((line) => {
        let result = "",
          length = 0;
        for (const char of line) {
          const bytes = new TextEncoder().encode(char).length;
          if (length + bytes > 75) {
            result += "\r\n ";
            length = 1;
          }
          result += char;
          length += bytes;
        }
        return result;
      })
      .join("\r\n") + "\r\n"
  );
}
