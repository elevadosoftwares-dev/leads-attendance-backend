import { AppError } from '../../utils/AppError';
import { toUserDto, type UserDto } from '../users/users.mapper';
import { findUserById } from '../users/users.repository';
import * as meRepo from './me.repository';

export async function getProfile(userId: number): Promise<UserDto> {
  const user = await findUserById(userId);
  if (!user || !user.IsActive) throw AppError.unauthorized('Account is not active');
  return toUserDto(user);
}

export async function registerDeviceToken(
  userId: number,
  fcmToken: string,
  platform: string,
  silent: boolean,
): Promise<void> {
  await meRepo.upsertDeviceToken(userId, fcmToken, platform, silent);
}
