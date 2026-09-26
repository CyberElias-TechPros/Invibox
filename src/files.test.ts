import { describe, it, expect } from "vitest";
import { calendar, csvCell, parseCsv } from "./files";
describe("portable file exports", () => {
  it("parses quoted commas, newlines, escaped quotes and BOM", () => {
    expect(
      parseCsv('\uFEFFName,Group\r\n"Ada, Obi","Friends"\r\n"A ""B""\nC",VIP'),
    ).toEqual([
      ["Name", "Group"],
      ["Ada, Obi", "Friends"],
      ['A "B"\nC', "VIP"],
    ]);
  });
  it("rejects incomplete quotes", () =>
    expect(() => parseCsv('Name\n"unfinished')).toThrow());
  it("neutralizes spreadsheet formulas", () => {
    expect(csvCell('=HYPERLINK("bad")')).toBe('"\'=HYPERLINK(""bad"")"');
    expect(csvCell("Ada, Obi")).toBe('"Ada, Obi"');
  });
  it("exports UTC with escaped newlines and valid identifiers", () => {
    const ics = calendar([
      {
        id: "occ_1",
        title: "Dinner\nSUMMARY:injection",
        starts_at: "2027-06-16T18:00:00Z",
        place: "Hall, NYC",
      },
    ]);
    expect(ics).toContain("DTSTART:20270616T180000Z");
    expect(ics).toContain("UID:occ_1@invibox");
    expect(ics).toContain("Dinner\\nSUMMARY:injection");
    expect(ics).toContain("Hall\\, NYC");
  });
});
