import { describe, expect, it } from 'vitest';
import { asksToChangeData } from './ops-ask.js';

describe('asksToChangeData', () => {
  it('keeps a read with the scout', () => {
    expect(asksToChangeData('what is the payroll total for hipsl')).toBe(false);
    expect(asksToChangeData('show GL totals for last month')).toBe(false);
  });

  it('sends a change, write, or delete to the owner', () => {
    expect(asksToChangeData('delete invoice 4')).toBe(true);
    expect(asksToChangeData('please write the new balance')).toBe(true);
    expect(asksToChangeData('change the posted amount')).toBe(true);
    expect(asksToChangeData('update the customer row')).toBe(true);
  });
});
