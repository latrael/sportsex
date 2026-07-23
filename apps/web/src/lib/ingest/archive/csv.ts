// A small RFC 4180 CSV reader. The archive's fixtures.csv wraps a whole
// stats blob in one quoted field (embedded commas and quotes), so a naive
// split on `,` would corrupt every row after it — hence a real parser.
//
// Values come back as raw strings; coercion (numbers, the literal "None" that
// the archive writes for null) is the caller's job, in coerce.ts.

export type CsvRow = Record<string, string>;

export function parseCsv(text: string): CsvRow[] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let sawAny = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (c === ',') {
      record.push(field);
      field = '';
      sawAny = true;
    } else if (c === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      sawAny = false;
    } else if (c !== '\r') {
      field += c;
      sawAny = true;
    }
  }
  // Flush a final line with no trailing newline.
  if (sawAny || field.length > 0) {
    record.push(field);
    records.push(record);
  }

  if (records.length === 0) return [];
  const [header, ...rows] = records;
  // Drop blank trailing lines and any row whose column count doesn't line up.
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}
