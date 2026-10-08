export const normalizePhone = (value: unknown) => String(value ?? '').trim().replace(/[\s()（）-]/g, '').replace(/^(?:\+86|0086)|^86(?=1[3-9]\d{9}$|0\d{9,11}$)/, '');
export const validPhone = (value: string) => /^(?:1[3-9]\d{9}|0\d{2,3}[1-9]\d{6,7})$/.test(value);
export const registrationName = (fields: Record<string, string>) => ['姓名', '名字', 'name', 'Name'].map(key => fields[key]?.trim()).find(Boolean) || '';
export const registrationKey = (phone: string, name: string) => JSON.stringify([phone, name]);
