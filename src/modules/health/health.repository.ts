import { createRequest } from '../../db/pool';

export async function pingDatabase(): Promise<void> {
  const request = await createRequest();
  await request.query('SELECT 1 AS ok');
}
