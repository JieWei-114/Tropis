import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListRolesQueryDto } from '../dto/list-roles-query.dto';

const errorsFor = async (query: Record<string, string>) =>
  (await validate(plainToInstance(ListRolesQueryDto, query))).map(
    (e) => e.property,
  );

describe('ListRolesQueryDto', () => {
  it('accepts pageSize 0, which means the default page size', async () => {
    expect(await errorsFor({ pageSize: '0' })).toEqual([]);
  });

  it('rejects a negative or fractional pageSize', async () => {
    expect(await errorsFor({ pageSize: '-1' })).toEqual(['pageSize']);
    expect(await errorsFor({ pageSize: '1.5' })).toEqual(['pageSize']);
  });
});
