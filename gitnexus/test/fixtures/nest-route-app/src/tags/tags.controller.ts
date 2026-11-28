import { Controller, Get, Res } from '@nestjs/common';
import { ReadOnlyController } from '../shared';

interface Tag {
  id: string;
}

/**
 * Extends the second base class of `crud.controller.ts`. Its own route answers
 * with other keys than the `summary` it inherits.
 */
@Controller('tags')
export class TagsController extends ReadOnlyController<Tag> {
  @Get('popular')
  popular(@Res() res: { json(body: unknown): void }): void {
    res.json({ tags: [], days: 7 });
  }
}
