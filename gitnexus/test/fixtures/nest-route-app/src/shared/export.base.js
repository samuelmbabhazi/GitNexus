import { Get } from '@nestjs/common';

/** Not a base class of any controller; it only shares a method name. */
export class ExportQueue {
  pending() {
    return [];
  }
}

/**
 * Plain JavaScript, where the grammar makes a decorator part of the method it
 * decorates instead of a sibling before it.
 */
export class ExportBase {
  @Get('pending')
  pending() {
    return [];
  }
}
