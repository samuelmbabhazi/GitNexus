import { Delete, Get, Res } from '@nestjs/common';

/**
 * The CRUD handlers every resource controller shares. The class lives in a
 * file of its own and has no `@Controller`: NestJS mounts these handlers under
 * the prefix of each controller that extends it, in whichever file that is.
 */
export abstract class CrudController<T> {
  @Get()
  findEvery(): T[] {
    return [];
  }

  @Get(':id')
  findById(): T | undefined {
    return undefined;
  }

  @Delete(':id')
  destroy(): void {}
}

/**
 * A second base class of this file, with a `findEvery` of its own: the name
 * alone does not say which class a controller inherits that handler from.
 */
export abstract class ReadOnlyController<T> {
  @Get()
  findEvery(): T[] {
    return [];
  }

  @Get('summary')
  summary(@Res() res: { json(body: unknown): void }): void {
    res.json({ items: [], total: 0 });
  }
}
