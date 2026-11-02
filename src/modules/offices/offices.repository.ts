import { createRequest, sql, type Queryable } from '../../db/pool';

export interface OfficeRow {
  OfficeId: number;
  Name: string;
  Address: string;
  Latitude: number;
  Longitude: number;
  RadiusMeters: number;
}

export interface OfficeDto {
  id: number;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

export function toOfficeDto(row: OfficeRow): OfficeDto {
  return {
    id: row.OfficeId,
    name: row.Name,
    address: row.Address,
    latitude: Number(row.Latitude),
    longitude: Number(row.Longitude),
    radiusMeters: row.RadiusMeters,
  };
}

export async function findOfficeForUser(userId: number, db?: Queryable): Promise<OfficeRow | null> {
  const request = await createRequest(db);
  const result = await request.input('userId', sql.Int, userId).query<OfficeRow>(
    `SELECT o.OfficeId, o.Name, o.Address, o.Latitude, o.Longitude, o.RadiusMeters
       FROM dbo.Users u JOIN dbo.Offices o ON o.OfficeId = u.OfficeId
      WHERE u.UserId = @userId`,
  );
  return result.recordset[0] ?? null;
}
