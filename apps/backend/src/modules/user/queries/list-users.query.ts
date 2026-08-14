import { IQuery, QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { UserRepository } from '../repositories/user.repository';
import { UserTransformer } from '../transformers/user.transformer';
import { IUserResponse } from '../interfaces/user.interface';

export interface PagedUsers {
  data: IUserResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export class ListUsersQuery implements IQuery {
  constructor(
    public readonly page: number = 1,
    public readonly limit: number = 20,
  ) {}
}

@QueryHandler(ListUsersQuery)
export class ListUsersHandler implements IQueryHandler<
  ListUsersQuery,
  PagedUsers
> {
  constructor(private readonly userRepo: UserRepository) {}

  async execute(query: ListUsersQuery): Promise<PagedUsers> {
    const result = await this.userRepo.findAll(query.page, query.limit);
    return {
      data: UserTransformer.toResponseList(result.data),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }
}
