import { Controller } from '@nestjs/common';
import { ExportBase } from '../shared/export.base';

@Controller('exports')
export class ExportsController extends ExportBase {}
