import { Module } from '@nestjs/common';
import { SearchModule } from '../../infrastructure/search/search.module';
import { VectorModule } from '../../infrastructure/vector/vector.module';
import { UserSearchService } from './services/user-search.service';
import { UserSimilarityService } from './services/user-similarity.service';
import { UserModule } from './user.module';

/** User search and similarity, for the roles that serve or project them. */
@Module({
  imports: [UserModule, SearchModule.forRoot(), VectorModule.forRoot()],
  providers: [UserSearchService, UserSimilarityService],
  exports: [UserSearchService],
})
export class UserSearchModule {}
