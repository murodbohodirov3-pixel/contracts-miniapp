import { describe, expect, it } from 'vitest';
import { makeXlsx } from './xlsx.js';

describe('XLSX exporter', () => {
  it('writes a ZIP workbook with each requested worksheet', () => {
    const workbook = makeXlsx([{ name: 'Договоры', rows: [['Заголовок'], ['Значение']] }, { name: 'Оплаты', rows: [['Сумма', 100]] }]);
    expect(workbook.subarray(0, 2).toString()).toBe('PK');
    expect(workbook.toString('utf8')).toContain('Договоры');
    expect(workbook.toString('utf8')).toContain('Оплаты');
  });
});
