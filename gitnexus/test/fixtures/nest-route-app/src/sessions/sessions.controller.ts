import { Controller, Get } from '@nestjs/common';
import { CrudController } from '../shared';

interface Session {
  id: string;
}

/**
 * A controller written without a name. The parser gives this
 * `export default class` another node type than a named controller, and NestJS
 * registers both the same way: this one serves its own route and the CRUD
 * routes it inherits through the `shared` barrel.
 */
@Controller('sessions')
export default class extends CrudController<Session> {
  @Get('current')
  current(): Session {
    return { id: 'current' };
  }
}
