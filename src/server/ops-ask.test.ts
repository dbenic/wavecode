import { describe, expect, it } from 'vitest';
import { askNeedsOwner, asksToChangeData } from './ops-ask.js';

describe('asksToChangeData', () => {
  it('keeps a read with the scout', () => {
    expect(asksToChangeData('what is the payroll total for hipsl')).toBe(false);
    expect(asksToChangeData('show GL totals for last month')).toBe(false);
    expect(asksToChangeData('what is the payroll total for September')).toBe(false);
    expect(asksToChangeData('show GL balance 1200')).toBe(false);
  });

  it('sends inflected changes, writes, and deletes to the owner', () => {
    for (const question of [
      'deleted invoice 4',
      'changed the posted amount',
      'updated the customer row',
      'set the salary to 0',
      'add a bonus of 500',
      'izbriši račun 4',
      'spremeni knjiženi znesek',
      'dodaj bonus 500',
      'popravi plačo',
      'uvozi podatke',
      'storniraj račun',
      'obriši račun 4',
      'promijeni knjiženi iznos',
      'posodobi stranko',
      'briši vrstico',
    ]) {
      expect(asksToChangeData(question), question).toBe(true);
    }
  });

  it('treats an explicit write as a change, and a clean read as a scout question', () => {
    expect(askNeedsOwner('what is the payroll total for September', 'read')).toBe(false);
    expect(askNeedsOwner('show GL balance 1200', 'read')).toBe(false);
    expect(askNeedsOwner('what is the payroll total for September', 'write')).toBe(true);
    expect(askNeedsOwner('deleted invoice 4', 'read')).toBe(true);
  });
});
