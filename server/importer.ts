import readExcelFile from 'read-excel-file/node';
import { parse } from 'csv-parse/sync';
import mammoth from 'mammoth';
import { load } from 'cheerio';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import path from 'node:path';

export type PersonInput = { phone: string; fields: Record<string, string> };
export type ImportPreview = { records: PersonInput[]; warnings: string[] };
export const normalizePhone = (value: unknown) => String(value ?? '').trim().replace(/^\+?86[ -]?/, '').replace(/[\s()-]/g, '');
export const validPhone = (value: string) => /^1[3-9]\d{9}$/.test(value);
const phonePattern = /(?<!\d)(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)/g;

function readRows(rows: string[][], label: string, result: ImportPreview) {
  const populated = rows.filter(row => row.some(cell => cell.trim()));
  if (!populated.length) return;
  const first = populated[0];
  const phoneColumn = first.findIndex(cell => /^(手机号码?|联系电话|电话|phone|mobile)$/i.test(cell.trim()));
  const hasHeader = phoneColumn >= 0 || !validPhone(normalizePhone(first[0]));
  const index = phoneColumn >= 0 ? phoneColumn : 0;
  const headers = hasHeader ? first.map((cell, i) => cell.trim() || `字段${i + 1}`) : first.map((_, i) => i === index ? '手机号' : `信息${i}`);
  if (new Set(headers).size !== headers.length) throw new Error(`${label}有重复列名，请先为每列设置不同名称。`);
  for (let i = hasHeader ? 1 : 0; i < populated.length; i++) {
    const row = populated[i];
    const phone = normalizePhone(row[index]);
    if (!validPhone(phone)) {
      result.warnings.push(`${label}第 ${i + 1} 行：手机号无效，已跳过。`);
      continue;
    }
    result.records.push({ phone, fields: Object.fromEntries(row.flatMap((value, j) => j !== index && value.trim() ? [[headers[j] || `字段${j + 1}`, value.trim()]] : [])) });
  }
}

function readText(text: string, label: string, result: ImportPreview) {
  const countBefore = result.records.length;
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const tableLines = lines.filter(line => line.includes('\t') || line.includes('|'));
  // A delimited document table keeps the original headings and every column.
  if (tableLines.length > 1 && tableLines.some(line => /手机|电话|phone|mobile/i.test(line))) {
    readRows(tableLines.map(line => line.split(/\t+|\|/).map(value => value.trim()).filter(Boolean)), label, result);
    const otherLines = lines.filter(line => !tableLines.includes(line));
    if (otherLines.some(line => [...line.matchAll(phonePattern)].length)) {
      readText(otherLines.join('\n'), label, result);
    }
    return;
  }
  let current: { phone: string; lines: string[] } | null = null;
  const finish = () => {
    if (!current) return;
    const content = current.lines.join('\n');
    const entries = [...content.matchAll(/(?:^|\n|\s+)([^\s：:]{1,20})[：:]\s*([^\n]*?)(?=\s+[^\s：:]{1,20}[：:]|\n|$)/g)]
      .filter(match => !/手机|电话|phone|mobile/i.test(match[1]))
      .map(match => [match[1], match[2].trim()]);
    result.records.push({ phone: current.phone, fields: { ...Object.fromEntries(entries), '原始登记信息': content } });
  };
  for (const line of lines) {
    const phones = [...line.matchAll(phonePattern)];
    if (phones.length > 1) {
      finish(); current = null;
      result.warnings.push(`${label}有一行包含多个手机号，无法可靠对应，已跳过：${line.slice(0, 60)}`);
    } else if (phones.length === 1) {
      finish(); current = { phone: normalizePhone(phones[0][0]), lines: [line] };
    } else if (current) current.lines.push(line);
  }
  finish();
  if (result.records.length > countBefore) result.warnings.push(`${label}按“手机号开头的一段资料”识别，请在预览中核对每个人的信息。`);
}

export async function parseImport(buffer: Buffer, filename: string): Promise<ImportPreview> {
  const result: ImportPreview = { records: [], warnings: [] };
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.xlsx') {
    const sheets = await readExcelFile(buffer).catch(cause => {
      throw new Error('Excel 文件无法读取，请确认是有效的 .xlsx 文件，或用 Excel / WPS 重新另存为 .xlsx 后上传。', { cause });
    });
    for (const sheet of sheets) {
      const rows = sheet.data.map(row => row.map(value => value instanceof Date ? value.toISOString().replace(/T00:00:00\.000Z$/, '') : String(value ?? '')));
      readRows(rows, `工作表“${sheet.sheet}”`, result);
    }
  } else if (ext === '.csv') {
    readRows(parse(buffer.toString('utf8'), { bom: true, skip_empty_lines: true, relax_column_count: true }), 'CSV', result);
  } else if (ext === '.docx') {
    const { value } = await mammoth.convertToHtml({ buffer });
    const $ = load(value);
    $('table').each((index, table) => {
      const rows: string[][] = [];
      $(table).find('tr').each((_, row) => { rows.push($(row).find('th,td').map((__, cell) => $(cell).text()).get()); });
      readRows(rows, `Word 表格 ${index + 1}`, result);
    });
    $('table').remove();
    readText($('p').map((_, paragraph) => $(paragraph).text()).get().join('\n'), 'Word 正文', result);
  } else if (ext === '.pdf') {
    const task = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
    const pdf = await task.promise;
    try {
      if (pdf.numPages > 100) throw new Error('PDF 最多支持 100 页，请拆分后上传。');
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const lines = new Map<number, { x: number; width: number; text: string }[]>();
        for (const item of content.items) {
          if (!('str' in item) || !item.str.trim()) continue;
          const y = Math.round(item.transform[5] / 3) * 3;
          const line = lines.get(y) || [];
          line.push({ x: item.transform[4], width: item.width, text: item.str }); lines.set(y, line);
        }
        const text = [...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, items]) => {
          const ordered = items.sort((a, b) => a.x - b.x);
          return ordered.map((item, i) => `${i && item.x - ordered[i - 1].x - ordered[i - 1].width > 14 ? '\t' : ''}${item.text}`).join('');
        }).join('\n');
        readText(text, `PDF 第 ${pageNumber} 页`, result);
      }
    } finally { await task.destroy(); }
  } else {
    throw new Error('请上传 .xlsx、.csv、.docx 或文字版 .pdf。旧版 .xls / .doc 请先另存为新版格式。');
  }
  const unique = new Map<string, PersonInput>();
  for (const record of result.records) {
    if (unique.has(record.phone)) result.warnings.push(`手机号 ${record.phone} 在文件中重复，保留首次出现的资料。`);
    else unique.set(record.phone, record);
  }
  result.records = [...unique.values()];
  if (result.records.length > 10000) throw new Error('每次最多导入 10,000 人，请拆分文件。');
  if (!result.records.length) throw new Error('未找到有效手机号。表格请将手机号放在第一列；正文请按“手机号 + 个人资料”分段。扫描件 PDF 请先转成文字版或 Excel。');
  return result;
}
