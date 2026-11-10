import { AppError } from './AppError';

/** Shifts run within one work date, so the end must be later than the start (both `HH:mm`). */
export function assertShiftOrder(shiftStart: string, shiftEnd: string, field: string): void {
  if (shiftEnd > shiftStart) return;
  const message = `must be later than the shift start (${shiftStart})`;
  throw AppError.validation(`Shift end ${message}`, { fields: [{ field, message }] });
}
