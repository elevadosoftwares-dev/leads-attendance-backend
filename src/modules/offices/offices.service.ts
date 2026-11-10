import { fromTimeColumn, withTransaction } from '../../db/pool';
import { realtime } from '../../services/realtime.service';
import { assertShiftOrder } from '../../utils/shift';
import { companyTimezone, setCompanyTimezone } from '../../utils/time';
import { requireDefaultOffice } from '../auth/auth.service';
import * as repo from './offices.repository';
import type { UpdateOfficeInput } from './offices.schemas';

export async function getOfficeSettings(): Promise<repo.OfficeSettingsDto> {
  return repo.toOfficeSettingsDto(await requireDefaultOffice());
}

/**
 * Super admin only (enforced by the route). New geofence and grace minutes apply to the next clock-in;
 * attendance already recorded is not re-evaluated. A new timezone applies at once to work dates, lateness and the
 * job schedules; apps pick it up from the user profile.
 */
export async function updateOfficeSettings(input: UpdateOfficeInput): Promise<repo.OfficeSettingsDto> {
  const { applyShiftToAllUsers, ...changes } = input;
  const office = await requireDefaultOffice();
  const shiftStart = changes.defaultShiftStart ?? fromTimeColumn(office.DefaultShiftStart);
  const shiftEnd = changes.defaultShiftEnd ?? fromTimeColumn(office.DefaultShiftEnd);
  assertShiftOrder(shiftStart, shiftEnd, 'defaultShiftEnd');
  await withTransaction(async (tx) => {
    await repo.updateOffice(office.OfficeId, changes, tx);
    // Both times, so nobody is left with a start after their old end (or the reverse).
    if (applyShiftToAllUsers) await repo.setShiftForOffice(office.OfficeId, { shiftStart, shiftEnd }, tx);
  });
  if (changes.timezone) setCompanyTimezone(changes.timezone);
  realtime.attendanceChanged();
  return getOfficeSettings();
}

/** Makes the office's timezone the company timezone (called at startup). */
export async function loadCompanyTimezone(): Promise<string> {
  const office = await repo.findDefaultOffice();
  if (office) setCompanyTimezone(office.Timezone);
  return companyTimezone();
}
