import { pushService } from '../../services/push.service';
import { AppError } from '../../utils/AppError';
import { isoUtc } from '../../utils/time';
import * as repo from './announcements.repository';
import type {
  AnnouncementCategory,
  CreateAnnouncementInput,
  UpdateAnnouncementInput,
} from './announcements.schemas';

export interface AnnouncementDto {
  id: number;
  title: string;
  body: string;
  category: AnnouncementCategory;
  isPinned: boolean;
  createdUtc: string;
  author: { id: number; name: string };
}

function toDto(row: repo.AnnouncementRow): AnnouncementDto {
  return {
    id: row.AnnouncementId,
    title: row.Title,
    body: row.Body,
    category: row.Category,
    isPinned: row.IsPinned,
    createdUtc: isoUtc(row.CreatedUtc),
    author: { id: row.CreatedBy, name: row.AuthorName },
  };
}

const notFound = () => AppError.notFound('Announcement not found');

export async function list(category: AnnouncementCategory | undefined, page: number, pageSize: number) {
  const [pinned, { rows, total }] = await Promise.all([
    repo.listPinned(category),
    repo.listUnpinned(category, page, pageSize),
  ]);
  return { pinned: pinned.map(toDto), items: rows.map(toDto), page, pageSize, total };
}

export async function get(id: number): Promise<AnnouncementDto> {
  const row = await repo.findAnnouncement(id);
  if (!row) throw notFound();
  return toDto(row);
}

function notifyEveryone(a: AnnouncementDto): void {
  const preview = a.body.length > 140 ? `${a.body.slice(0, 137)}…` : a.body;
  void pushService.notifyAllActive({
    title: a.title,
    body: preview,
    data: { type: 'ANNOUNCEMENT', announcementId: String(a.id), category: a.category },
  });
}

export async function create(adminId: number, input: CreateAnnouncementInput): Promise<AnnouncementDto> {
  const id = await repo.insertAnnouncement({
    title: input.title,
    body: input.body,
    category: input.category,
    isPinned: input.isPinned,
    createdBy: adminId,
  });
  const created = await get(id);
  if (input.notify) notifyEveryone(created);
  return created;
}

export async function update(id: number, input: UpdateAnnouncementInput): Promise<AnnouncementDto> {
  const { notify, ...changes } = input;
  if (!(await repo.updateAnnouncement(id, changes))) throw notFound();
  const updated = await get(id);
  if (notify) notifyEveryone(updated);
  return updated;
}

export async function remove(id: number): Promise<void> {
  if (!(await repo.softDeleteAnnouncement(id))) throw notFound();
}
