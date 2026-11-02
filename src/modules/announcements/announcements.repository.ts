import { createRequest, sql } from '../../db/pool';
import type { AnnouncementCategory } from './announcements.schemas';

export interface AnnouncementRow {
  AnnouncementId: number;
  Title: string;
  Body: string;
  Category: AnnouncementCategory;
  IsPinned: boolean;
  CreatedUtc: Date;
  CreatedBy: number;
  AuthorName: string;
}

const SELECT = `
  SELECT a.AnnouncementId, a.Title, a.Body, a.Category, a.IsPinned, a.CreatedUtc, a.CreatedBy, u.Name AS AuthorName
    FROM dbo.Announcements a JOIN dbo.Users u ON u.UserId = a.CreatedBy`;

export async function listPinned(category?: AnnouncementCategory): Promise<AnnouncementRow[]> {
  const request = await createRequest();
  const result = await request.input('category', sql.NVarChar(20), category ?? null).query<AnnouncementRow>(
    `${SELECT} WHERE a.IsDeleted = 0 AND a.IsPinned = 1 AND (@category IS NULL OR a.Category = @category)
       ORDER BY a.CreatedUtc DESC, a.AnnouncementId DESC`,
  );
  return result.recordset;
}

export async function listUnpinned(
  category: AnnouncementCategory | undefined,
  page: number,
  pageSize: number,
): Promise<{ rows: AnnouncementRow[]; total: number }> {
  const request = await createRequest();
  request
    .input('category', sql.NVarChar(20), category ?? null)
    .input('offset', sql.Int, (page - 1) * pageSize)
    .input('pageSize', sql.Int, pageSize);
  const where = 'WHERE a.IsDeleted = 0 AND a.IsPinned = 0 AND (@category IS NULL OR a.Category = @category)';
  const result = await request.query(
    `SELECT COUNT(*) AS Total FROM dbo.Announcements a ${where};
     ${SELECT} ${where}
     ORDER BY a.CreatedUtc DESC, a.AnnouncementId DESC
     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;`,
  );
  const recordsets = result.recordsets as unknown as [[{ Total: number }], AnnouncementRow[]];
  return { total: recordsets[0][0].Total, rows: recordsets[1] };
}

export async function findAnnouncement(id: number): Promise<AnnouncementRow | null> {
  const request = await createRequest();
  const result = await request
    .input('id', sql.Int, id)
    .query<AnnouncementRow>(`${SELECT} WHERE a.AnnouncementId = @id AND a.IsDeleted = 0`);
  return result.recordset[0] ?? null;
}

export interface NewAnnouncement {
  title: string;
  body: string;
  category: AnnouncementCategory;
  isPinned: boolean;
  createdBy: number;
}

export async function insertAnnouncement(a: NewAnnouncement): Promise<number> {
  const request = await createRequest();
  const result = await request
    .input('title', sql.NVarChar(200), a.title)
    .input('body', sql.NVarChar(sql.MAX), a.body)
    .input('category', sql.NVarChar(20), a.category)
    .input('isPinned', sql.Bit, a.isPinned)
    .input('createdBy', sql.Int, a.createdBy)
    .query<{ AnnouncementId: number }>(
      `INSERT INTO dbo.Announcements (Title, Body, Category, IsPinned, CreatedBy)
       OUTPUT INSERTED.AnnouncementId
       VALUES (@title, @body, @category, @isPinned, @createdBy)`,
    );
  return result.recordset[0]!.AnnouncementId;
}

export type AnnouncementUpdate = Partial<Omit<NewAnnouncement, 'createdBy'>>;

/** Returns false when the announcement doesn't exist or was deleted. */
export async function updateAnnouncement(id: number, changes: AnnouncementUpdate): Promise<boolean> {
  const request = await createRequest();
  const sets: string[] = [];
  if (changes.title !== undefined) {
    request.input('title', sql.NVarChar(200), changes.title);
    sets.push('Title = @title');
  }
  if (changes.body !== undefined) {
    request.input('body', sql.NVarChar(sql.MAX), changes.body);
    sets.push('Body = @body');
  }
  if (changes.category !== undefined) {
    request.input('category', sql.NVarChar(20), changes.category);
    sets.push('Category = @category');
  }
  if (changes.isPinned !== undefined) {
    request.input('isPinned', sql.Bit, changes.isPinned);
    sets.push('IsPinned = @isPinned');
  }
  sets.push('UpdatedUtc = SYSUTCDATETIME()');
  const result = await request
    .input('id', sql.Int, id)
    .query(`UPDATE dbo.Announcements SET ${sets.join(', ')} WHERE AnnouncementId = @id AND IsDeleted = 0`);
  return result.rowsAffected[0] === 1;
}

export async function softDeleteAnnouncement(id: number): Promise<boolean> {
  const request = await createRequest();
  const result = await request.input('id', sql.Int, id).query(
    `UPDATE dbo.Announcements SET IsDeleted = 1, UpdatedUtc = SYSUTCDATETIME()
       WHERE AnnouncementId = @id AND IsDeleted = 0`,
  );
  return result.rowsAffected[0] === 1;
}
